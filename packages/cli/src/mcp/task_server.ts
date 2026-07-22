// Shared builder: wraps the built-in mcp__task__* registry tools as an MCP
// Server. Used by BOTH the per-task HTTP bridge (cli/web/mcp_bridge.ts) and
// the general stdio subcommand (cli/mcp.ts) so the task surface has one
// definition and one wrapping. The task tools are context-free (they take
// task_id/project_id as arguments), so a stub ToolContext is sufficient.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as registry } from '../harness/tools/instance.js';
import type { Tool, ToolContext } from '../harness/tools/index.js';

export const TASK_PREFIX = 'mcp__task__';

export function taskTools(): Tool[] {
  return registry.list().filter((t) => t.name.startsWith(TASK_PREFIX));
}

export function buildTaskMcpServer(
  info: { name: string; version: string } = { name: 'caretaker-task', version: '0.0.0' },
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: taskTools().map((t) => ({
      name: t.name.slice(TASK_PREFIX.length),
      description: t.description,
      inputSchema: t.parameters as any,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = taskTools().find((t) => t.name === TASK_PREFIX + req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: unknown tool "${req.params.name}"` }],
        isError: true,
      };
    }
    // ponytail: task tools ignore ctx entirely; a stub keeps the types happy.
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      readPaths: new Set(),
    };
    try {
      const result = await tool.execute(req.params.arguments ?? {}, ctx);
      return { content: [{ type: 'text', text: result.content }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
        isError: true,
      };
    }
  });
  return server;
}
