import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentContextTool } from './get_agent_context.js';
import type { ToolContext } from '../types.js';
import type { AgentConfig } from '../../../types.js';

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'x',
    name: 'auditor',
    systemPrompt: '',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    allowedTools: [],
    maxTurns: 5,
    ...over,
  };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: '/work',
    readPaths: new Set(),
    callerAgent: agent(),
    ...over,
  };
}

test('get_agent_context: returns identity even when liveUsage is missing', async () => {
  const out = await getAgentContextTool.execute({}, ctx());
  const parsed = JSON.parse(out.content);
  assert.equal(parsed.agent.name, 'auditor');
  assert.equal(parsed.agent.model, 'claude-opus-4-7');
  assert.equal(parsed.agent.provider, 'anthropic');
  assert.equal(parsed.workingDir, '/work');
  assert.equal(parsed.usage.lastTurn, null);
  assert.deepEqual(parsed.usage.cumulative, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
  });
  assert.equal(parsed.usage.contextWindow, null);
  assert.equal(parsed.usage.percent, null);
});

test('get_agent_context: surfaces lastTurn and cumulative from ctx.liveUsage', async () => {
  const cumulative = { input: 12, output: 7, cacheRead: 3, cacheWrite: 0, reasoning: 1 };
  const lastTurn = { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 };
  const out = await getAgentContextTool.execute({}, ctx({ liveUsage: { lastTurn, cumulative } }));
  const parsed = JSON.parse(out.content);
  assert.equal(parsed.usage.lastTurn.input, 5);
  assert.equal(parsed.usage.lastTurn.total, 5 + 2 + 1 + 0 + 0);
  assert.equal(parsed.usage.cumulative.input, 12);
  assert.equal(parsed.usage.cumulative.total, 12 + 7 + 3 + 0 + 1);
});

test('get_agent_context: reads liveUsage live (mutation between exec calls is reflected)', async () => {
  const liveUsage = {
    lastTurn: undefined as
      | {
          input: number;
          output: number;
          cacheRead?: number;
          cacheWrite?: number;
          reasoning?: number;
        }
      | undefined,
    cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  };
  const c = ctx({ liveUsage });

  const first = JSON.parse((await getAgentContextTool.execute({}, c)).content);
  assert.equal(first.usage.lastTurn, null);

  // Simulate the loop updating the shared object mid-run.
  liveUsage.lastTurn = { input: 100, output: 50 };
  liveUsage.cumulative.input += 100;
  liveUsage.cumulative.output += 50;

  const second = JSON.parse((await getAgentContextTool.execute({}, c)).content);
  assert.equal(second.usage.lastTurn.input, 100);
  assert.equal(second.usage.cumulative.total, 150);
});
