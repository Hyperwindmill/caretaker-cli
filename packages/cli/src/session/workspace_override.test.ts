import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-wsovr-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, readSession, listForAgent, updateSessionWorkspace } from './store.js';

test('workspace override round-trips via appended meta (latest wins)', async () => {
  const meta = await createSession({ agentId: 'a1', title: 'hello' });
  assert.equal((await readSession('a1', meta.id)).meta.workingDir, undefined);
  await updateSessionWorkspace(meta, { workingDir: '/tmp/p1', projectId: 'p1' });
  const after = (await readSession('a1', meta.id)).meta;
  assert.equal(after.workingDir, '/tmp/p1');
  assert.equal(after.projectId, 'p1');
  await updateSessionWorkspace(meta, { workingDir: '/tmp/p2', projectId: 'p2' });
  const latest = (await readSession('a1', meta.id)).meta;
  assert.equal(latest.workingDir, '/tmp/p2');
  assert.equal(latest.projectId, 'p2');
  // listing still indexes the session once, title from the first meta
  const list = await listForAgent('a1');
  assert.equal(list.length, 1);
  assert.equal(list[0].meta.title, 'hello');
});
