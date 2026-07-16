import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../types.js';

process.env.CARETAKER_HOME = await mkdtemp(join(tmpdir(), 'ct-discard-home-'));

const { taskDiscardWorktreeTool } = await import('./task_tools.js');

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: '/work',
    readPaths: new Set(),
  };
}

test('task_discard_worktree errors when the task has no worktree', async () => {
  // Task 999 does not exist -> "not found".
  const res = await taskDiscardWorktreeTool.execute({ task_id: 999 }, ctx());
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.error, 'Task 999 not found');
});
