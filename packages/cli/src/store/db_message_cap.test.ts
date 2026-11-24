import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-msg-cap-'));
process.env.CARETAKER_HOME = tempHome;

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { addTaskMessage, MAX_MESSAGE_CHARS } from './db.js';

after(() => rmSync(tempHome, { recursive: true, force: true }));

test('an oversized message is stored truncated, with a visible marker', async () => {
  const content = 'x'.repeat(MAX_MESSAGE_CHARS + 12_345);
  const msg = await addTaskMessage({ taskId: 'cap-1', role: 'assistant', messageType: 'chat', content });
  assert.ok(msg.content.length < content.length);
  assert.ok(msg.content.startsWith('x'.repeat(MAX_MESSAGE_CHARS)));
  assert.match(msg.content, /\[truncated: 12345 characters omitted\]$/);
});

test('a message at the cap is stored as is', async () => {
  const content = 'y'.repeat(MAX_MESSAGE_CHARS);
  const msg = await addTaskMessage({ taskId: 'cap-1', role: 'assistant', messageType: 'chat', content });
  assert.equal(msg.content, content);
});

test('the cap keeps one message well under the 1 MB orchestrator cap, even fully escaped', () => {
  // Worst case: every character is a control character JSON escapes as \u00XX.
  assert.ok(JSON.stringify('\u0001'.repeat(MAX_MESSAGE_CHARS)).length < 1_048_576);
});
