import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAgent, parseToolsOverride } from './run.js';
import type { AgentConfig } from '../types.js';

function agent(name: string): AgentConfig {
  return {
    id: name,
    name,
    systemPrompt: '',
    provider: 'p',
    model: 'm',
    allowedTools: [],
    maxTurns: 5,
  };
}

test('selectAgent: explicit name found', async () => {
  const r = await selectAgent([agent('a'), agent('b')], 'b');
  assert.equal(r.name, 'b');
});

test('selectAgent: explicit name not found → error lists available', async () => {
  await assert.rejects(() => selectAgent([agent('a'), agent('b')], 'x'), /not found.*a, b/);
});

test('selectAgent: no name + single agent auto-picks', async () => {
  const r = await selectAgent([agent('only')], undefined);
  assert.equal(r.name, 'only');
});

test('selectAgent: no name + multiple → error suggests --agent', async () => {
  await assert.rejects(
    () => selectAgent([agent('a'), agent('b')], undefined),
    /multiple agents.*--agent/,
  );
});

test('selectAgent: no name + zero agents → error', async () => {
  await assert.rejects(() => selectAgent([], undefined), /no agents configured/);
});

test('parseToolsOverride: undefined returns null (no override)', () => {
  assert.equal(parseToolsOverride(undefined), null);
});

test('parseToolsOverride: comma-separated with whitespace trim', () => {
  assert.deepEqual(parseToolsOverride('read_file, bash , grep'), ['read_file', 'bash', 'grep']);
});

test('parseToolsOverride: empty string → empty list (means "no tools")', () => {
  assert.deepEqual(parseToolsOverride(''), []);
});

test('parseToolsOverride: trailing comma + empty entries dropped', () => {
  assert.deepEqual(parseToolsOverride('a,b,,'), ['a', 'b']);
});
