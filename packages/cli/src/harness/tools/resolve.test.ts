import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from './registry.js';
import { resolveAgentTools } from './resolve.js';
import type { Tool } from './types.js';
import type { AgentConfig } from '../../types.js';

// File-scope isolation: resolveAgentTools reads the config (memory-gated
// tier), so the whole file runs against a throwaway CARETAKER_HOME.
const testHome = mkdtempSync(join(tmpdir(), 'caretaker-resolve-test-'));
process.env.CARETAKER_HOME = testHome;
after(async () => {
  await rm(testHome, { recursive: true, force: true });
  delete process.env.CARETAKER_HOME;
});

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

test('resolveAgentTools: dispatch tools are gated by allowedTools (no silent always-on)', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('list_agents'));
  r.register(fakeTool('invoke_agent'));

  // Empty allowedTools → dispatch tools stay off. The UI exposes the
  // tri-state for them like any other tool; the runtime honours [ ] off.
  let tools = await resolveAgentTools(agent({ allowedTools: [] }), r);
  assert.deepEqual(tools.map((t) => t.name), []);

  // Explicit opt-in → both included.
  tools = await resolveAgentTools(
    agent({ allowedTools: ['invoke_agent', 'list_agents'] }),
    r,
  );
  assert.deepEqual(tools.map((t) => t.name).sort(), ['invoke_agent', 'list_agents']);
});

test('resolveAgentTools: get_agent_context is always-on (pure introspection)', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('get_agent_context'));

  const tools = await resolveAgentTools(agent({ allowedTools: [] }), r);
  assert.deepEqual(tools.map((t) => t.name), ['get_agent_context']);
});

test('resolveAgentTools: mcp__task__* wildcard resolves all task tools', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('mcp__task__get_state'));
  r.register(fakeTool('mcp__task__complete'));
  r.register(fakeTool('other_tool'));

  const tools = await resolveAgentTools(agent({ allowedTools: ['mcp__task__*'] }), r);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp__task__complete', 'mcp__task__get_state']);
});

test('resolveAgentTools: the namespace wildcard is generic and scoped to its namespace', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('mcp__task__complete'));
  r.register(fakeTool('mcp__email__email_send'));
  r.register(fakeTool('mcp__email__email_list_accounts'));

  const email = await resolveAgentTools(agent({ allowedTools: ['mcp__email__*'] }), r);
  assert.deepEqual(email.map((t) => t.name).sort(), [
    'mcp__email__email_list_accounts',
    'mcp__email__email_send',
  ]);

  const both = await resolveAgentTools(
    agent({ allowedTools: ['mcp__email__*', 'mcp__task__*'] }),
    r,
  );
  assert.equal(both.length, 3);
});

test('resolveAgentTools: memory_read stays off while memory is unconfigured', async () => {
  const r = new ToolRegistry();
  r.register(fakeTool('mcp__memory__memory_read'));

  const tools = await resolveAgentTools(agent({ allowedTools: [] }), r);
  assert.deepEqual(tools.map((t) => t.name), []);
});

test('resolveAgentTools: memory_read is auto-included when MemoryConfig is present', async () => {
  const { loadConfig, saveConfig } = await import('../../store/json.js');
  await saveConfig({ ...(await loadConfig()), memory: { agentId: 'mem-agent' } } as any);

  const r = new ToolRegistry();
  r.register(fakeTool('mcp__memory__memory_read'));

  const tools = await resolveAgentTools(agent({ allowedTools: [] }), r);
  assert.deepEqual(tools.map((t) => t.name), ['mcp__memory__memory_read']);

  // No duplicate when the agent had already opted the namespace in.
  const opted = await resolveAgentTools(agent({ allowedTools: ['mcp__memory__*'] }), r);
  assert.deepEqual(opted.map((t) => t.name), ['mcp__memory__memory_read']);
});
