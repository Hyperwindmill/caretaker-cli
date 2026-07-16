import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '../types.js';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-tasktools-home-'));
process.env.CARETAKER_HOME = CT_HOME;

const { createTask, getTaskById, saveTask, deleteTask, addTaskMessage, runQuery } = await import('../../../store/db.js');
const { completeTaskTool, taskArchiveTool, taskUnarchiveTool, taskDeleteTool, taskSearchTool } = await import('./task_tools.js');
const { runningTasks } = await import('../../../cli/web/scheduler/locks.js');

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: '/work',
    readPaths: new Set(),
  };
}

const base = {
  projectId: 1,
  title: 'T',
  objective: 'o',
  checklist: [],
  status: 'active' as const,
  blockedReason: null,
  noProgressCount: 0,
  maxNoProgress: 5,
  lockedAt: null,
};

test('task_complete on a git task (worktree set) -> reviewing', async () => {
  const t = await createTask({ ...base, title: 'Git Task' });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'x');
  gt!.branch = 'caretaker/task-x';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'reviewing');
});

test('task_complete on a non-git task (no worktree) -> done', async () => {
  const t = await createTask({ ...base, title: 'Non-Git Task' });
  await completeTaskTool.execute({ task_id: t.id }, ctx());
  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'done');
});

test('task_archive sets archived=true and pauses active tasks', async () => {
  const t = await createTask({ ...base, title: 'Archive Me' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.archived, true);
  assert.equal(after!.status, 'paused');
});

test('task_archive pauses reviewing tasks', async () => {
  const t = await createTask({ ...base, title: 'Review Archive', status: 'reviewing' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.archived, true);
  assert.equal(after!.status, 'paused');
});

test('task_archive does not change already-paused tasks', async () => {
  const t = await createTask({ ...base, title: 'Paused Archive', status: 'paused' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.archived, true);
  assert.equal(after!.status, 'paused');
});

test('task_unarchive clears archived but does not change status', async () => {
  const t = await createTask({ ...base, title: 'Unarchive Me', status: 'paused' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.archived, true);

  await taskUnarchiveTool.execute({ task_id: t.id }, ctx());
  const after = await getTaskById(t.id);
  assert.equal(after!.archived, false);
  assert.equal(after!.status, 'paused');
});

test('task_delete removes the task and its messages from the store', async () => {
  const t = await createTask({ ...base, title: 'Delete Me' });
  await addTaskMessage({ taskId: t.id, role: 'assistant', messageType: 'chat', content: 'hello' });
  await addTaskMessage({ taskId: t.id, role: 'assistant', messageType: 'chat', content: 'world' });

  await taskDeleteTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after, null);

  const msgs = await runQuery(`SELECT * FROM task_messages WHERE taskId = ${t.id}`);
  assert.equal(msgs.length, 0);
});

test('task_delete refuses to delete a locked/running task', async () => {
  const t = await createTask({ ...base, title: 'Running Task' });
  const task = await getTaskById(t.id);
  task!.lockedAt = new Date().toISOString();
  await saveTask(task!);

  const result = await taskDeleteTool.execute({ task_id: t.id }, ctx());
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.error);
  assert.ok(parsed.error.includes('running'));

  // Task should still exist
  const after = await getTaskById(t.id);
  assert.ok(after);

  // Clean up lock
  task!.lockedAt = null;
  await saveTask(task!);
});

test('task_delete refuses when runningTasks set even if lockedAt is null', async () => {
  const t = await createTask({ ...base, title: 'In-Mem Locked' });
  const lockKey = `task_db_${t.id}`;
  runningTasks.add(lockKey);

  try {
    const result = await taskDeleteTool.execute({ task_id: t.id }, ctx());
    const parsed = JSON.parse(result.content);
    assert.ok(parsed.error);
    assert.ok(parsed.error.includes('running'));

    const after = await getTaskById(t.id);
    assert.ok(after);
  } finally {
    runningTasks.delete(lockKey);
  }
});

test('task_search excludes archived tasks by default', async () => {
  const t1 = await createTask({ ...base, title: 'Searchable Active', objective: 'find me' });
  const t2 = await createTask({ ...base, title: 'Searchable Archived', objective: 'find me too' });
  await taskArchiveTool.execute({ task_id: t2.id }, ctx());

  // Default search excludes archived
  const result = await taskSearchTool.execute({ query: 'find me' }, ctx());
  const matches = JSON.parse(result.content);
  const ids = matches.map((m: any) => m.id);
  assert.ok(ids.includes(t1.id));
  assert.ok(!ids.includes(t2.id));

  // include_archived=true returns both
  const result2 = await taskSearchTool.execute({ query: 'find me', include_archived: true }, ctx());
  const matches2 = JSON.parse(result2.content);
  const ids2 = matches2.map((m: any) => m.id);
  assert.ok(ids2.includes(t1.id));
  assert.ok(ids2.includes(t2.id));
});

test.after(async () => {
  await rm(CT_HOME, { recursive: true, force: true });
});
