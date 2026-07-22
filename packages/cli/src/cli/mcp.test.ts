import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '../index.ts'); // packages/cli/src/index.ts
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

// Spawns the real entry via tsx through StdioClientTransport under an isolated
// CARETAKER_HOME. This proves stdout hygiene (any stray write corrupts the
// JSON-RPC wire and this handshake would fail) and the full subcommand path.
test('caretaker-cli mcp serves task tools over stdio', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-cli-'));
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [TSX_CLI, ENTRY, 'mcp'],
    env: { ...process.env, CARETAKER_HOME: home },
  });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(transport);

  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('task_get_state'));
  assert.ok(names.every((n) => !n.startsWith('mcp__')));

  const res = await mcp.callTool({ name: 'project_list', arguments: {} });
  const textBlock = (res.content as any[]).find((c) => c.type === 'text');
  assert.ok(typeof textBlock?.text === 'string');

  await mcp.close();
});
