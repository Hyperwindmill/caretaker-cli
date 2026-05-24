import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  matchesCron,
  schedulerLogPath,
  saveTaskRun,
  loadTaskRuns,
  schedulerLogsDir,
} from './scheduler.js';

test('scheduler: matchesCron evaluates wildcard correctly', () => {
  const d = new Date('2026-05-24T12:30:00Z');
  assert.equal(matchesCron('* * * * *', d), true);
});

test('scheduler: matchesCron evaluates minutes/hours correctly', () => {
  const d = new Date('2026-05-24T09:00:00'); // 9:00 AM local
  assert.equal(matchesCron('0 9 * * *', d), true);
  assert.equal(matchesCron('5 9 * * *', d), false);
  assert.equal(matchesCron('0 10 * * *', d), false);
});

test('scheduler: matchesCron evaluates step expressions', () => {
  const d1 = new Date('2026-05-24T12:15:00');
  const d2 = new Date('2026-05-24T12:17:00');
  assert.equal(matchesCron('*/5 * * * *', d1), true);
  assert.equal(matchesCron('*/5 * * * *', d2), false);
});

test('scheduler: matchesCron evaluates lists', () => {
  const d1 = new Date('2026-05-24T12:05:00');
  const d2 = new Date('2026-05-24T12:10:00');
  assert.equal(matchesCron('5,15,25 * * * *', d1), true);
  assert.equal(matchesCron('5,15,25 * * * *', d2), false);
});

test('scheduler: matchesCron evaluates ranges', () => {
  const d1 = new Date('2026-05-24T12:03:00');
  const d2 = new Date('2026-05-24T12:06:00');
  assert.equal(matchesCron('1-5 * * * *', d1), true);
  assert.equal(matchesCron('1-5 * * * *', d2), false);
});

test('scheduler: matchesCron evaluates day of week ranges', () => {
  const sunday = new Date('2026-05-24T12:00:00'); // 2026-05-24 is Sunday (0)
  const monday = new Date('2026-05-25T12:00:00'); // Monday (1)

  // 1-5 is Monday-Friday
  assert.equal(matchesCron('* * * * 1-5', sunday), false);
  assert.equal(matchesCron('* * * * 1-5', monday), true);
});

test('scheduler: log loading and saving', async () => {
  const taskId = 'test-task-123';
  const logFile = schedulerLogPath(taskId);

  // Clean up if file left over
  await rm(logFile, { force: true });

  const run1 = {
    runId: 'run_1',
    timestamp: new Date().toISOString(),
    status: 'success',
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
  };

  const run2 = {
    runId: 'run_2',
    timestamp: new Date().toISOString(),
    status: 'failure',
    error: 'timeout',
    messages: [{ id: 'm2', role: 'user', content: 'hello' }],
  };

  // Write runs
  await saveTaskRun(taskId, run1);
  await saveTaskRun(taskId, run2);

  assert.equal(existsSync(logFile), true);

  // Read runs (should return newest first, so run2 then run1)
  const loaded = await loadTaskRuns(taskId);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].runId, 'run_2');
  assert.equal(loaded[1].runId, 'run_1');
  assert.equal(loaded[0].status, 'failure');
  assert.equal(loaded[1].status, 'success');

  // Clean up
  await rm(logFile, { force: true });
});
