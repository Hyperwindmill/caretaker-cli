import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskMessage } from '../../../store/db.js';
import type { AgentConfig } from '../../../types.js';
import type { Session } from '../../../session/types.js';
import { watchCycleStream, type CycleEvent } from './cycle_events.js';

// File-scope CARETAKER_HOME: one temp store for every test in this file.
let testHome: string;
let cycle: typeof import('./task_cycle.js');
let db: typeof import('../../../store/db.js');
let sessions: typeof import('../../../session/store.js');

before(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'caretaker-task-cycle-test-'));
  process.env.CARETAKER_HOME = testHome;
  cycle = await import('./task_cycle.js');
  db = await import('../../../store/db.js');
  sessions = await import('../../../session/store.js');
});

after(async () => {
  await rm(testHome, { recursive: true, force: true });
  delete process.env.CARETAKER_HOME;
});

const msg = (messageType: TaskMessage['messageType'], over: Partial<TaskMessage> = {}): TaskMessage =>
  ({ id: 1, taskId: 'p-1', role: 'assistant', messageType, content: '', createdAt: '', ...over }) as TaskMessage;

const agent = { id: 'agent-cycle', name: 'A', model: 'm' } as AgentConfig;
const task = { id: 'p-9', projectId: 'p', title: 'T', status: 'active' } as unknown as Task;

async function taskRows(taskId: string): Promise<TaskMessage[]> {
  const rows = (await db.runQuery(`SELECT * FROM task_messages WHERE taskId = '${taskId}'`)) as TaskMessage[];
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

async function readCycleSession(rec: { sessionId: string }): Promise<Session> {
  return sessions.readSession(agent.id, rec.sessionId);
}

test('filterHandoffMessages drops transcripts', () => {
  const kept = cycle
    .filterHandoffMessages([
      msg('heartbeat'), msg('tool_call'), msg('chat'), msg('cycle'), msg('plan'), msg('review'), msg('system'),
    ])
    .map((m) => m.messageType);
  assert.deepEqual(kept, ['chat', 'plan', 'review']);
});

test('resolveCycleOutcome', () => {
  const base = { role: 'developer' as const, statusAfter: 'active' as const, aborted: false, failed: false };
  assert.equal(cycle.resolveCycleOutcome(base), 'handoff');
  assert.equal(cycle.resolveCycleOutcome({ ...base, aborted: true, statusAfter: 'paused' }), 'aborted');
  assert.equal(cycle.resolveCycleOutcome({ ...base, failed: true }), 'failed');
  assert.equal(cycle.resolveCycleOutcome({ ...base, statusAfter: 'reviewing' }), 'completed');
  assert.equal(cycle.resolveCycleOutcome({ ...base, statusAfter: 'blocked' }), 'blocked');
  assert.equal(cycle.resolveCycleOutcome({ ...base, role: 'planner' }), 'plan');
  assert.equal(cycle.resolveCycleOutcome({ ...base, role: 'planner', statusAfter: 'planning' }), 'handoff');
  assert.equal(cycle.resolveCycleOutcome({ ...base, role: 'reviewer', verdict: 'changes' }), 'review-changes');
});

test('close without handoff writes the fallback and a recap record', async () => {
  const rec = await cycle.openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'do it' });
  await rec.callbacks.onMessage!(sessions.assistantMessage([{ type: 'text', text: 'halfway there' }]));
  await rec.close({ outcome: 'aborted' });
  const s = await readCycleSession(rec);
  assert.equal(s.meta.taskRole, 'developer');
  assert.equal(s.messages[0]!.role, 'user');
  const recap = s.messages.at(-1)!;
  assert.equal(recap.recap, true);
  assert.match(recap.content, /^Cycle ended without a handoff note \(aborted\)\. Last output: halfway there$/);
  const row = (await taskRows(task.id)).find((m) => m.messageType === 'cycle' && m.sessionId === rec.sessionId)!;
  assert.equal(row.cycleOutcome, 'aborted');
  assert.equal(row.agentLabel, 'A · m');
});

test('close with a handoff recaps it and adds no fallback', async () => {
  const rec = await cycle.openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'p' });
  await db.addTaskMessage({ taskId: task.id, role: 'assistant', messageType: 'chat', content: 'did X, next Y' });
  await rec.close({ outcome: 'handoff' });
  const recap = (await readCycleSession(rec)).messages.at(-1)!;
  assert.equal(recap.content, 'did X, next Y');
});

test('close on a run that failed before any output', async () => {
  const rec = await cycle.openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'p' });
  await rec.close({ outcome: 'failed' });
  const recap = (await readCycleSession(rec)).messages.at(-1)!;
  assert.match(recap.content, /\(failed\)\. Last output: \(none\)$/);
});

test('watcher attached before close sees the cycle, ending with done', async () => {
  const rec = await cycle.openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'live' });
  const seen: CycleEvent[] = [];
  const snap = watchCycleStream(rec.sessionId, (e) => seen.push(e))!;
  assert.equal(snap.prompt.content, 'live');
  rec.callbacks.onChunk!('working');
  rec.callbacks.onToolCall!('t1', 'read_file', { path: 'a' });
  rec.callbacks.onToolResult!('t1', 'ok');
  await rec.close({ outcome: 'aborted' });
  assert.deepEqual(seen.map((e) => e.type), ['chunk', 'tool_call', 'tool_result', 'done']);
  assert.equal(watchCycleStream(rec.sessionId, () => {}), null);
});

test('a failed cycle ends its stream with an error event', async () => {
  const rec = await cycle.openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'boom' });
  const seen: CycleEvent[] = [];
  watchCycleStream(rec.sessionId, (e) => seen.push(e));
  await rec.close({ outcome: 'failed' });
  assert.equal(seen.at(-1)?.type, 'error');
});
