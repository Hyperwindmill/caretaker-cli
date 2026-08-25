import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-taskserver-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildBuiltinMcpServer } from './builtin_server.js';
// instance.ts registers builtins as a load-time side effect.
import '../harness/tools/instance.js';

async function connected() {
  const server = buildBuiltinMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return { mcp, server };
}

test('lists task tools un-prefixed', async () => {
  const { mcp } = await connected();
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('task_get_state'));
  assert.ok(names.includes('task_complete'));
  assert.ok(names.includes('task_submit_plan'));
  assert.ok(names.every((n) => !n.startsWith('mcp__')));
  await mcp.close();
});

test('serves the email namespace too, un-prefixed and callable', async () => {
  const { mcp } = await connected();
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('email_list_accounts'));
  assert.ok(names.includes('email_send'));

  const res = await mcp.callTool({ name: 'email_list_accounts', arguments: {} });
  const text = (res.content as any[]).find((c) => c.type === 'text')?.text;
  assert.deepEqual(JSON.parse(text), { accounts: [] });
  await mcp.close();
});

test('calls a task tool end-to-end on an empty store', async () => {
  const { mcp } = await connected();
  const res = await mcp.callTool({ name: 'project_list', arguments: {} });
  const textBlock = (res.content as any[]).find((c) => c.type === 'text');
  assert.ok(typeof textBlock?.text === 'string');
  await mcp.close();
});

test('unknown tool returns isError', async () => {
  const { mcp } = await connected();
  const res = await mcp.callTool({ name: 'does_not_exist', arguments: {} });
  assert.equal(res.isError, true);
  await mcp.close();
});

test('opts.tools overrides the served list', async () => {
  const customTool = {
    name: 'mcp__task__run_command',
    description: 'run custom cmd',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async () => ({ content: 'custom ok' }),
  };
  const server = buildBuiltinMcpServer(undefined, { tools: [customTool] });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  const tools = await mcp.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name), ['run_command']);
  const res = await mcp.callTool({ name: 'run_command', arguments: { command: 'ls' } });
  assert.deepEqual(res.content, [{ type: 'text', text: 'custom ok' }]);
  await mcp.close();
});
