// CRUD for mcp.json. Mirrors src/plugins/source_manager.ts in shape so the
// TUI patterns map 1:1. Header values that look like plaintext are encrypted
// at create/patch time (encrypted blobs are passed through unchanged), so a
// hand-edited mcp.json with a raw token gets cleaned up on the next save.

import { randomUUID } from 'node:crypto';
import { encrypt, isEncrypted } from '../lib/encryption.js';
import { loadMcpServers, loadPlugins, saveMcpServers } from '../store/json.js';
import { closeClient } from './client.js';
import type { McpServerConfig, McpServerSpec, McpTransport, PluginRecord } from '../types.js';

export interface CreateMcpServerInput {
  name: string;
  transport: McpTransport;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface PatchMcpServerInput {
  name?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Pass the full headers map; values not yet encrypted will be encrypted
   *  on save. Pass `null` to clear all headers. */
  headers?: Record<string, string> | null;
}

function encryptHeaderValues(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isEncrypted(v) ? v : encrypt(v);
  }
  return out;
}

function validateInput(
  input: CreateMcpServerInput | (PatchMcpServerInput & { transport: McpTransport }),
): void {
  if (input.transport === 'stdio') {
    if ('command' in input && input.command !== undefined && input.command.trim() === '') {
      throw new Error('stdio MCP server requires a non-empty command');
    }
  }
  if (input.transport === 'http') {
    if ('url' in input && input.url !== undefined && input.url.trim() !== '') {
      try {
        new URL(input.url);
      } catch {
        throw new Error(`http MCP server requires a valid URL (got "${input.url}")`);
      }
    }
  }
}

export async function createMcpServer(input: CreateMcpServerInput): Promise<McpServerConfig> {
  validateInput(input);
  if (input.transport === 'stdio' && !input.command?.trim()) {
    throw new Error('stdio MCP server requires a command');
  }
  if (input.transport === 'http' && !input.url?.trim()) {
    throw new Error('http MCP server requires a url');
  }

  const file = await loadMcpServers();
  const server: McpServerConfig = {
    id: randomUUID(),
    name: input.name.trim(),
    transport: input.transport,
    enabled: input.enabled ?? true,
    command: input.transport === 'stdio' ? input.command : undefined,
    args: input.transport === 'stdio' ? (input.args ?? []) : undefined,
    env: input.transport === 'stdio' ? input.env : undefined,
    url: input.transport === 'http' ? input.url : undefined,
    headers: input.transport === 'http' ? encryptHeaderValues(input.headers) : undefined,
    lastConnectedAt: null,
    lastConnectError: null,
  };
  file.servers.push(server);
  await saveMcpServers(file);
  return server;
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const file = await loadMcpServers();
  const idx = file.servers.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  file.servers.splice(idx, 1);
  await saveMcpServers(file);
  // Drop any pooled connection for this server so subsequent runs don't keep
  // talking to a config that no longer exists.
  await closeClient(id);
  return true;
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const file = await loadMcpServers();
  return file.servers;
}

export async function getMcpServer(id: string): Promise<McpServerConfig | null> {
  const file = await loadMcpServers();
  return file.servers.find((s) => s.id === id) ?? null;
}

export async function patchMcpServer(
  id: string,
  input: PatchMcpServerInput,
): Promise<McpServerConfig | null> {
  const file = await loadMcpServers();
  const srv = file.servers.find((s) => s.id === id);
  if (!srv) return null;

  validateInput({ ...input, transport: srv.transport });

  // Plugin-managed rows: only `enabled` is mutable. Everything else is the
  // plugin manifest's responsibility and would be overwritten on next sync.
  if (srv.pluginId) {
    if (input.enabled !== undefined) {
      srv.enabled = input.enabled;
      await saveMcpServers(file);
      await closeClient(id);
    }
    return srv;
  }

  if (input.name !== undefined) srv.name = input.name.trim();
  if (input.enabled !== undefined) srv.enabled = input.enabled;

  if (srv.transport === 'stdio') {
    if (input.command !== undefined) srv.command = input.command;
    if (input.args !== undefined) srv.args = input.args;
    if (input.env !== undefined) srv.env = input.env;
  } else {
    if (input.url !== undefined) srv.url = input.url;
    if (input.headers !== undefined) {
      srv.headers = input.headers === null ? undefined : encryptHeaderValues(input.headers);
    }
  }

  await saveMcpServers(file);
  await closeClient(id);
  return srv;
}

