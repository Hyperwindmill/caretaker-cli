// Shared builder: wraps the built-in `mcp__<ns>__*` registry tools as an MCP
// Server. Used by BOTH the per-task HTTP bridge (cli/web/mcp_bridge.ts) and the
// general stdio subcommand (cli/mcp.ts) so this surface has one definition and
// one wrapping. Three namespaces today — `task` (drive the autonomous task state
// machine), `email` (send mail through a configured account), and `memory`
// (read stored memories, bumping recall accounting); a new tool in either is
// picked up by both consumers through the prefix filter, never a second allowlist.
//
// The tools are context-free (they take task_id / account by argument), so a
// stub ToolContext is sufficient — except for the caller's identity, which the
// email tools use to scope which accounts exist for this agent. The HTTP bridge
// passes it (resolved from the per-run token); the stdio server does not have
// one and is unscoped by design, its trust boundary being local process access
// to CARETAKER_HOME.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as registry } from '../harness/tools/instance.js';
import type { Tool, ToolContext } from '../harness/tools/index.js';
import type { AgentConfig } from '../types.js';

export const TASK_PREFIX = 'mcp__task__';
export const EMAIL_PREFIX = 'mcp__email__';
export const MEMORY_PREFIX = 'mcp__memory__';
const SERVED_PREFIXES = [TASK_PREFIX, EMAIL_PREFIX, MEMORY_PREFIX];

/** `mcp__task__task_complete` → `task_complete`, `mcp__email__email_send` → `email_send`. */
function externalName(name: string): string {
  return name.replace(/^mcp__[a-z]+__/, '');
}

export function builtinMcpTools(): Tool[] {
  return registry.list().filter((t) => SERVED_PREFIXES.some((p) => t.name.startsWith(p)));
}

export function buildBuiltinMcpServer(
  info: { name: string; version: string } = { name: 'caretaker-task', version: '0.0.0' },
  opts: { callerAgent?: AgentConfig } = {},
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
    // ponytail: the task tools ignore ctx entirely; the email tools read only
    // callerAgent. A stub covers the rest.
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      readPaths: new Set(),
      callerAgent: opts.callerAgent,
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
