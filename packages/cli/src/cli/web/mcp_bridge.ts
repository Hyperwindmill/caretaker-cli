// Exposes the built-in mcp__task__* tools as a streamable-HTTP MCP endpoint
// so claude-code agents can drive the task state machine. Token-guarded:
// the task heartbeat issues a per-run bearer token and revokes it after.
// Stateless MCP (no session): a fresh Server per request. The task tools
// are context-free (they take task_id as an argument), so no per-run
// injection is needed.

import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as registry } from '../../harness/tools/instance.js';
import type { Tool, ToolContext } from '../../harness/tools/index.js';

const TASK_PREFIX = 'mcp__task__';
const activeTokens = new Set<string>();

export function issueBridgeToken(): string {
  const token = randomBytes(24).toString('hex');
  activeTokens.add(token);
  return token;
}
export function revokeBridgeToken(token: string): void {
  activeTokens.delete(token);
}

let bridgeUrl: string | null = null;
export function setTaskBridgeUrl(url: string): void {
  bridgeUrl = url;
}
export function getTaskBridgeUrl(): string | null {
  return bridgeUrl;
}

function taskTools(): Tool[] {
  return registry.list().filter((t) => t.name.startsWith(TASK_PREFIX));
}

function buildServer(): Server {
  const server = new Server(
    { name: 'caretaker-task', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
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

export function registerTaskBridge(app: Hono): void {
  app.post('/api/mcp/task', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token || !activeTokens.has(token)) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses, no SSE needed
    });
    await server.connect(transport);
    const { incoming, outgoing } = c.env as { incoming: any; outgoing: any };
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT as any;
  });
}
