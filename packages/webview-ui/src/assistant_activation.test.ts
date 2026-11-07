import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginActivation, onAgentSelected } from './assistant_activation.js';

test('unknown agent → null (window shows, nothing else happens)', () => {
  assert.equal(beginActivation('x', null, ['a']), null);
});

test('already selected agent → open immediately', () => {
  assert.deepEqual(beginActivation('a', 'a', ['a']), { agentId: 'a', step: 'open' });
});

test('different agent → awaiting, promoted only by the matching agentSelected', () => {
  const a = beginActivation('b', 'a', ['a', 'b']);
  assert.deepEqual(a, { agentId: 'b', step: 'awaiting-agent' });
  assert.deepEqual(onAgentSelected(a, 'a'), a);
  assert.deepEqual(onAgentSelected(a, 'b'), { agentId: 'b', step: 'open' });
});

test('agentSelected with no pending activation stays null', () => {
  assert.equal(onAgentSelected(null, 'a'), null);
});

test('agentSelected does not regress an activation past awaiting', () => {
  const mic = { agentId: 'b', step: 'mic' as const };
  assert.deepEqual(onAgentSelected(mic, 'b'), mic);
});
