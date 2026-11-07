import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginActivation, localSelectionFor, onAgentSelected, onSelectFailed, resolvePending } from './assistant_activation.js';

test('unknown agent → current activation unchanged (window shows, nothing else)', () => {
  assert.equal(beginActivation('x', null, ['a'], null), null);
});

test('agent the server already confirmed → open immediately', () => {
  assert.deepEqual(beginActivation('a', 'a', ['a'], null), { agentId: 'a', step: 'open' });
});

test('different agent → awaiting, promoted only by the matching agentSelected', () => {
  const a = beginActivation('b', 'a', ['a', 'b'], null);
  assert.deepEqual(a, { agentId: 'b', step: 'awaiting-agent' });
  assert.deepEqual(onAgentSelected(a, 'a'), a);
  assert.deepEqual(onAgentSelected(a, 'b'), { agentId: 'b', step: 'open' });
});

test('gate uses the server-confirmed agent, not the one the client shows (broken provider, second press)', () => {
  // The client already shows B after a failed selectAgent; the server still runs A.
  assert.deepEqual(beginActivation('b', 'a', ['a', 'b'], null), { agentId: 'b', step: 'awaiting-agent' });
});

test('second press while already awaiting the same agent returns the same object (no re-post)', () => {
  const a = beginActivation('b', 'a', ['a', 'b'], null);
  assert.equal(beginActivation('b', 'a', ['a', 'b'], a), a);
});

test('a failed agent switch cancels the waiting activation', () => {
  assert.equal(onSelectFailed({ agentId: 'b', step: 'awaiting-agent' }), null);
  const mic = { agentId: 'b', step: 'mic' as const };
  assert.equal(onSelectFailed(mic), mic);
  assert.equal(onSelectFailed(null), null);
});

test('agentSelected with no pending activation stays null, and never regresses mic', () => {
  assert.equal(onAgentSelected(null, 'a'), null);
  const mic = { agentId: 'b', step: 'mic' as const };
  assert.deepEqual(onAgentSelected(mic, 'b'), mic);
});

test('a request arriving before the agent list is kept pending (first launch)', () => {
  assert.deepEqual(resolvePending('b', null, [], null), { activation: null, pending: 'b' });
});

test('a pending request is consumed once agents are known', () => {
  assert.deepEqual(resolvePending('b', null, ['a', 'b'], null), {
    activation: { agentId: 'b', step: 'awaiting-agent' },
    pending: null,
  });
  assert.deepEqual(resolvePending(null, 'a', ['a'], null), { activation: null, pending: null });
});

test('server already on the agent but the view shows none (boot auto-select) → adopt it locally', () => {
  // The server auto-selects agents[0] at boot and acks it; the client never selected anything.
  const a = beginActivation('a', 'a', ['a', 'b'], null);
  assert.deepEqual(a, { agentId: 'a', step: 'open' });
  assert.equal(localSelectionFor(a, null), 'a');
  assert.equal(localSelectionFor(a, 'b'), 'a');
});

test('view already shows the agent, or nothing is open yet → no local change', () => {
  assert.equal(localSelectionFor({ agentId: 'a', step: 'open' }, 'a'), null);
  assert.equal(localSelectionFor({ agentId: 'a', step: 'awaiting-agent' }, null), null);
  assert.equal(localSelectionFor(null, null), null);
});
