import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardTurnCallbacks } from './turn_guard.js';
import type { ChatCallbacks } from './server.js';

function recorder() {
  const calls: string[] = [];
  const cb: ChatCallbacks = {
    onChunk: (t) => calls.push(`chunk:${t}`),
    onThinking: (t) => calls.push(`thinking:${t}`),
    onToolCall: (id) => calls.push(`tool_call:${id}`),
    onToolResult: (id) => calls.push(`tool_result:${id}`),
    askConfirm: async (id) => {
      calls.push(`ask:${id}`);
      return 'once';
    },
    onError: (m) => calls.push(`error:${m}`),
    onDone: () => calls.push('done'),
    onSessionCreated: (id) => calls.push(`session:${id}`),
  };
  return { cb, calls };
}

test('forwards every callback while the turn is current', async () => {
  const { cb, calls } = recorder();
  const g = guardTurnCallbacks(cb, () => true);
  g.onChunk('a');
  g.onThinking('b');
  g.onToolCall('t1', 'bash', {});
  g.onToolResult('t1', 'x');
  assert.equal(await g.askConfirm('t2', 'bash', {}), 'once');
  g.onError('e');
  g.onDone();
  g.onSessionCreated?.('s1');
  assert.deepEqual(calls, ['chunk:a', 'thinking:b', 'tool_call:t1', 'tool_result:t1', 'ask:t2', 'error:e', 'done', 'session:s1']);
});

test('a superseded turn reaches nothing and its confirms are rejected', async () => {
  const { cb, calls } = recorder();
  let current = true;
  const g = guardTurnCallbacks(cb, () => current);
  current = false; // a new session replaced this turn's controller
  g.onChunk('late');
  g.onThinking('late');
  g.onToolCall('t1', 'bash', {});
  g.onToolResult('t1', 'x');
  assert.equal(await g.askConfirm('t2', 'bash', {}), 'reject');
  g.onError('e');
  g.onDone();
  g.onSessionCreated?.('s1');
  assert.deepEqual(calls, []);
});
