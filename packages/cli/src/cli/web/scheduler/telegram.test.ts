import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope isolation: dataDir() reads CARETAKER_HOME at call time.
process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-telegram-'));

const { saveTelegramOffset, loadTelegramOffset } = await import('./telegram.js');

test('saveTelegramOffset creates scheduler-logs when missing', async () => {
  assert.equal(existsSync(join(process.env.CARETAKER_HOME!, 'scheduler-logs')), false);
  await saveTelegramOffset('task_abc', 42);
  assert.equal(await loadTelegramOffset('task_abc'), 42);
});
