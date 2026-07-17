import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ccsid-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, readSession, listForAgent, updateClaudeSessionId } from './store.js';

test('claudeSessionId round-trips via appended meta (latest wins)', async () => {
  const meta = await createSession({ agentId: 'a1', title: 'hello world' });
  assert.equal((await readSession('a1', meta.id)).meta.claudeSessionId, undefined);
  await updateClaudeSessionId(meta, 'cc-session-123');
  const after = await readSession('a1', meta.id);
  assert.equal(after.meta.claudeSessionId, 'cc-session-123');
  // second update replaces
  await updateClaudeSessionId(meta, 'cc-session-456');
  assert.equal((await readSession('a1', meta.id)).meta.claudeSessionId, 'cc-session-456');
  // session listing still works (first-meta index unaffected)
  const list = await listForAgent('a1');
  assert.equal(list.length, 1);
  assert.equal(list[0].meta.title, 'hello world');
});
