// Move the current chat session into one of the configured projects.
//
// Session-bound on purpose: it needs ctx.sessionId to persist the override,
// which is why it is a plain builtin and not part of a served mcp__* namespace
// (those are context-free). The switch mutates ctx.workingDir in place, so
// file/shell tools later in the same turn already resolve against the new
// directory; the prelude (AGENTS.md, project memories) is built once per run
// and picks the project up from the next turn, when the web server's chat
// controller reads the override back from the session meta.
// See docs/superpowers/specs/2026-11-07-desktop-assistant-design.md

import { stat } from 'node:fs/promises';
import { loadConfig } from '../../../store/json.js';
import { updateSessionWorkspace } from '../../../session/store.js';
import { projectWorkingDir } from '../../../lib/task_git.js';
import type { Tool, ToolResult } from '../types.js';

export const setWorkspaceTool: Tool = {
  name: 'set_workspace',
  description:
    "Switch this chat session's working directory to one of the configured projects for the rest of the session, " +
    "or pass agent_default: true to go back to the agent's own working directory (use it when leaving a project). " +
    'Pass exactly one of project_id / agent_default. Call mcp__task__project_list first to get a project_id.',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Id of the project to switch to (from project_list).' },
      agent_default: {
        type: 'boolean',
        description: "true = return to this agent's own working directory (alternative to project_id).",
      },
    },
    required: [],
  },
  dangerous: true,
  execute: async (args, ctx): Promise<ToolResult> => {
    const agentId = ctx.callerAgent?.id;
    if (!ctx.sessionId || !agentId) {
      return { content: 'Error: no chat session to switch — set_workspace only works inside a saved chat session.' };
    }
    const a = args as { project_id?: unknown; agent_default?: unknown };
    const wantDefault = a.agent_default === true;
    const projectId = String(a.project_id ?? '');
    if (wantDefault === !!projectId) {
      return { content: 'Error: pass exactly one of project_id or agent_default: true.' };
    }
    if (wantDefault) {
      const own = ctx.callerAgent?.workingDir;
      if (!own) {
        return { content: "Error: this agent has no working directory of its own to return to." };
      }
      ctx.workingDir = own;
      await updateSessionWorkspace({ agentId, id: ctx.sessionId }, null);
      return {
        content:
          `Back to the agent's own working directory (${own}). File and shell tools already use it; ` +
          'project context files (AGENTS.md) and memories follow from the next turn.',
      };
    }
    const project = ((await loadConfig()).projects ?? []).find((p) => p.id === projectId);
    if (!project) {
      return { content: `Error: unknown project "${projectId}". Call mcp__task__project_list for the valid ids.` };
    }
    const dir = projectWorkingDir(project);
    const isDir = dir ? await stat(dir).then((s) => s.isDirectory(), () => false) : false;
    if (!isDir) {
      return { content: `Error: project "${project.name}" has no directory on disk (${dir || 'no working dir configured'}).` };
    }
    ctx.workingDir = dir;
    await updateSessionWorkspace({ agentId, id: ctx.sessionId }, { workingDir: dir, projectId: project.id });
    return {
      content:
        `Switched to project "${project.name}" (${dir}). File and shell tools already use it; ` +
        'project context files (AGENTS.md) and project memories apply from the next turn.',
    };
  },
};
