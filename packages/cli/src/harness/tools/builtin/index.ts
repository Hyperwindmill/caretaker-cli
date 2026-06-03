// Built-in (in-process, native) tools shipped with the app. New native
// tools are added here. The future MCP adapter will register additional
// tools alongside these via a separate entry point.

import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read_file.js';
import { readDocumentTool } from './read_document.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { multieditTool } from './multiedit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { fetchTool } from './fetch.js';
import { bashTool } from './bash.js';
import { listSkillsTool } from './list_skills.js';
import { readSkillTool } from './read_skill.js';
import { listAgentsTool } from './list_agents.js';
import { invokeAgentTool } from './invoke_agent.js';
import { listCommandsTool } from './list_commands.js';
import { invokeCommandTool } from './invoke_command.js';
import { getAgentContextTool } from './get_agent_context.js';
import {
  getTaskStateTool,
  updateChecklistItemTool,
  updateChecklistTool,
  addMessageTool,
  completeTaskTool,
  blockTaskTool,
  yieldTaskTool,
  projectListTool,
  taskCreateTool,
  taskSearchTool,
  taskUnblockTool,
  taskActivateTool,
  taskUnpauseTool,
} from './task_tools.js';

export function registerBuiltins(registry: ToolRegistry): void {
  // Filesystem (sandboxed to ctx.workingDir).
  registry.register(readFileTool);
  registry.register(readDocumentTool);
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
  // Slash commands as tools — same gating as skills (auto-included when
  // the agent has at least one plugin active).
  registry.register(listCommandsTool);
  registry.register(invokeCommandTool);
  // Self-introspection (always present — the agent should be able to ask
  // "how much context am I using" without prerequisites).
  registry.register(getAgentContextTool);

  // Autonomous task tools.
  registry.register(getTaskStateTool);
  registry.register(updateChecklistItemTool);
  registry.register(updateChecklistTool);
  registry.register(addMessageTool);
  registry.register(completeTaskTool);
  registry.register(blockTaskTool);
  registry.register(yieldTaskTool);
  registry.register(projectListTool);
  registry.register(taskCreateTool);
  registry.register(taskSearchTool);
  registry.register(taskUnblockTool);
  registry.register(taskActivateTool);
  registry.register(taskUnpauseTool);
}

export {
  readFileTool,
  readDocumentTool,
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
  listCommandsTool,
  invokeCommandTool,
  getAgentContextTool,
  getTaskStateTool,
  updateChecklistItemTool,
  updateChecklistTool,
  addMessageTool,
  completeTaskTool,
  blockTaskTool,
  yieldTaskTool,
  projectListTool,
  taskCreateTool,
  taskSearchTool,
  taskUnblockTool,
  taskActivateTool,
  taskUnpauseTool,
};
