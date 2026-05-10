// Built-in (in-process, native) tools shipped with the app. New native
// tools are added here. The future MCP adapter will register additional
// tools alongside these via a separate entry point.

import type { ToolRegistry } from "../registry.js";
import { readFileTool } from "./read_file.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { multieditTool } from "./multiedit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { fetchTool } from "./fetch.js";
import { bashTool } from "./bash.js";
import { listSkillsTool } from "./list_skills.js";
import { readSkillTool } from "./read_skill.js";
import { listAgentsTool } from "./list_agents.js";
import { invokeAgentTool } from "./invoke_agent.js";

export function registerBuiltins(registry: ToolRegistry): void {
  // Filesystem (sandboxed to ctx.workingDir).
  registry.register(readFileTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(multieditTool);
  registry.register(globTool);
  registry.register(grepTool);
  // Network.
  registry.register(fetchTool);
  // Shell.
  registry.register(bashTool);
  // Plugin skills (auto-included by resolveAgentTools when an agent has
  // active plugins; not part of the agent's allowedTools surface).
  registry.register(listSkillsTool);
  registry.register(readSkillTool);
  // Sub-agent dispatch (auto-included by resolveAgentTools when there is
  // more than one agent configured — they're useless otherwise).
  registry.register(listAgentsTool);
  registry.register(invokeAgentTool);
}

export {
  readFileTool,
  writeTool,
  editTool,
  multieditTool,
  globTool,
  grepTool,
  fetchTool,
  bashTool,
  listSkillsTool,
  readSkillTool,
  listAgentsTool,
  invokeAgentTool,
};
