import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('memory store', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-memory-test-'));
    process.env.CARETAKER_HOME = testHome;
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const mem = (over: Partial<import('./db.js').Memory> = {}): import('./db.js').Memory => ({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    projectId: '',
    kind: 'fact',
    importance: 'normal',
    title: 'Uses pnpm',
    body: "The repo uses **pnpm** ≥10 — with 'quotes' and\nnewlines that must survive.",
    keywords: ['pnpm', 'package-manager'],
    sourceSessionId: 'f0e1d2c3-0000-0000-0000-000000000009',
    sourceAgentId: 'ag-1',
    model: 'gpt-test',
    createdAt: '2026-08-24T10:00:00.000Z',
    ...over,
  });

  it('save + list round-trips verbatim', async () => {
    await db.saveMemory(mem());
    const all = await db.listMemories();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], mem());
  });

  it('is append-only: a second save with a new id adds a record', async () => {
    await db.saveMemory(mem({ id: 'a1b2c3d4-0000-0000-0000-000000000002', projectId: 'proj-x' }));
    const all = await db.listMemories();
    assert.equal(all.length, 2);
    assert.ok(all.some((m) => m.projectId === 'proj-x'));
  });

  it('rejects a non-safeId id', async () => {
    await assert.rejects(() => db.saveMemory(mem({ id: "bad'id" })));
  });

  it('delete removes one record and is idempotent', async () => {
    await db.deleteMemory('a1b2c3d4-0000-0000-0000-000000000002');
    await db.deleteMemory('a1b2c3d4-0000-0000-0000-000000000002');
    const all = await db.listMemories();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, 'a1b2c3d4-0000-0000-0000-000000000001');
  });

  it('bumpMemoryRecall increments recallCount and sets lastRecalledAt', async () => {
    const id = 'a1b2c3d4-0000-0000-0000-000000000001';
    await db.bumpMemoryRecall(id);
    let m = (await db.listMemories()).find((x) => x.id === id)!;
    assert.equal(m.recallCount, 1); // absent field treated as 0
    assert.ok(m.lastRecalledAt);
    assert.equal(m.title, 'Uses pnpm'); // rest of the record untouched
    await db.bumpMemoryRecall(id);
    m = (await db.listMemories()).find((x) => x.id === id)!;
    assert.equal(m.recallCount, 2);
  });

  it('bumpMemoryRecall is a no-op on unknown or invalid ids', async () => {
    await db.bumpMemoryRecall('a1b2c3d4-0000-0000-0000-00000000dead');
    await db.bumpMemoryRecall("bad'id");
    const all = await db.listMemories();
    assert.equal(all.length, 1);
  });
});

