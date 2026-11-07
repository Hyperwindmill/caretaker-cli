import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionRunScope } from './session_scope.js';

test('agent default when there is no session meta', () => {
  assert.deepEqual(sessionRunScope(undefined, '/a'), { workingDir: '/a' });
});

test('agent default when the meta carries no override', () => {
  assert.deepEqual(sessionRunScope({}, '/a'), { workingDir: '/a' });
});

test('override wins and carries the project scope', () => {
  assert.deepEqual(sessionRunScope({ workingDir: '/p', projectId: 'p' }, '/a'), {
    workingDir: '/p',
    memoryProjectId: 'p',
  });
});
