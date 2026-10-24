import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskMessage } from './db.js';

// File-scope CARETAKER_HOME: every test in this file shares one temp store.
let testHome: string;
let db: typeof import('./db.js');
let sessions: typeof import('../session/store.js');

before(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'caretaker-db-cycle-test-'));
  process.env.CARETAKER_HOME = testHome;
  db = await import('./db.js');
  sessions = await import('../session/store.js');
});

after(async () => {
  await rm(testHome, { recursive: true, force: true });
  delete process.env.CARETAKER_HOME;
});

test('setCycleOutcome updates only the outcome', async () => {
  const m = await db.addTaskMessage({
    taskId: 'p-1', role: 'assistant', messageType: 'cycle', content: '',
    sessionId: 's1', sessionAgentId: 'a', cycleRole: 'developer', cycleOutcome: 'running',
  });
  await db.setCycleOutcome(m.id, 'handoff');
  const [row] = (await db.runQuery(`SELECT * FROM task_messages WHERE taskId = 'p-1'`)) as TaskMessage[];
  assert.equal(row!.cycleOutcome, 'handoff');
  assert.equal(row!.sessionId, 's1');
});

test('deleteTask removes cycle sessions and tolerates missing files', async () => {
  const meta = await sessions.createSession({ agentId: 'a', title: 'c', taskId: 'p-2', projectId: 'p', taskRole: 'developer' });
  await db.addTaskMessage({
    taskId: 'p-2', role: 'assistant', messageType: 'cycle', content: '',
    sessionId: meta.id, sessionAgentId: 'a', cycleRole: 'developer', cycleOutcome: 'handoff',
  });
  await db.addTaskMessage({
    taskId: 'p-2', role: 'assistant', messageType: 'cycle', content: '',
    sessionId: 'gone', sessionAgentId: 'nobody', cycleRole: 'developer', cycleOutcome: 'handoff',
  });
  await db.deleteTask('p-2');
  await assert.rejects(sessions.readSession('a', meta.id));
});
