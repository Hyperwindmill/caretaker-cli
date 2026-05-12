// Source manager: orchestrates fetch + discover + persist for plugin
// sources. Ports the server's src/plugins/source_manager.ts adapted to the
// app's file-store: instead of DB transactions, every write reads
// plugins.json, mutates the in-memory shape, and writes back via savePlugins
// (which is atomic at the file level).
//
// Concurrency model: refreshSource() dedupes concurrent calls for the same
// source id via an inFlight map (matches the server). The app is
// single-process single-user TUI, so we don't lock the file across the
// whole pipeline — sequential CRUD is fine.

import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadPlugins, savePlugins } from '../store/json.js';
import { encrypt } from '../lib/encryption.js';
import { syncManagedMcpServers } from '../mcp/server_manager.js';
import { syncManagedAgents } from '../agents/sync.js';
import {
  discoverPlugins,
  discoverPluginMcpServers,
  discoverPluginAgents,
  discoverPluginCommands,
  discoverPluginSkills,
} from './manifest.js';
import { fetchGit } from './fetchers/git.js';
import { fetchPath, validatePathInput } from './fetchers/path.js';
import type { DiscoveredPlugin } from './types.js';
import type { PluginRecord, PluginSource } from '../types.js';

export interface CreateSourceInput {
  kind: 'git' | 'path';
  url: string;
  ref?: string | null;
  authToken?: string | null;
  refreshOnStart?: boolean;
}

export interface PatchSourceInput {
  url?: string;
  ref?: string | null;
  authToken?: string | null;
  refreshOnStart?: boolean;
}

export interface RefreshOutcome {
  pluginsFound: number;
  sha: string | null;
  error: string | null;
}

const inFlight = new Map<string, Promise<RefreshOutcome>>();

function pluginCacheRoot(): string {
  return process.env.PLUGIN_CACHE_DIR ?? path.join(os.homedir(), '.caretaker', 'plugin-cache');
}

function cacheDirForSource(id: string): string {
  return path.join(pluginCacheRoot(), id);
}

export async function createSource(input: CreateSourceInput): Promise<PluginSource> {
  if (input.kind === 'path') validatePathInput(input.url);
  const file = await loadPlugins();
  const source: PluginSource = {
    id: randomUUID(),
    kind: input.kind,
    url: input.url,
    ref: input.kind === 'git' ? (input.ref ?? null) : null,
    authToken: input.kind === 'git' && input.authToken ? encrypt(input.authToken) : null,
    refreshOnStart: input.refreshOnStart ?? false,
    lastFetchedAt: null,
    lastFetchError: null,
    lastFetchSha: null,
  };
  file.sources.push(source);
  await savePlugins(file);
  return source;
}

