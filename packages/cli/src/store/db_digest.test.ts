import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('session digest store', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-digest-test-'));
    process.env.CARETAKER_HOME = testHome;
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const digest = (over: Partial<import('./db.js').SessionDigest> = {}) => ({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    agentId: 'agent-1',
    lastMessageId: 'msg-9',
    messageCount: 9,
    summary: "A summary with 'quotes' and\nnewlines — must survive verbatim.",
    model: 'gpt-test',
    scannedAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '',
    ...over,
  });

  it('save + get round-trips, stamping updatedAt', async () => {
    await db.saveSessionDigest(digest());
    const got = await db.getSessionDigest('a1b2c3d4-0000-0000-0000-000000000001');
    assert.ok(got);
    assert.equal(got.summary, "A summary with 'quotes' and\nnewlines — must survive verbatim.");
    assert.equal(got.messageCount, 9);
    assert.notEqual(got.updatedAt, '');
  });

  it('save is an upsert: second save replaces, no duplicate rows', async () => {
    await db.saveSessionDigest(digest({ summary: 'v2', messageCount: 12 }));
    const all = await db.listSessionDigests();
    const mine = all.filter((d) => d.id === 'a1b2c3d4-0000-0000-0000-000000000001');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.summary, 'v2');
  });

  it('get of a missing or invalid id returns null', async () => {
    assert.equal(await db.getSessionDigest('a1b2c3d4-0000-0000-0000-00000000ffff'), null);
    assert.equal(await db.getSessionDigest("bad'id"), null);
  });

  it('delete removes the record and is idempotent', async () => {
    await db.deleteSessionDigest('a1b2c3d4-0000-0000-0000-000000000001');
    await db.deleteSessionDigest('a1b2c3d4-0000-0000-0000-000000000001');
    assert.equal(await db.getSessionDigest('a1b2c3d4-0000-0000-0000-000000000001'), null);
  });

  it('benchmark: 300 writes + 300 point reads + list (timings logged)', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      await db.saveSessionDigest(digest({ id: `bench-${i}`, summary: `summary ${i} `.repeat(50) }));
    }
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) {
      const got = await db.getSessionDigest(`bench-${i}`);
      assert.equal(got?.id, `bench-${i}`);
    }
    const t2 = performance.now();
    const all = await db.listSessionDigests();
    const t3 = performance.now();
    assert.ok(all.length >= 300);
    // The measurement that decides the SQLite switch — logged, never asserted (timing asserts flake).
    console.log(
      `[bench] session_digests: 300 writes ${(t1 - t0).toFixed(0)}ms | 300 point reads ${(t2 - t1).toFixed(0)}ms | list ${(t3 - t2).toFixed(0)}ms`
    );
  });
});
