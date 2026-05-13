import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseViewToHost } from './bridge.js';

test('parseViewToHost: accepts valid start message', () => {
  const msg = parseViewToHost({ type: 'start', prompt: 'hello' });
  assert.deepEqual(msg, { type: 'start', prompt: 'hello' });
});

test('parseViewToHost: rejects start with non-string prompt', () => {
  assert.equal(parseViewToHost({ type: 'start', prompt: 42 }), null);
  assert.equal(parseViewToHost({ type: 'start' }), null);
});

test('parseViewToHost: accepts abort', () => {
  assert.deepEqual(parseViewToHost({ type: 'abort' }), { type: 'abort' });
});

test('parseViewToHost: accepts each decision in permission_response', () => {
  for (const decision of ['once', 'always', 'reject'] as const) {
    assert.deepEqual(parseViewToHost({ type: 'permission_response', id: 'r1', decision }), {
      type: 'permission_response',
      id: 'r1',
      decision,
    });
  }
});

test('parseViewToHost: rejects permission_response with bad decision', () => {
  assert.equal(parseViewToHost({ type: 'permission_response', id: 'r1', decision: 'maybe' }), null);
  assert.equal(parseViewToHost({ type: 'permission_response', id: 'r1' }), null);
  assert.equal(parseViewToHost({ type: 'permission_response', decision: 'once' }), null);
});

test('parseViewToHost: rejects unknown types and non-objects', () => {
  assert.equal(parseViewToHost({ type: 'nope' }), null);
  assert.equal(parseViewToHost(null), null);
  assert.equal(parseViewToHost('start'), null);
  assert.equal(parseViewToHost(undefined), null);
});
