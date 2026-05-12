// Resolve the Tool[] visible to a single run, given the agent config and
// the process-wide registry. Layers on top of allowedTools:
//   - Always-on builtins: `get_agent_context` (live token usage),
//     `list_agents` + `invoke_agent` (sub-agent dispatch — anonymous mode
//     `invoke_agent({task})` is always valid regardless of how many agents
//     are configured, so the tools are always discoverable).
//   - Plugin-gated builtins: when the agent has at least one active
//     plugin, the skill (`list_skills`/`read_skill`) and command
//     (`list_commands`/`invoke_command`) access tools are added.
//   - MCP tools: when the agent references MCP servers, their tools/list
//     output is fetched via the adapter and appended (names already
//     namespaced as `mcp__<id>__<toolName>`).
//
// MCP tools are NOT registered into the process-wide registry: we resolve
// them per-run because the remote tool list can change between runs and we
// don't want stale entries cluttering autocomplete or test fixtures.

import type { AgentConfig } from '../../types.js';
import type { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';
import { mcpToolsForServers } from '../../mcp/adapter.js';

const SKILL_TOOL_NAMES = ['list_skills', 'read_skill'] as const;
const COMMAND_TOOL_NAMES = ['list_commands', 'invoke_command'] as const;
const ALWAYS_ON_TOOL_NAMES = [
  'get_agent_context',
  'list_agents',
  'invoke_agent',
] as const;

function autoInclude(tools: Tool[], registry: ToolRegistry, names: readonly string[]): void {
  const have = new Set(tools.map((t) => t.name));
  for (const name of names) {
    if (have.has(name)) continue;
    const t = registry.get(name);
    if (t) tools.push(t);
  }
}

export async function resolveAgentTools(
  agent: AgentConfig,
  registry: ToolRegistry,
): Promise<Tool[]> {
  const tools = registry.filtered(agent.allowedTools);

  autoInclude(tools, registry, ALWAYS_ON_TOOL_NAMES);

  if ((agent.plugins ?? []).length > 0) {
    autoInclude(tools, registry, SKILL_TOOL_NAMES);
    autoInclude(tools, registry, COMMAND_TOOL_NAMES);
  }

  const mcpIds = agent.mcpServers ?? [];
  if (mcpIds.length > 0) {
    const mcp = await mcpToolsForServers(mcpIds);
    tools.push(...mcp);
  }

  return tools;
}