export async function deleteSource(id: string): Promise<boolean> {
  const file = await loadPlugins();
  const idx = file.sources.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  const [src] = file.sources.splice(idx, 1);
  file.plugins = file.plugins.filter((p) => p.sourceId !== id);
  await savePlugins(file);
  // Cascade: managed MCP rows + agents whose owning plugin disappeared.
  await syncManagedMcpServers();
  await syncManagedAgents();
  if (src.kind === 'git') {
    await rm(cacheDirForSource(id), { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

export async function listSources(): Promise<PluginSource[]> {
  const file = await loadPlugins();
  return file.sources;
}

export async function getSource(id: string): Promise<PluginSource | null> {
  const file = await loadPlugins();
  return file.sources.find((s) => s.id === id) ?? null;
}

export async function listPlugins(): Promise<PluginRecord[]> {
  const file = await loadPlugins();
  return file.plugins;
}

export async function patchSource(
  id: string,
  input: PatchSourceInput,
): Promise<PluginSource | null> {
  const file = await loadPlugins();
  const src = file.sources.find((s) => s.id === id);
  if (!src) return null;
  if (input.url !== undefined) {
    if (src.kind === 'path') validatePathInput(input.url);
    src.url = input.url;
  }
  if (input.ref !== undefined) src.ref = input.ref;
  if (input.authToken !== undefined) {
    src.authToken = input.authToken === null ? null : encrypt(input.authToken);
  }
  if (input.refreshOnStart !== undefined) src.refreshOnStart = input.refreshOnStart;
  await savePlugins(file);
  return src;
}

async function runRefresh(id: string): Promise<RefreshOutcome> {
  const initialFile = await loadPlugins();
  const src = initialFile.sources.find((s) => s.id === id);
  if (!src) throw new Error(`Plugin source ${id} not found`);

  let discovered: DiscoveredPlugin[];
  let sha: string | null;
  try {
    const fetched =
      src.kind === 'git'
        ? await fetchGit(
            { url: src.url, ref: src.ref ?? null, authToken: src.authToken ?? null },
            cacheDirForSource(id),
          )
        : await fetchPath(src.url);
    sha = fetched.sha;
    discovered = await discoverPlugins(fetched.root);

    // Second pass: each discovered plugin may declare MCP servers in
    // `<plugin-root>/.mcp.json` (the official Claude Code convention — the
    // file is a sibling of `.claude-plugin/`, not a field of plugin.json).
    // We attach the parsed specs to the DiscoveredPlugin so the persistence
    // step below carries them through, and the subsequent
    // syncManagedMcpServers() call materializes one McpServerConfig per
    // declared server.
    for (const d of discovered) {
      const pluginRoot = path.join(fetched.root, d.relPath);
      const mcpServers = await discoverPluginMcpServers(pluginRoot);
      if (mcpServers) d.mcpServers = mcpServers;
      const agents = await discoverPluginAgents(pluginRoot);
      if (agents) d.agents = agents;
      const commands = await discoverPluginCommands(pluginRoot);
      if (commands) d.commands = commands;
      const skills = await discoverPluginSkills(pluginRoot, d.manifestKind, d.name);
      if (skills) d.skills = skills;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Persist the failure on the source row, leave plugins from the previous
    // successful refresh intact (matches the server: an outage shouldn't
    // wipe activated skills).
    const failureFile = await loadPlugins();
    const failSrc = failureFile.sources.find((s) => s.id === id);
    if (failSrc) {
      failSrc.lastFetchError = msg;
      failSrc.lastFetchedAt = new Date().toISOString();
      await savePlugins(failureFile);
    }
    return { pluginsFound: 0, sha: null, error: msg };
  }

  // Successful refresh: replace this source's plugins atomically (read
  // latest state to avoid stomping on parallel mutations to other sources).
  const latest = await loadPlugins();
  const ourSrc = latest.sources.find((s) => s.id === id);
  if (!ourSrc) {
    // Source was deleted between the start of refresh and now; bail without
    // leaving orphans.
    return { pluginsFound: 0, sha, error: 'source deleted during refresh' };
  }
  // Preserve PluginRecord.id across refreshes so downstream references
  // (managed MCP rows' pluginId, managed agents' pluginId, and any agent
  // that wires those managed rows by id) survive a re-sync. Without this,
  // every refresh would assign a fresh UUID, syncManagedMcpServers /
  // syncManagedAgents would drop the old rows + create new ones, and
  // pruneAgentMcpRefs / the agent-sync equivalent would silently strip
  // those refs from every agent that had them wired.
  const previousIdByName = new Map<string, string>();
  for (const p of latest.plugins) {
    if (p.sourceId === id) previousIdByName.set(p.name, p.id);
  }
  latest.plugins = latest.plugins.filter((p) => p.sourceId !== id);
  for (const d of discovered) {
    latest.plugins.push({
      id: previousIdByName.get(d.name) ?? randomUUID(),
      sourceId: id,
      name: d.name,
      description: d.description,
      manifestKind: d.manifestKind,
      relPath: d.relPath,
      rawManifest: d.rawManifest,
      ...(d.mcpServers ? { mcpServers: d.mcpServers } : {}),
      ...(d.agents ? { agents: d.agents } : {}),
      ...(d.commands ? { commands: d.commands } : {}),
      ...(d.skills ? { skills: d.skills } : {}),
    });
  }
  ourSrc.lastFetchedAt = new Date().toISOString();
  ourSrc.lastFetchError = null;
  ourSrc.lastFetchSha = sha;
  await savePlugins(latest);

  // Reconcile mcp.json so newly-declared `mcpServers` entries become managed
  // rows and stale ones disappear. Best-effort: a sync failure should not
  // turn a successful refresh into a failure — the user can re-trigger.
  try {
    await syncManagedMcpServers();
  } catch (err) {
    console.error(`[source manager] mcp sync after refresh failed:`, err);
  }
  try {
    await syncManagedAgents();
  } catch (err) {
    console.error(`[source manager] agents sync after refresh failed:`, err);
  }

  return { pluginsFound: discovered.length, sha, error: null };
}

export function refreshSource(id: string): Promise<RefreshOutcome> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const promise = runRefresh(id).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}
