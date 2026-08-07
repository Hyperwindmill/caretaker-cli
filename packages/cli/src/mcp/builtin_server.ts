// Shared builder: wraps the built-in `mcp__<ns>__*` registry tools as an MCP
// Server. Used by BOTH the per-task HTTP bridge (cli/web/mcp_bridge.ts) and the
// general stdio subcommand (cli/mcp.ts) so this surface has one definition and
// one wrapping. Two namespaces today — `task` (drive the autonomous task state
// machine) and `email` (send mail through a configured account); a new tool in
// either is picked up by both consumers through the prefix filter, never a
// second allowlist.
//
// The tools are context-free (they take task_id / account by argument), so a
// stub ToolContext is sufficient.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as registry } from '../harness/tools/instance.js';
import type { Tool, ToolContext } from '../harness/tools/index.js';

export const TASK_PREFIX = 'mcp__task__';
export const EMAIL_PREFIX = 'mcp__email__';
const SERVED_PREFIXES = [TASK_PREFIX, EMAIL_PREFIX];

/** `mcp__task__task_complete` → `task_complete`, `mcp__email__email_send` → `email_send`. */
function externalName(name: string): string {
  return name.replace(/^mcp__[a-z]+__/, '');
}

export function builtinMcpTools(): Tool[] {
  return registry.list().filter((t) => SERVED_PREFIXES.some((p) => t.name.startsWith(p)));
}

export function buildBuiltinMcpServer(
  info: { name: string; version: string } = { name: 'caretaker-task', version: '0.0.0' },
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: builtinMcpTools().map((t) => ({
      name: externalName(t.name),
      description: t.description,
      inputSchema: t.parameters as any,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = builtinMcpTools().find((t) => externalName(t.name) === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: unknown tool "${req.params.name}"` }],
        isError: true,
      };
    }
    // ponytail: these tools ignore ctx entirely; a stub keeps the types happy.
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
