// Resolve the Tool[] visible to a single run, given the agent config and
// the process-wide registry. Three layers on top of allowedTools:
//   - When the agent has at least one active plugin, the skill access tools
//     (`list_skills` / `read_skill`) are auto-included so the user never has
//     to add them to allowedTools manually.
//   - When the agent references MCP servers, their tools/list output is
//     fetched via the adapter and appended (names already namespaced as
//     `mcp__<id>__<toolName>`, so no collision risk with builtins).
//
// MCP tools are NOT registered into the process-wide registry: we resolve
// them per-run because the remote tool list can change between runs and we
// don't want stale entries cluttering autocomplete or test fixtures.

import type { AgentConfig } from '../../types.js';
import type { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';
import { mcpToolsForServers } from '../../mcp/adapter.js';
import { loadAgents } from '../../store/json.js';

const SKILL_TOOL_NAMES = ['list_skills', 'read_skill'] as const;
const COMMAND_TOOL_NAMES = ['list_commands', 'invoke_command'] as const;
const DISPATCH_TOOL_NAMES = ['list_agents', 'invoke_agent'] as const;
const ALWAYS_ON_TOOL_NAMES = ['get_agent_context'] as const;

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

  // Self-introspection is always available — every agent can ask "how
  // much context am I using" without the user having to remember to add
  // get_agent_context to allowedTools.
  autoInclude(tools, registry, ALWAYS_ON_TOOL_NAMES);

  if ((agent.plugins ?? []).length > 0) {
    autoInclude(tools, registry, SKILL_TOOL_NAMES);
    autoInclude(tools, registry, COMMAND_TOOL_NAMES);
  }

  // Sub-agent dispatch tools: auto-included when there is at least one
  // OTHER agent configured (besides the caller). Listing yourself isn't
  // useful, and dispatching only-you is blocked anyway by the
  // self-invocation guard. The lookup is best-effort — a load failure
  // simply leaves the dispatch tools out, the agent still runs.
  try {
    const allAgents = await loadAgents();
    if (allAgents.some((a) => a.id !== agent.id)) {
      autoInclude(tools, registry, DISPATCH_TOOL_NAMES);
    }
  } catch {
    /* leave dispatch tools out on read error */
  }

  const mcpIds = agent.mcpServers ?? [];
  if (mcpIds.length > 0) {
    const mcp = await mcpToolsForServers(mcpIds);
    tools.push(...mcp);
  }

  return tools;
}
