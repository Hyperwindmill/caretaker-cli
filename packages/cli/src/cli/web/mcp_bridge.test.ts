import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-bridge-'));

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerTaskBridge, issueBridgeToken, revokeBridgeToken } from './mcp_bridge.js';
import { saveAgents, saveConfig } from '../../store/json.js';
import type { AgentConfig, ServiceConfig } from '../../types.js';
// Note: instance.ts registers builtins as a load-time side effect, so no
// explicit registerBuiltins() call is needed here (it would throw "tool
// already registered").
import '../../harness/tools/instance.js';

let server: ReturnType<typeof serve>;
let baseUrl: string;

before(async () => {
  const app = new Hono();
  registerTaskBridge(app);
  server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${(address as any).port}`;
});
after(() => server.close());

function client(token: string) {
  return {
    transport: new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp/task`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
    mcp: new Client({ name: 'test', version: '0.0.0' }),
  };
}

test('rejects missing/invalid token', async () => {
  const { transport, mcp } = client('nope');
  await assert.rejects(() => mcp.connect(transport));
});

test('lists task tools without the mcp__task__ prefix', async () => {
  const token = issueBridgeToken();
  const { transport, mcp } = client(token);
  await mcp.connect(transport);
  const { tools: listed } = await mcp.listTools();
  const names = listed.map((t) => t.name);
  assert.ok(names.includes('task_get_state'));
  assert.ok(names.includes('task_complete'));
  assert.ok(names.includes('task_submit_plan'));
  assert.ok(names.every((n) => !n.startsWith('mcp__')));
  await mcp.close();
  revokeBridgeToken(token);
});

test('calls a task tool end-to-end', async () => {
  const token = issueBridgeToken();
  const { transport, mcp } = client(token);
  await mcp.connect(transport);
  // project_list works on an empty store and proves execute() plumbs through
  const res = await mcp.callTool({ name: 'project_list', arguments: {} });
  const textBlock = (res.content as any[]).find((c) => c.type === 'text');
  assert.ok(typeof textBlock?.text === 'string');
  await mcp.close();
  revokeBridgeToken(token);
});

test('revoked token is rejected', async () => {
  const token = issueBridgeToken();
  revokeBridgeToken(token);
  const { transport, mcp } = client(token);
  await assert.rejects(() => mcp.connect(transport));
});

test('the token identifies the run, so email accounts are scoped per agent', async () => {
  const agents: AgentConfig[] = [
    {
      id: 'agent_1',
      name: 'Mailer',
      provider: 'p',
      model: 'm',
      systemPrompt: '',
      allowedTools: [],
      maxTurns: 10,
    },
    {
      id: 'agent_2',
      name: 'Other',
      provider: 'p',
      model: 'm',
      systemPrompt: '',
      allowedTools: [],
      maxTurns: 10,
    },
  ];
  await saveAgents(agents);
  const account: ServiceConfig = {
    id: 'svc_1',
    name: 'Boss only',
    type: 'email',
    enabled: true,
    agentId: '',
    cron: '',
    prompt: '',
    imapHost: 'imap.example.com',
    imapUser: 'me@example.com',
    imapPassword: 'pw',
    smtpHost: 'smtp.example.com',
    allowedAgents: ['agent_1'],
  };
  await saveConfig({ port: 3000, providers: [], scheduler: { tasks: [account] } });

  const list = async (token: string) => {
    const { transport, mcp } = client(token);
    await mcp.connect(transport);
    const res = await mcp.callTool({ name: 'email_list_accounts', arguments: {} });
    const text = (res.content as any[]).find((c) => c.type === 'text')?.text;
    await mcp.close();
    revokeBridgeToken(token);
    return JSON.parse(text).accounts as unknown[];
  };

  assert.equal((await list(issueBridgeToken('agent_1'))).length, 1, 'owner sees its account');
  assert.equal((await list(issueBridgeToken('agent_2'))).length, 0, 'other agent sees nothing');
  // No agent id on the token (a caller that predates the scoping) is unscoped —
  // the documented trusted-caller behaviour, not an accident.
  assert.equal((await list(issueBridgeToken())).length, 1);
});