// ─── Plugin-managed sync ─────────────────────────────────────────────────

function specTransport(spec: McpServerSpec): McpTransport {
  return 'command' in spec ? 'stdio' : 'http';
}

function managedRowKey(pluginId: string, scopedName: string): string {
  return `${pluginId}::${scopedName}`;
}

function buildManagedRow(
  plugin: PluginRecord,
  scopedName: string,
  spec: McpServerSpec,
): McpServerConfig {
  const transport = specTransport(spec);
  return {
    id: randomUUID(),
    name: `${plugin.name}/${scopedName}`,
    transport,
    enabled: true,
    pluginId: plugin.id,
    pluginScopedName: scopedName,
    lastConnectedAt: null,
    lastConnectError: null,
    ...(transport === 'stdio'
      ? {
          command: (spec as { command: string }).command,
          args: (spec as { args?: string[] }).args ?? [],
          env: (spec as { env?: Record<string, string> }).env,
        }
      : {
          url: (spec as { url: string }).url,
          headers: encryptHeaderValues((spec as { headers?: Record<string, string> }).headers),
        }),
  };
}

function applySpecToManagedRow(
  existing: McpServerConfig,
  plugin: PluginRecord,
  scopedName: string,
  spec: McpServerSpec,
): McpServerConfig {
  // Preserve user-controllable bits (`enabled`, `lastConnectedAt`,
  // `lastConnectError`); refresh everything else from the manifest.
  const transport = specTransport(spec);
  return {
    ...existing,
    name: `${plugin.name}/${scopedName}`,
    transport,
    pluginId: plugin.id,
    pluginScopedName: scopedName,
    command: transport === 'stdio' ? (spec as { command: string }).command : undefined,
    args: transport === 'stdio' ? ((spec as { args?: string[] }).args ?? []) : undefined,
    env: transport === 'stdio' ? (spec as { env?: Record<string, string> }).env : undefined,
    url: transport === 'http' ? (spec as { url: string }).url : undefined,
    headers:
      transport === 'http'
        ? encryptHeaderValues((spec as { headers?: Record<string, string> }).headers)
        : undefined,
  };
}

/**
 * Reconcile mcp.json with plugins.json. For every plugin with an
 * `mcpServers` manifest entry, ensure a corresponding managed row exists in
 * mcp.json (created if missing, refreshed in place if present). Managed rows
 * whose source plugin or manifest entry has disappeared are removed and
 * their pooled connection (if any) is closed.
 *
 * User-authored rows (no `pluginId`) are never touched. Idempotent: calling
 * twice with no plugin changes leaves the file in the same shape.
 */
export async function syncManagedMcpServers(): Promise<void> {
  const pluginsFile = await loadPlugins();
  const mcpFile = await loadMcpServers();

  // Build the set of expected (pluginId, scopedName) → (plugin, spec).
  const expected = new Map<
    string,
    { plugin: PluginRecord; scopedName: string; spec: McpServerSpec }
  >();
  for (const plugin of pluginsFile.plugins) {
    if (!plugin.mcpServers) continue;
    for (const [scopedName, spec] of Object.entries(plugin.mcpServers)) {
      expected.set(managedRowKey(plugin.id, scopedName), { plugin, scopedName, spec });
    }
  }

  const out: McpServerConfig[] = [];
  const seenKeys = new Set<string>();
  const droppedIds: string[] = [];

  for (const srv of mcpFile.servers) {
    if (!srv.pluginId) {
      out.push(srv); // user-authored, leave alone
      continue;
    }
    const key = managedRowKey(srv.pluginId, srv.pluginScopedName ?? '');
    const exp = expected.get(key);
    if (!exp) {
      droppedIds.push(srv.id);
      continue;
    }
    seenKeys.add(key);
    out.push(applySpecToManagedRow(srv, exp.plugin, exp.scopedName, exp.spec));
  }

  for (const [key, exp] of expected) {
    if (seenKeys.has(key)) continue;
    out.push(buildManagedRow(exp.plugin, exp.scopedName, exp.spec));
  }

  await saveMcpServers({ servers: out });

  // Drop pooled connections for removed rows so the runtime stops talking
  // to a config that no longer exists.
  for (const id of droppedIds) {
    await closeClient(id);
  }
}
