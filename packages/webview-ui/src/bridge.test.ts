import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseViewToHost } from './bridge.js';

test('watchCycle with a traversal-looking session id is rejected', () => {
  assert.equal(parseViewToHost({ type: 'watchCycle', agentId: 'a', sessionId: '../x' }), null);
  assert.equal(parseViewToHost({ type: 'watchCycle', agentId: '../a', sessionId: 'ok' }), null);
  assert.equal(parseViewToHost({ type: 'watchCycle', agentId: 'a' }), null);
});

test('watchCycle and unwatchCycle with valid ids parse to the typed message', () => {
  assert.deepEqual(parseViewToHost({ type: 'watchCycle', agentId: 'ag-1', sessionId: 'S_9-x' }), {
    type: 'watchCycle',
    agentId: 'ag-1',
    sessionId: 'S_9-x',
  });
  assert.deepEqual(parseViewToHost({ type: 'unwatchCycle', sessionId: 'S_9-x' }), {
    type: 'unwatchCycle',
    sessionId: 'S_9-x',
  });
  assert.equal(parseViewToHost({ type: 'unwatchCycle', sessionId: 'a/b' }), null);
});
