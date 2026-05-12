// Guards the public API surface exported under `caretaker-cli/session`.
// See harness/public_api.test.ts for the rationale.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as session from './index.js';

test('session barrel exports the public surface', () => {
  for (const name of [
    'createSession',
    'appendMessage',
    'readSession',
    'listForAgent',
    'updateTitle',
    'deleteSession',
    'userMessage',
    'assistantMessage',
    'toolMessage',
    'dataDir',
    'sessionsRoot',
  ] as const) {
    assert.ok(name in session, `missing export: ${name}`);
  }
  assert.equal(typeof session.createSession, 'function');
  assert.equal(typeof session.dataDir, 'string');
});
