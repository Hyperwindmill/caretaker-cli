import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import type { McpServerConfig, PluginRecord, PluginsFile } from '../types.js';

let testHome: string;

describe('syncManagedMcpServers', () => {
  let server_manager: typeof import('./server_manager.js');
  let store: typeof import('../store/json.js');
  let encryption: typeof import('../lib/encryption.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-mcpsync-'));
    process.env.CARETAKER_HOME = testHome;
    // Pin a stable encryption key so encrypted values round-trip through tests.
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    server_manager = await import('./server_manager.js');
    store = await import('../store/json.js');
    encryption = await import('../lib/encryption.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
    await rm(store.mcpServersPath(), { force: true });
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

  async function seedPlugins(plugins: PluginRecord[]): Promise<void> {
    const file: PluginsFile = { sources: [], plugins };
    await store.savePlugins(file);
  }

  it("creates a managed row for a plugin's stdio mcpServers entry", async () => {
    const p = pluginRecord({
      name: 'github-pack',
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    await seedPlugins([p]);

    await server_manager.syncManagedMcpServers();

    const file = await store.loadMcpServers();
    assert.equal(file.servers.length, 1);
    const row = file.servers[0];
    assert.equal(row.pluginId, p.id);
    assert.equal(row.pluginScopedName, 'github');
    assert.equal(row.transport, 'stdio');
    assert.equal(row.command, 'npx');
    assert.deepEqual(row.args, ['-y', '@modelcontextprotocol/server-github']);
    assert.equal(row.name, 'github-pack/github');
    assert.equal(row.enabled, true);
  });

  it('encrypts header values for http managed rows', async () => {
    const p = pluginRecord({
      name: 'remote-pack',
      mcpServers: {
        remote: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret' } },
      },
    });
    await seedPlugins([p]);

    await server_manager.syncManagedMcpServers();

    const file = await store.loadMcpServers();
    const row = file.servers[0];
    assert.equal(row.transport, 'http');
    assert.ok(row.headers);
    assert.ok(encryption.isEncrypted(row.headers!.Authorization), 'header value must be encrypted');
    assert.equal(encryption.decrypt(row.headers!.Authorization), 'Bearer secret');
  });

  it('is idempotent: same plugin state produces the same managed rows', async () => {
    const p = pluginRecord({
      name: 'p',
      mcpServers: { x: { command: 'echo', args: ['1'] } },
    });
    await seedPlugins([p]);

    await server_manager.syncManagedMcpServers();
    const first = (await store.loadMcpServers()).servers;
    const firstId = first[0].id;

    await server_manager.syncManagedMcpServers();
    const second = (await store.loadMcpServers()).servers;
    assert.equal(second.length, 1);
    // Row id is preserved across syncs (in-place update, not recreate).
    assert.equal(second[0].id, firstId);
  });

  it('updates managed row in place when the manifest spec changes', async () => {
    const p = pluginRecord({
      name: 'p',
      mcpServers: { x: { command: 'old', args: ['a'] } },
    });
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();
    const before = (await store.loadMcpServers()).servers[0];

    // Mutate the plugin spec and re-sync.
    p.mcpServers = { x: { command: 'new', args: ['b', 'c'] } };
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();

    const after = (await store.loadMcpServers()).servers;
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before.id, 'row id preserved across spec change');
    assert.equal(after[0].command, 'new');
    assert.deepEqual(after[0].args, ['b', 'c']);
  });

  it('drops a managed row when its plugin no longer declares the entry', async () => {
    const p = pluginRecord({
      name: 'p',
      mcpServers: {
        a: { command: 'echo', args: ['a'] },
        b: { command: 'echo', args: ['b'] },
      },
    });
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();
    assert.equal((await store.loadMcpServers()).servers.length, 2);

    p.mcpServers = { a: { command: 'echo', args: ['a'] } };
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();

    const after = (await store.loadMcpServers()).servers;
    assert.equal(after.length, 1);
    assert.equal(after[0].pluginScopedName, 'a');
  });

  it('drops all managed rows when the plugin disappears', async () => {
    const p = pluginRecord({
      name: 'p',
      mcpServers: { x: { command: 'echo' } },
    });
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();
    assert.equal((await store.loadMcpServers()).servers.length, 1);

    await seedPlugins([]);
    await server_manager.syncManagedMcpServers();

    assert.equal((await store.loadMcpServers()).servers.length, 0);
  });

  it('preserves user-authored rows across sync', async () => {
    // Pre-existing user row with no pluginId.
    const userRow: McpServerConfig = {
      id: randomUUID(),
      name: 'my-stdio',
      transport: 'stdio',
      enabled: true,
      command: 'node',
      args: ['my-server.js'],
      lastConnectedAt: null,
      lastConnectError: null,
    };
    await store.saveMcpServers({ servers: [userRow] });

    const p = pluginRecord({
      name: 'p',
      mcpServers: { x: { command: 'echo' } },
    });
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();

    const after = (await store.loadMcpServers()).servers;
    assert.equal(after.length, 2);
    const preserved = after.find((s) => s.id === userRow.id);
    assert.ok(preserved, 'user row was wiped');
    assert.equal(preserved!.command, 'node');
    assert.equal(preserved!.pluginId, undefined);
  });

  it('preserves the user-toggled `enabled` value across re-sync', async () => {
    const p = pluginRecord({
      name: 'p',
      mcpServers: { x: { command: 'echo' } },
    });
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();

    // User disables the managed row.
    const before = (await store.loadMcpServers()).servers;
    const patched = await server_manager.patchMcpServer(before[0].id, { enabled: false });
    assert.ok(patched);
    assert.equal(patched!.enabled, false);

    // A fresh sync (e.g. after a no-op refresh) must NOT re-enable the row.
    await server_manager.syncManagedMcpServers();
    const after = (await store.loadMcpServers()).servers;
    assert.equal(after.length, 1);
    assert.equal(after[0].enabled, false);
  });

  it('patchMcpServer rejects edits to managed rows except `enabled`', async () => {
    const p = pluginRecord({
      name: 'p',
      mcpServers: { x: { command: 'echo' } },
    });
    await seedPlugins([p]);
    await server_manager.syncManagedMcpServers();
    const row = (await store.loadMcpServers()).servers[0];

    const patched = await server_manager.patchMcpServer(row.id, {
      name: 'renamed',
      command: 'rm',
      enabled: false,
    });
    assert.ok(patched);
    // Only `enabled` took effect.
    assert.equal(patched!.enabled, false);
    assert.equal(patched!.name, row.name);
    assert.equal(patched!.command, row.command);
  });

  describe('agent-ref pruning', () => {
    function agentRecord(name: string, mcpServers: string[]) {
      return {
        id: randomUUID(),
        name,
        systemPrompt: '',
        provider: 'p',
        model: 'm',
        allowedTools: [],
        maxTurns: 5,
        mcpServers,
      };
    }

    it('pruneAgentMcpRefs strips removed ids from every agent that references them', async () => {
      const goneA = randomUUID();
      const goneB = randomUUID();
      const kept = randomUUID();
      await store.saveAgents([
        agentRecord('a', [goneA, kept]),
        agentRecord('b', [goneB]),
        agentRecord('c', [kept]),
      ]);

      const touched = await server_manager.pruneAgentMcpRefs([goneA, goneB]);
      assert.equal(touched, 2);

      const after = await store.loadAgents();
      assert.deepEqual(after.find((a) => a.name === 'a')!.mcpServers, [kept]);
      assert.deepEqual(after.find((a) => a.name === 'b')!.mcpServers, []);
      assert.deepEqual(after.find((a) => a.name === 'c')!.mcpServers, [kept]);
    });

    it('pruneAgentMcpRefs is a no-op when nothing matches', async () => {
      await store.saveAgents([agentRecord('a', ['x'])]);
      const touched = await server_manager.pruneAgentMcpRefs(['y', 'z']);
      assert.equal(touched, 0);
      const after = await store.loadAgents();
      assert.deepEqual(after[0].mcpServers, ['x']);
    });

    it('deleteMcpServer also prunes referencing agents', async () => {
      const created = await server_manager.createMcpServer({
        name: 's',
        transport: 'stdio',
        command: 'echo',
      });
      await store.saveAgents([
        agentRecord('a', [created.id, 'other']),
        agentRecord('b', ['other']),
      ]);

      const ok = await server_manager.deleteMcpServer(created.id);
      assert.equal(ok, true);

      const after = await store.loadAgents();
      assert.deepEqual(after.find((a) => a.name === 'a')!.mcpServers, ['other']);
      assert.deepEqual(after.find((a) => a.name === 'b')!.mcpServers, ['other']);
    });

    it('syncManagedMcpServers prunes agent refs to removed managed rows', async () => {
      // Seed a plugin with one managed server.
      const p1 = pluginRecord({
        name: 'p1',
        mcpServers: { srv: { command: 'echo' } },
      });
      await seedPlugins([p1]);
      await server_manager.syncManagedMcpServers();
      const managedId = (await store.loadMcpServers()).servers[0].id;

      // Wire an agent to it.
      await store.saveAgents([agentRecord('a', [managedId, 'other'])]);

      // Plugin's manifest entry disappears → sync drops the managed row.
      const p1Stripped = { ...p1, mcpServers: {} };
      await seedPlugins([p1Stripped]);
      await server_manager.syncManagedMcpServers();

      assert.equal((await store.loadMcpServers()).servers.length, 0);
      const after = await store.loadAgents();
      assert.deepEqual(after[0].mcpServers, ['other']);
    });
  });
});
