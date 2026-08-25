import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../types.js';

let testHome: string;

const ctx = (): ToolContext => ({
  workingDir: process.cwd(),
  signal: new AbortController().signal,
  readPaths: new Set(),
});

describe('memory_read tool', () => {
  let tools: typeof import('./memory_tools.js');
  let db: typeof import('../../../store/db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-memtool-test-'));
    process.env.CARETAKER_HOME = testHome;
    tools = await import('./memory_tools.js');
    db = await import('../../../store/db.js');
    await db.saveMemory({
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
      projectId: '',
      kind: 'fact',
      importance: 'normal',
      title: 'Uses pnpm',
      body: 'The repo uses pnpm.',
      keywords: ['pnpm'],
      sourceSessionId: 's',
      sourceAgentId: 'a',
      model: 'm',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  it('returns bodies and reports unknown ids as missing', async () => {
    const res = await tools.memoryReadTool.execute(
      { ids: ['a1b2c3d4-0000-0000-0000-000000000001', 'a1b2c3d4-0000-0000-0000-00000000dead'] },
      ctx()
    );
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.memories[0].body, 'The repo uses pnpm.');
    assert.deepEqual(parsed.missing, ['a1b2c3d4-0000-0000-0000-00000000dead']);
  });

  it('each delivery bumps recall accounting', async () => {
    const m = (await db.listMemories())[0]!;
    assert.equal(m.recallCount, 1); // bumped by the previous test
    assert.ok(m.lastRecalledAt);
  });

  it('rejects an empty ids array', async () => {
    await assert.rejects(() => tools.memoryReadTool.execute({ ids: [] }, ctx()));
  });

  it('is registered and served over the builtin MCP prefix filter', async () => {
    const { tools: registry } = await import('../instance.js');
    const { builtinMcpTools, MEMORY_PREFIX } = await import('../../../mcp/builtin_server.js');
    assert.ok(registry.list().some((t) => t.name === 'mcp__memory__memory_read'));
    assert.ok(builtinMcpTools().some((t) => t.name === MEMORY_PREFIX + 'memory_read'));
  });
});
