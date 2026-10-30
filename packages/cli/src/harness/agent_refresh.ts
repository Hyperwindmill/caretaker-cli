// Shared in-place agent refresh for interactive chat surfaces (web, VSCode).
//
// When the config files change on disk, the selected agent is re-read and its
// provider is re-resolved by name — never carried over, or a provider switch
// pairs the new model with the old endpoint. `changed` tells the surface to
// drop its idle session controller, which captured agent/provider/tools at
// construction; the next turn rebuilds it and reloads history from disk.

import type { AgentConfig, ProviderConfig } from '../types.js';

export type AgentRefresh =
  | { ok: true; agent: AgentConfig; provider: ProviderConfig; toolsChanged: boolean; changed: boolean }
  | { ok: false; error: string };

export function refreshAgentRuntime(
  current: { agent: AgentConfig; provider: ProviderConfig | null },
  freshAgent: AgentConfig,
  providers: ProviderConfig[],
): AgentRefresh {
  const provider = providers.find((p) => p.name === freshAgent.provider);
  if (!provider) {
    return {
      ok: false,
      error: `Provider "${freshAgent.provider}" for agent "${freshAgent.name}" is missing from caretaker.json.`,
    };
  }
  const prev = current.agent;
  const toolsChanged =
    freshAgent.allowedTools.join('|') !== prev.allowedTools.join('|') ||
    (freshAgent.plugins ?? []).join('|') !== (prev.plugins ?? []).join('|') ||
    (freshAgent.mcpServers ?? []).join('|') !== (prev.mcpServers ?? []).join('|');
  const changed =
    JSON.stringify(freshAgent) !== JSON.stringify(prev) ||
    JSON.stringify(provider) !== JSON.stringify(current.provider);
  return { ok: true, agent: { ...freshAgent }, provider, toolsChanged, changed };
}
