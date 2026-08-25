import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../store/db.js';

let testHome: string;

describe('memory recall', () => {
  let recall: typeof import('./memory_recall.js');
  let db: typeof import('../store/db.js');
  let json: typeof import('../store/json.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-recall-test-'));
    process.env.CARETAKER_HOME = testHome;
    recall = await import('./memory_recall.js');
    db = await import('../store/db.js');
    json = await import('../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const mem = (over: Partial<Memory>): Memory => ({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    projectId: '',
    kind: 'fact',
    importance: 'normal',
    title: 'Uses pnpm',
    body: 'body',
    keywords: ['pnpm'],
    sourceSessionId: 's',
    sourceAgentId: 'a',
    model: 'm',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  });

  describe('matchMemories', () => {
    it('inverted match: keyword contained in the prompt, case-insensitive', () => {
      const m = mem({ keywords: ['pnpm', 'memory sweep'] });
      assert.deepEqual(recall.matchMemories('how does the Memory Sweep work?', [m]), [m]);
      assert.deepEqual(recall.matchMemories('unrelated prompt', [m]), []);
    });

    it('ignores keywords shorter than MIN_KEYWORD_LENGTH', () => {
      const m = mem({ keywords: ['ab'] });
      assert.deepEqual(recall.matchMemories('ab initio', [m]), []);
    });

    it('a single word of a multi-word keyword matches on its own', () => {
      const m = mem({ keywords: ['reaper linux'] });
      assert.deepEqual(recall.matchMemories('come configuro reaper?', [m]), [m]);
    });

    it('the full phrase scores higher than one of its words', () => {
      const partial = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000a', keywords: ['memory sweep'] });
      const full = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000b', keywords: ['memory sweep'] });
      const one = recall.matchMemories('how does the sweep work?', [partial]);
      const both = recall.matchMemories('how does the memory sweep work?', [full, partial]);
      assert.equal(one.length, 1);
      assert.equal(both.length, 2); // both match, full phrase = 2 words matched
    });

    it('dedups overlapping words across keywords of the same memory', () => {
      const a = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000a', keywords: ['sweep', 'memory sweep'] });
      const b = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000b', keywords: ['memory', 'sweep'] });
      // Same effective word set {memory, sweep} → same score, no double count of 'sweep'.
      const out = recall.matchMemories('the memory sweep', [a, b]);
      assert.equal(out.length, 2);
    });

    it('short words inside a multi-word keyword are still ignored', () => {
      const m = mem({ keywords: ['ui di gtdj'] });
      assert.deepEqual(recall.matchMemories('parliamo di questo', [m]), []); // 'di' too short
      assert.deepEqual(recall.matchMemories('la ui nuova', [m]), []); // 'ui' too short
      assert.deepEqual(recall.matchMemories('lo skin di gtdj', [m]), [m]); // 'gtdj' fires
    });

    it('scores by matched count × importance × recall strength', () => {
      const weak = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000a', keywords: ['docker'], importance: 'low' });
      const strong = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000b', keywords: ['docker'], importance: 'high' });
      const recalled = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000c', keywords: ['docker'], importance: 'low', recallCount: 7 });
      const out = recall.matchMemories('docker question', [weak, strong, recalled]);
      // high (2) > low×(1+log2(8))=0.5×4=2 → tie broken by lastRecalledAt/createdAt; both beat plain low (0.5)
      assert.equal(out[out.length - 1]!.id, weak.id);
      assert.equal(out.length, 3);
    });

    it('recallCount raises rank at equal importance', () => {
      const a = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000a', keywords: ['docker'] });
      const b = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000b', keywords: ['docker'], recallCount: 3 });
      const out = recall.matchMemories('docker', [a, b]);
      assert.equal(out[0]!.id, b.id);
    });

    it('caps at RECALL_TOP_K', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        mem({ id: `a1b2c3d4-0000-0000-0000-00000000010${i}`, keywords: ['docker'] })
      );
      assert.equal(recall.matchMemories('docker', many).length, recall.RECALL_TOP_K);
    });
  });

  describe('formatMemoriesBlock', () => {
    it('empty matches → empty string', () => {
      assert.equal(recall.formatMemoriesBlock([]), '');
    });

    it('one line per memory with id, title, kind, importance', () => {
      const block = recall.formatMemoriesBlock([mem({ importance: 'high' })]);
      assert.ok(block.startsWith('<memories>'));
      assert.ok(block.endsWith('</memories>'));
      assert.ok(block.includes('- a1b2c3d4-0000-0000-0000-000000000001 — Uses pnpm (fact, high)'));
      assert.ok(block.includes('memory_read'));
      assert.ok(!block.includes('body')); // titles only, never bodies
    });
  });

  describe('buildMemoriesBlock', () => {
    it("'' when memory is not configured", async () => {
      await db.saveMemory(mem({}));
      assert.equal(await recall.buildMemoriesBlock('pnpm question', '/nowhere'), '');
    });

    it('matches global + resolved-project memories, excludes other projects', async () => {
      const config = await json.loadConfig();
      await json.saveConfig({
        ...config,
        projects: [
          { id: 'proj-a', name: 'A', workingDir: '/tmp/proj-a' },
          { id: 'proj-b', name: 'B', workingDir: '/tmp/proj-b' },
        ],
        memory: { agentId: 'mem-agent' },
      } as any);
      await db.saveMemory(mem({ id: 'a1b2c3d4-0000-0000-0000-000000000002', projectId: 'proj-a', title: 'A-fact', keywords: ['pnpm'] }));
      await db.saveMemory(mem({ id: 'a1b2c3d4-0000-0000-0000-000000000003', projectId: 'proj-b', title: 'B-fact', keywords: ['pnpm'] }));
      const block = await recall.buildMemoriesBlock('pnpm question', '/tmp/proj-a/src');
      assert.ok(block.includes('Uses pnpm')); // global
      assert.ok(block.includes('A-fact'));    // resolved project
      assert.ok(!block.includes('B-fact'));   // other project excluded
    });

    it("'' when nothing matches", async () => {
      assert.equal(await recall.buildMemoriesBlock('completely unrelated', '/tmp/proj-a'), '');
    });

    it('explicit projectId overrides dir resolution (task worktree case)', async () => {
      const worktree = '/tmp/not-a-project-dir/worktrees/t-1';
      const block = await recall.buildMemoriesBlock('pnpm question', worktree, 'proj-b');
      assert.ok(block.includes('Uses pnpm')); // global still included
      assert.ok(block.includes('B-fact'));    // explicit scope wins
      assert.ok(!block.includes('A-fact'));   // dir-based match not consulted
    });

    it('absent override keeps dir resolution intact', async () => {
      const block = await recall.buildMemoriesBlock('pnpm question', '/tmp/proj-b');
      assert.ok(block.includes('B-fact'));
      assert.ok(!block.includes('A-fact'));
    });
  });
});
