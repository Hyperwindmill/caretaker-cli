import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-tasktools-home-'));
process.env.CARETAKER_HOME = CT_HOME;

const { createTask, getTaskById, saveTask } = await import('../../../store/db.js');
const { completeTaskTool } = await import('./task_tools.js');

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

  await completeTaskTool.execute({ task_id: t.id });

  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'reviewing');
});

test('task_complete on a non-git task (no worktree) -> done', async () => {
  const t = await createTask({ ...base, title: 'Non-Git Task' });
  await completeTaskTool.execute({ task_id: t.id });
  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'done');
});

test.after(async () => {
  await rm(CT_HOME, { recursive: true, force: true });
});
