import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryConfig, memorySignature } from './memory_tab_utils.js';

test('disabled or agent-less form → undefined (memory off)', () => {
  assert.equal(
    buildMemoryConfig({ enabled: false, agentId: 'a1', sweepMinutes: '5', minNewMessages: '4' }),
    undefined
  );
  assert.equal(
    buildMemoryConfig({ enabled: true, agentId: '  ', sweepMinutes: '', minNewMessages: '' }),
    undefined
  );
});

test('blank numeric fields are omitted so daemon defaults apply', () => {
  assert.deepEqual(
    buildMemoryConfig({ enabled: true, agentId: 'a1', sweepMinutes: '', minNewMessages: '' }),
    { agentId: 'a1' }
  );
});

test('valid numbers are parsed; junk and non-positives are dropped', () => {
  assert.deepEqual(
    buildMemoryConfig({ enabled: true, agentId: 'a1', sweepMinutes: '10', minNewMessages: '1' }),
    { agentId: 'a1', sweepMinutes: 10, minNewMessages: 1 }
  );
  assert.deepEqual(
    buildMemoryConfig({ enabled: true, agentId: 'a1', sweepMinutes: '0', minNewMessages: 'abc' }),
    { agentId: 'a1' }
  );
  assert.deepEqual(
    buildMemoryConfig({ enabled: true, agentId: 'a1', sweepMinutes: '-3', minNewMessages: '2.9' }),
    { agentId: 'a1', minNewMessages: 2 }
  );
});

test('signature matches persisted shape and distinguishes off from set', () => {
  const m = buildMemoryConfig({ enabled: true, agentId: 'a1', sweepMinutes: '5', minNewMessages: '' });
  assert.equal(
    memorySignature(m as unknown as Record<string, unknown>),
    memorySignature({ agentId: 'a1', sweepMinutes: 5 })
  );
  assert.equal(memorySignature(undefined), '');
  assert.notEqual(memorySignature({ agentId: 'a1' }), memorySignature({ agentId: 'a2' }));
});
