// `caretaker-cli mcp` — serve the built-in mcp__task__* / mcp__email__* tools
// over stdio so an external MCP client (e.g. Claude Code) can steer caretaker's
// task/project system symmetrically and send mail through a configured account. No auth: the trust boundary is local process access to
// CARETAKER_HOME (the caller could edit the folder DB directly). stdout carries
// the JSON-RPC wire — never write anything else to it here.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildBuiltinMcpServer } from '../mcp/builtin_server.js';

export async function startMcpStdioServer(): Promise<void> {
  const server = buildBuiltinMcpServer({ name: 'caretaker', version: '0.0.0' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the client closes stdin. Resolve on transport close so
  // the caller can let the process exit cleanly.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
