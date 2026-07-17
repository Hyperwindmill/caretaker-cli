import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-mcprt-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt } from '../lib/encryption.js';
import { resolvedServerRuntime } from './client.js';
import type { McpServerConfig } from '../types.js';

test('stdio server resolves to plain command/args/env', async () => {
  const s: McpServerConfig = {
    id: 's1',
    name: 's1',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', 'some-server'],
    env: { FOO: 'bar' },
  };
  const r = await resolvedServerRuntime(s);
  assert.deepEqual(r, { type: 'stdio', command: 'npx', args: ['-y', 'some-server'], env: { FOO: 'bar' } });
});

test('http server decrypts headers', async () => {
  const s: McpServerConfig = {
    id: 's2',
    name: 's2',
    transport: 'http',
    enabled: true,
    url: 'https://example.com/mcp',
    headers: { Authorization: encrypt('Bearer sekret') },
  };
  const r = await resolvedServerRuntime(s);
  assert.equal(r?.type, 'http');
  assert.equal((r as any).headers.Authorization, 'Bearer sekret');
});

test('disabled server resolves to null', async () => {
  const s: McpServerConfig = { id: 's3', name: 's3', transport: 'stdio', enabled: false, command: 'x' };
  assert.equal(await resolvedServerRuntime(s), null);
});
