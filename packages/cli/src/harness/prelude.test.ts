import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_PRELUDE, withHarnessPrelude } from './prelude.js';

test('HARNESS_PRELUDE: opens with the caretaker identity statement', () => {
  assert.match(HARNESS_PRELUDE, /^You are a caretaker agent\. This means you:/);
});

test('HARNESS_PRELUDE: covers the three CARE principles', () => {
  assert.match(HARNESS_PRELUDE, /CARE about your goal/);
  assert.match(HARNESS_PRELUDE, /CARE about your environment/);
  assert.match(HARNESS_PRELUDE, /CARE about your project/);
});

test('HARNESS_PRELUDE: covers the four harness conventions', () => {
  assert.match(HARNESS_PRELUDE, /function-calling protocol/);
  assert.match(HARNESS_PRELUDE, /JSON-encoded message envelopes/);
  assert.match(HARNESS_PRELUDE, /sandboxed to the agent's working directory/);
  assert.match(HARNESS_PRELUDE, /automatically capped/);
});

test('withHarnessPrelude: returns prelude alone when prompt is empty/whitespace/undefined', () => {
  assert.equal(withHarnessPrelude(''), HARNESS_PRELUDE);
  assert.equal(withHarnessPrelude('   '), HARNESS_PRELUDE);
  assert.equal(withHarnessPrelude(undefined), HARNESS_PRELUDE);
});

test('withHarnessPrelude: combines prelude + agent prompt with double newline', () => {
  const out = withHarnessPrelude('You are an expert.');
  assert.equal(out, `${HARNESS_PRELUDE}\n\nYou are an expert.`);
});

test('withHarnessPrelude: trims agent prompt', () => {
  const out = withHarnessPrelude('  spaced  ');
  assert.equal(out, `${HARNESS_PRELUDE}\n\nspaced`);
});
