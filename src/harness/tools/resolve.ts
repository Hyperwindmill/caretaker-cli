// Resolve the Tool[] visible to a single run, given the agent config and
// the process-wide registry. Two effects layered on top of the raw
// allowedTools filter:
//   - When the agent has at least one active plugin, the skill access tools
//     (`list_skills` / `read_skill`) are auto-included so the user never has
//     to add them to allowedTools manually.
//
// Future MCP-adapted tools registered into the same registry are filtered by
// allowedTools like any other — no special case here.

import type { AgentConfig } from "../../types.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

const SKILL_TOOL_NAMES = ["list_skills", "read_skill"] as const;

export function resolveAgentTools(agent: AgentConfig, registry: ToolRegistry): Tool[] {
  const tools = registry.filtered(agent.allowedTools);

  if ((agent.plugins ?? []).length > 0) {
    const have = new Set(tools.map((t) => t.name));
    for (const name of SKILL_TOOL_NAMES) {
      if (have.has(name)) continue;
      const t = registry.get(name);
      if (t) tools.push(t);
    }
  }

  return tools;
}
