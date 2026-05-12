import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './registry.js';
import { resolveAgentTools } from './resolve.js';
import type { Tool } from './types.js';
import type { AgentConfig } from '../../types.js';

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: name };
    },
  };
}

function agent(over: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a',
    name: 'a',
    systemPrompt: '',
    provider: 'p',
    model: 'm',
    allowedTools: [],
    maxTurns: 30,
    ...over,
  };
}

test('resolveAgentTools: filters by allowedTools when no plugins', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('read_file'));
  r.register(fakeTool('list_skills'));
  r.register(fakeTool('read_skill'));

  const tools = await resolveAgentTools(agent({ allowedTools: ['read_file'] }), r);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['read_file'],
  );
});

test('resolveAgentTools: auto-includes skill tools when plugins are active', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('read_file'));
  r.register(fakeTool('list_skills'));
  r.register(fakeTool('read_skill'));

  const tools = await resolveAgentTools(
    agent({ allowedTools: ['read_file'], plugins: ['my-skill'] }),
    r,
  );
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_skills', 'read_file', 'read_skill']);
});

test('resolveAgentTools: does not duplicate when allowedTools already lists skill tools', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('list_skills'));
  r.register(fakeTool('read_skill'));

  const tools = await resolveAgentTools(
    agent({ allowedTools: ['list_skills', 'read_skill'], plugins: ['x'] }),
    r,
  );
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_skills', 'read_skill']);
});

test('resolveAgentTools: no skill tools when registry lacks them', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('read_file'));

  const tools = await resolveAgentTools(agent({ allowedTools: ['read_file'], plugins: ['x'] }), r);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['read_file'],
  );
});

test('resolveAgentTools: dispatch tools auto-included regardless of agent count (anonymous mode is always valid)', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('list_agents'));
  r.register(fakeTool('invoke_agent'));
  // No other agents configured anywhere — the previous gate would have
  // hidden the dispatch tools, blocking the agent from using anonymous
  // sub-agent dispatch (`invoke_agent({task})`).
  const tools = await resolveAgentTools(agent({ allowedTools: [] }), r);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['invoke_agent', 'list_agents']);
});

test('resolveAgentTools: get_agent_context is always-on too', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('get_agent_context'));
  const tools = await resolveAgentTools(agent({ allowedTools: [] }), r);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['get_agent_context'],
  );
});
