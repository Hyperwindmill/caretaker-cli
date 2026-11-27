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

test('a repeated tool-call id refines the args in place', () => {
  let s = chatReducer(initialChatState, { kind: 'tool-call', id: 't', name: 'Bash', args: {} });
  s = chatReducer(s, { kind: 'append-chunk', text: 'b' });
  s = chatReducer(s, { kind: 'tool-call', id: 't', name: 'Bash', args: { command: 'ls' } });
  assert.deepEqual(s.items.map((i) => i.kind), ['tool', 'assistant']);
  assert.deepEqual((s.items[0] as { args: unknown }).args, { command: 'ls' });
});

test('load-history: a result saved before its call is merged into one block', () => {
  const s = chatReducer(initialChatState, {
    kind: 'load-history',
    messages: [
      { id: '1', role: 'tool', toolCallId: 't', content: 'out', createdAt: '' },
      {
        id: '2',
        role: 'assistant',
        content: '',
        parts: [{ type: 'tool_use', id: 't', name: 'Bash', args: { command: 'ls' } }],
        createdAt: '',
      },
    ],
  });
  assert.deepEqual(s.items, [
    { kind: 'tool', id: 't', name: 'Bash', args: { command: 'ls' }, result: 'out' },
  ]);
});

test('load-history: recap becomes a labeled bubble, streaming flag sets status', () => {
  const s = chatReducer(initialChatState, {
    kind: 'load-history',
    streaming: true,
    messages: [
      { id: '1', role: 'user', content: 'p', createdAt: '' },
      { id: '2', role: 'assistant', content: 'R', recap: true, createdAt: '' },
    ],
  });
  assert.equal(s.status, 'streaming');
  assert.deepEqual(s.items.at(-1), { kind: 'assistant', text: 'R', streaming: false, label: 'Cycle recap' });
});

test('load-history without the streaming flag is idle', () => {
  const s = chatReducer(initialChatState, {
    kind: 'load-history',
    messages: [{ id: '1', role: 'user', content: 'p', createdAt: '' }],
  });
  assert.equal(s.status, 'idle');
});
