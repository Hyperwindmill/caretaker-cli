import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmGateState } from './confirm_gate.js';

test('native/claude-code: asks only for names in confirmTools; always removes the name', () => {
  const gate = new ConfirmGateState('openai', ['bash', 'write']);
  assert.equal(gate.needsAsk('read_file'), false);
  assert.equal(gate.needsAsk('bash'), true);
  gate.remember('bash', 'always');
  assert.equal(gate.needsAsk('bash'), false);
  assert.equal(gate.needsAsk('write'), true); // untouched
});

test("native: 'once' and 'reject' do not change future asks", () => {
  const gate = new ConfirmGateState('openai', ['bash']);
  gate.remember('bash', 'once');
  gate.remember('bash', 'reject');
  assert.equal(gate.needsAsk('bash'), true);
});

test('acp: every request asks — the agent already decided it was worth asking', () => {
  const gate = new ConfirmGateState('acp', []); // confirmTools is empty for acp agents
  assert.equal(gate.needsAsk('Bash'), true);
  assert.equal(gate.needsAsk('anything-else'), true);
});

test("acp: 'always' suppresses future asks for that name only", () => {
  const gate = new ConfirmGateState('acp', []);
  gate.remember('Bash', 'always');
  assert.equal(gate.needsAsk('Bash'), false);
  assert.equal(gate.needsAsk('Edit'), true);
  gate.remember('Edit', 'once');
  assert.equal(gate.needsAsk('Edit'), true);
});
