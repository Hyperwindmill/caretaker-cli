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

import type { AgentConfig } from "../../types.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";
import { mcpToolsForServers } from "../../mcp/adapter.js";

const SKILL_TOOL_NAMES = ["list_skills", "read_skill"] as const;

export async function resolveAgentTools(agent: AgentConfig, registry: ToolRegistry): Promise<Tool[]> {
  const tools = registry.filtered(agent.allowedTools);

  if ((agent.plugins ?? []).length > 0) {
    const have = new Set(tools.map((t) => t.name));
    for (const name of SKILL_TOOL_NAMES) {
      if (have.has(name)) continue;
      const t = registry.get(name);
      if (t) tools.push(t);
    }
  }

  const mcpIds = agent.mcpServers ?? [];
  if (mcpIds.length > 0) {
    const mcp = await mcpToolsForServers(mcpIds);
    tools.push(...mcp);
  }

  return tools;
}
