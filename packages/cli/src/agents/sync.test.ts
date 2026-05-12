import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentConfig, AgentSpec, CaretakerConfig, PluginRecord } from '../types.js';

let testHome: string;

describe('syncManagedAgents', () => {
  let sync: typeof import('./sync.js');
  let store: typeof import('../store/json.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-agentsync-'));
    process.env.CARETAKER_HOME = testHome;
    sync = await import('./sync.js');
    store = await import('../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
    await rm(store.agentsPath(), { force: true });
    await rm(store.configPath(), { force: true });
  });

  function pluginRecord(over: Partial<PluginRecord>): PluginRecord {
    return {
      id: randomUUID(),
      sourceId: randomUUID(),
      name: 'p',
      description: null,
      manifestKind: 'cc-plugin',
      relPath: '.',
      rawManifest: {},
      ...over,
    };
  }

  async function seedPlugins(plugins: PluginRecord[]) {
    await store.savePlugins({ sources: [], plugins });
  }

  async function seedConfig(providers: { name: string; endpoint: string }[]) {
    const cfg: CaretakerConfig = { port: 17777, providers };
    await store.saveConfig(cfg);
  }

  it('creates a managed agent from agents/*.md frontmatter+body', async () => {
    await seedConfig([{ name: 'anthropic', endpoint: 'https://x' }]);
    const spec: AgentSpec = {
      name: 'security-auditor',
      description: 'OWASP',
      model: 'sonnet',
      systemPrompt: 'You are an auditor.',
    };
    const p = pluginRecord({ name: 'code-modernization', agents: { 'security-auditor': spec } });
    await seedPlugins([p]);

    await sync.syncManagedAgents();

    const agents = await store.loadAgents();
    assert.equal(agents.length, 1);
    const row = agents[0];
    assert.equal(row.pluginId, p.id);
    assert.equal(row.pluginScopedName, 'security-auditor');
    assert.equal(row.name, 'code-modernization/security-auditor');
    assert.equal(row.systemPrompt, 'You are an auditor.');
    assert.equal(row.model, 'sonnet');
    assert.equal(row.provider, 'anthropic');
    assert.deepEqual(row.allowedTools, []);
  });

  it('provider stays empty when no provider is configured', async () => {
    const p = pluginRecord({
      name: 'p',
      agents: { x: { name: 'x', systemPrompt: 'body' } },
    });
    await seedPlugins([p]);
    await sync.syncManagedAgents();
    const agents = await store.loadAgents();
    assert.equal(agents[0].provider, '');
  });

  it('re-sync rewrites name + systemPrompt; preserves user-controlled fields', async () => {
    await seedConfig([{ name: 'anthropic', endpoint: 'https://x' }]);
    const p = pluginRecord({
      name: 'p',
      agents: { x: { name: 'x', systemPrompt: 'v1' } },
    });
    await seedPlugins([p]);
    await sync.syncManagedAgents();
    const before = (await store.loadAgents())[0];

    // User edits provider, model, allowedTools, plugins, mcpServers, workingDir, maxTurns.
    const userTouched: AgentConfig = {
      ...before,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      allowedTools: ['read_file', 'bash'],
      plugins: ['some-plugin'],
      mcpServers: ['some-mcp'],
      workingDir: '/tmp',
      maxTurns: 7,
    };
    await store.saveAgents([userTouched]);

    // Plugin manifest changes systemPrompt.
    p.agents = { x: { name: 'x', systemPrompt: 'v2' } };
    await seedPlugins([p]);
    await sync.syncManagedAgents();

    const after = (await store.loadAgents())[0];
    assert.equal(after.id, before.id, 'id preserved');
    assert.equal(after.systemPrompt, 'v2', 'systemPrompt rewritten from manifest');
    assert.equal(after.name, 'p/x', 'name rewritten from manifest');
    // User edits preserved across sync.
    assert.equal(after.model, 'claude-opus-4-7');
    assert.deepEqual(after.allowedTools, ['read_file', 'bash']);
    assert.deepEqual(after.plugins, ['some-plugin']);
    assert.deepEqual(after.mcpServers, ['some-mcp']);
    assert.equal(after.workingDir, '/tmp');
    assert.equal(after.maxTurns, 7);
  });

  it('drops a managed row when the plugin disappears', async () => {
    const p = pluginRecord({
      name: 'p',
      agents: { x: { name: 'x', systemPrompt: 'body' } },
    });
    await seedPlugins([p]);
    await sync.syncManagedAgents();
    assert.equal((await store.loadAgents()).length, 1);

    await seedPlugins([]);
    await sync.syncManagedAgents();
    assert.equal((await store.loadAgents()).length, 0);
  });

  it('preserves user-authored agents across sync', async () => {
    const userAgent: AgentConfig = {
      id: randomUUID(),
      name: 'my-own',
      systemPrompt: 'mine',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      allowedTools: [],
      maxTurns: 30,
    };
    await store.saveAgents([userAgent]);

    const p = pluginRecord({
      name: 'p',
      agents: { x: { name: 'x', systemPrompt: 'body' } },
    });
    await seedPlugins([p]);
    await sync.syncManagedAgents();

    const agents = await store.loadAgents();
    assert.equal(agents.length, 2);
    const preserved = agents.find((a) => a.id === userAgent.id);
    assert.ok(preserved);
    assert.equal(preserved!.systemPrompt, 'mine');
    assert.equal(preserved!.pluginId, undefined);
  });
});
