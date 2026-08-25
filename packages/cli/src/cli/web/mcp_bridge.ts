// Exposes the built-in mcp__task__* / mcp__email__* tools as a streamable-HTTP
// MCP endpoint so claude-code agents can drive the task state machine (and send
// mail through a configured account). Token-guarded:
// the task heartbeat issues a per-run bearer token and revokes it after.
// Stateless MCP (no session): a fresh Server per request. The task tools
// are context-free (they take task_id as an argument), so no per-run
// injection is needed.
//
// The token also carries WHO the run belongs to: the email tools scope which
// accounts an agent may see (ServiceConfig.allowedAgents), and a claude-code
// agent has no other way to identify itself — it speaks MCP over HTTP, not the
// in-process ToolContext. Without this the whole per-agent boundary would be
// bypassed on exactly the surface that matters most, the autonomous task run.

import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildBuiltinMcpServer, builtinMcpTools } from '../../mcp/builtin_server.js';
import { makeRunCommandTool } from '../../mcp/run_command_tool.js';
import { loadAgents } from '../../store/json.js';

type TokenInfo = {
  agentId: string;
  /** When set, a run_command tool bound to this container is served. */
  exec?: { container: string; workdir: string };
  /** Serve ONLY run_command (review runs: shell yes, task-state tools no). */
  execOnly?: boolean;
};
/** token → token info (agent id, exec binding, exec-only mode). */
const activeTokens = new Map<string, TokenInfo>();

export function issueBridgeToken(
  agentId = '',
  opts: { exec?: { container: string; workdir: string }; execOnly?: boolean } = {},
): string {
  const token = randomBytes(24).toString('hex');
  activeTokens.set(token, { agentId, exec: opts.exec, execOnly: opts.execOnly });
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

export function registerTaskBridge(app: Hono): void {
  app.post('/api/mcp/task', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token || !activeTokens.has(token)) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null);
    // Resolve the run's agent so ctx.callerAgent is set for the tools that scope
    // by it. A token issued without an agent id (or pointing at a since-deleted
    // agent) leaves it unset, which the email tools treat as an unscoped caller.
    const tokenInfo = activeTokens.get(token)!;
    const agentId = tokenInfo.agentId;
    const callerAgent = agentId
      ? (await loadAgents().catch(() => [])).find((a) => a.id === agentId)
      : undefined;
    const extraTools = tokenInfo.exec ? [makeRunCommandTool(tokenInfo.exec)] : [];
    const tools = tokenInfo.execOnly ? extraTools : [...builtinMcpTools(), ...extraTools];
    const server = buildBuiltinMcpServer(undefined, { callerAgent, tools });
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
