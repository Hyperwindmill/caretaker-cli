import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, initialChatState } from './chat_state.js';

test('tool call closes the streaming assistant span', () => {
  let s = chatReducer(initialChatState, { kind: 'append-chunk', text: 'a' });
  s = chatReducer(s, { kind: 'tool-call', id: 't', name: 'x', args: {} });
  s = chatReducer(s, { kind: 'append-chunk', text: 'b' });
  assert.deepEqual(s.items.map((i) => i.kind), ['assistant', 'tool', 'assistant']);
  assert.equal((s.items[0] as { streaming: boolean }).streaming, false);
});

test('load-history: recap becomes a notice, streaming flag sets status', () => {
  const s = chatReducer(initialChatState, {
    kind: 'load-history',
    streaming: true,
    messages: [
      { id: '1', role: 'user', content: 'p', createdAt: '' },
      { id: '2', role: 'assistant', content: 'R', recap: true, createdAt: '' },
    ],
  });
  assert.equal(s.status, 'streaming');
  assert.deepEqual(s.items.at(-1), { kind: 'notice', text: 'R', variant: 'system' });
});

test('load-history without the streaming flag is idle', () => {
  const s = chatReducer(initialChatState, {
    kind: 'load-history',
    messages: [{ id: '1', role: 'user', content: 'p', createdAt: '' }],
  });
  assert.equal(s.status, 'idle');
});
