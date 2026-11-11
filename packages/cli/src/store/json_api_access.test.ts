import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: must be set before importing anything that resolves CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-api-access-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiAccessPath,
  createApiToken,
  loadApiAccess,
  revokeApiToken,
  setApiPort,
  verifyApiToken,
} from './json.js';

test('defaults to no port and no tokens, never a shared object', async () => {
  const a = await loadApiAccess();
  assert.equal(a.port, undefined);
  assert.equal(a.tokens.length, 0);
  a.tokens.push({ id: 'x', name: 'x', hash: 'x', createdAt: '' });
  assert.deepEqual(await loadApiAccess(), { tokens: [] });
  assert.equal(await verifyApiToken('anything'), false);
});

test('a created token verifies and is never stored in clear', async () => {
  const { token, record } = await createApiToken('  ci  ');
  assert.match(token, /^ctk_[A-Za-z0-9_-]{43}$/);
  assert.equal(record.name, 'ci');
  assert.equal(await verifyApiToken(token), true);
  assert.equal(await verifyApiToken(token + 'x'), false);
  assert.equal(await verifyApiToken(''), false);
  const onDisk = readFileSync(apiAccessPath(), 'utf8');
  assert.ok(!onDisk.includes(token));
  assert.ok(onDisk.includes(record.hash));
});

test('setting the port keeps the tokens, and clearing it removes the key', async () => {
  const before = (await loadApiAccess()).tokens;
  await setApiPort(4000);
  assert.deepEqual(await loadApiAccess(), { port: 4000, tokens: before });
  await setApiPort(null);
  assert.deepEqual(await loadApiAccess(), { tokens: before });
});

test('a revoked token stops verifying; the others keep working', async () => {
  const a = await createApiToken('a');
  const b = await createApiToken('b');
  assert.equal(await revokeApiToken(a.record.id), true);
  assert.equal(await revokeApiToken(a.record.id), false);
  assert.equal(await verifyApiToken(a.token), false);
  assert.equal(await verifyApiToken(b.token), true);
});
