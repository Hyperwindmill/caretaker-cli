import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeContextUsage } from './context_usage.js';
import { __setRegistryForTesting } from '../harness/model_limits.js';

test('returns null when no assistant has usage', () => {
  __setRegistryForTesting(new Map([['gpt-4o', 128_000]]));
  assert.equal(computeContextUsage([{ role: 'user', usage: null }], 'gpt-4o'), null);
});

test('uses last assistant with usage and resolves window', () => {
  __setRegistryForTesting(new Map([['gpt-4o', 128_000]]));
  const rows = [
    { role: 'assistant', usage: { input: 100, output: 10 } }, // older
    { role: 'tool', usage: null },
    { role: 'user', usage: null },
    { role: 'assistant', usage: { input: 1000, output: 200, cacheRead: 500 } }, // newer
  ];
  const r = computeContextUsage(rows, 'gpt-4o');
  assert.equal(r?.lastTokens, 1700);
  assert.equal(r?.contextWindow, 128_000);
  assert.equal(r?.percent, Math.round((1700 / 128_000) * 100));
});

test('unknown model → window null, percent null', () => {
  __setRegistryForTesting(new Map());
  const rows = [{ role: 'assistant', usage: { input: 50, output: 0 } }];
  const r = computeContextUsage(rows, 'mystery-model');
  assert.equal(r?.lastTokens, 50);
  assert.equal(r?.contextWindow, null);
  assert.equal(r?.percent, null);
});

test('null model → window null, percent null', () => {
  const rows = [{ role: 'assistant', usage: { input: 50, output: 0 } }];
  const r = computeContextUsage(rows, null);
  assert.equal(r?.lastTokens, 50);
  assert.equal(r?.contextWindow, null);
  assert.equal(r?.percent, null);
});

test('zero-total assistant usage rows are skipped', () => {
  __setRegistryForTesting(new Map([['gpt-4o', 128_000]]));
  const rows = [
    { role: 'assistant', usage: { input: 5, output: 5 } },
    { role: 'assistant', usage: { input: 0, output: 0 } },
  ];
  const r = computeContextUsage(rows, 'gpt-4o');
  assert.equal(r?.lastTokens, 10);
});
