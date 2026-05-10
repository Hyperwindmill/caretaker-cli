// Reconcile agents.json with plugin-declared agent specs. Mirrors
// src/mcp/server_manager.syncManagedMcpServers but for AgentConfig rows.
//
// Field policy across re-syncs:
//   - manifest-owned (rewritten every time): name, systemPrompt
//   - user-controlled (preserved across syncs): provider, model,
//     allowedTools, confirmTools, plugins, mcpServers, workingDir, maxTurns
//   - first-create only: provider defaults to the first configured provider,
//     model defaults to the frontmatter `model:` literal (or "")
//
// Frontmatter `tools:` is intentionally dropped — its vocabulary is
// Anthropic's tool surface, ours is a different namespace, and silent
// remapping would grant or deny tools incorrectly. The user wires
// allowedTools via the agent form after the row is materialized.

import { randomUUID } from "node:crypto";
import { loadAgents, loadConfig, loadPlugins, saveAgents } from "../store/json.js";
import type { AgentConfig, AgentSpec, PluginRecord } from "../types.js";

function managedRowKey(pluginId: string, scopedName: string): string {
  return `${pluginId}::${scopedName}`;
}

async function defaultProviderName(): Promise<string> {
  try {
    const cfg = await loadConfig();
    return cfg.providers[0]?.name ?? "";
  } catch {
    return "";
  }
}

function buildManagedAgent(
  plugin: PluginRecord,
  scopedName: string,
  spec: AgentSpec,
  defaultProvider: string,
): AgentConfig {
  return {
    id: randomUUID(),
    name: `${plugin.name}/${scopedName}`,
    systemPrompt: spec.systemPrompt,
    provider: defaultProvider,
    model: spec.model ?? "",
    allowedTools: [],
    maxTurns: 30,
    pluginId: plugin.id,
    pluginScopedName: scopedName,
  };
}

function applySpecToManagedAgent(
  existing: AgentConfig,
  plugin: PluginRecord,
  scopedName: string,
  spec: AgentSpec,
): AgentConfig {
  // Only the manifest-owned fields are rewritten. Everything the user can
  // touch via the form is left untouched.
  return {
    ...existing,
    name: `${plugin.name}/${scopedName}`,
    systemPrompt: spec.systemPrompt,
    pluginId: plugin.id,
    pluginScopedName: scopedName,
  };
}

/**
 * Reconcile agents.json with plugins.json. For every plugin with an
 * `agents` manifest entry, ensure a corresponding managed AgentConfig
 * exists (created if missing, refreshed in place if present). Managed rows
 * whose source plugin or manifest entry has disappeared are removed.
 *
 * User-authored agents (no `pluginId`) are never touched. Idempotent.
 */
export async function syncManagedAgents(): Promise<void> {
  const pluginsFile = await loadPlugins();
  const agents = await loadAgents();

  const expected = new Map<
    string,
    { plugin: PluginRecord; scopedName: string; spec: AgentSpec }
  >();
  for (const plugin of pluginsFile.plugins) {
    if (!plugin.agents) continue;
    for (const [scopedName, spec] of Object.entries(plugin.agents)) {
      expected.set(managedRowKey(plugin.id, scopedName), { plugin, scopedName, spec });
    }
  }

  const out: AgentConfig[] = [];
  const seen = new Set<string>();

  for (const a of agents) {
    if (!a.pluginId) {
      out.push(a); // user-authored, leave alone
      continue;
    }
    const key = managedRowKey(a.pluginId, a.pluginScopedName ?? "");
    const exp = expected.get(key);
    if (!exp) continue; // managed but no longer expected — drop
    seen.add(key);
    out.push(applySpecToManagedAgent(a, exp.plugin, exp.scopedName, exp.spec));
  }

  if (expected.size > seen.size) {
    const defaultProvider = await defaultProviderName();
    for (const [key, exp] of expected) {
      if (seen.has(key)) continue;
      out.push(buildManagedAgent(exp.plugin, exp.scopedName, exp.spec, defaultProvider));
    }
  }

  await saveAgents(out);
}
