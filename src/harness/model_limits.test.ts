import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContextWindow,
  __setRegistryForTesting,
  parseModelsDevApi,
} from './model_limits.js';

test('parseModelsDevApi flattens provider→models→limit.context into a map', () => {
  const api = {
    anthropic: {
      id: 'anthropic',
      models: {
        'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 200_000, output: 64_000 } },
        'claude-opus-4-5': { id: 'claude-opus-4-5', limit: { context: 200_000, output: 32_000 } },
      },
    },
    openai: {
      id: 'openai',
      models: {
        'gpt-4o': { id: 'gpt-4o', limit: { context: 128_000, output: 16_384 } },
        incomplete: { id: 'incomplete' }, // missing limit → skipped
      },
    },
  };
  const map = parseModelsDevApi(api);
  assert.equal(map.get('claude-haiku-4-5'), 200_000);
  assert.equal(map.get('claude-opus-4-5'), 200_000);
  assert.equal(map.get('gpt-4o'), 128_000);
  assert.equal(map.has('incomplete'), false);
});

test('resolveContextWindow returns the registry value when known', () => {
  __setRegistryForTesting(new Map([['claude-haiku-4-5', 200_000]]));
  assert.equal(resolveContextWindow('claude-haiku-4-5'), 200_000);
});

test('resolveContextWindow returns null for unknown model', () => {
  __setRegistryForTesting(new Map());
  assert.equal(resolveContextWindow('not-a-real-model'), null);
});

test('empty registry returns null for everything', () => {
  __setRegistryForTesting(new Map());
  assert.equal(resolveContextWindow('claude-haiku-4-5'), null);
});

test('resolveContextWindow strips :cloud suffix and retries', () => {
  __setRegistryForTesting(new Map([['qwen3.5:397b', 256_000]]));
  assert.equal(resolveContextWindow('qwen3.5:397b-cloud'), 256_000);
  assert.equal(resolveContextWindow('qwen3.5:397b:cloud'), 256_000);
  assert.equal(resolveContextWindow('qwen3.5:397b'), 256_000);
});
