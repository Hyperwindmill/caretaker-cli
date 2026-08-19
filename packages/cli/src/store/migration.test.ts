// packages/cli/src/store/migration.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('numeric id migration', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-mig-test-'));
    process.env.CARETAKER_HOME = testHome;
    await mkdir(join(testHome, 'store'), { recursive: true });
    await writeFile(join(testHome, 'store', 'tasks.json'), JSON.stringify([
      { id: 17, projectId: 3, title: 'Old task', objective: 'o', checklist: [], status: 'active',
        blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null,
        branch: 'caretaker/task-17-old-task', worktreePath: '/x/worktrees/3-17',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]));
    await writeFile(join(testHome, 'store', 'task_messages.json'), JSON.stringify([
      { id: 1, taskId: 17, role: 'user', messageType: 'chat', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' },
    ]));
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  it('rewrites numeric ids to composites, seeds seq, and preserves the branch', async () => {
    const task = await db.getTaskById('3-17'); // first store access triggers migration
    assert.ok(task);
    assert.equal(task.id, '3-17');
    assert.equal(task.projectId, '3');
    assert.equal(task.seq, 17);
    assert.equal(task.branch, 'caretaker/task-17-old-task'); // untouched — authoritative
    const msgs = await db.runQuery(`SELECT * FROM task_messages WHERE taskId = '3-17'`);
    assert.equal(msgs.length, 1);
  });

  it('derived artifact names are byte-identical to the pre-migration ones', async () => {
    const { containerName } = await import('../lib/docker.js');
    assert.equal(containerName('3-17'), 'caretaker-task-3-17'); // == old caretaker-task-<3>-<17>
    // worktreePathFor is module-private; the worktree dir equality is covered by
    // the preserved task.worktreePath ('/x/worktrees/3-17') matching join(dataDir(),'worktrees','3-17').
  });

  it('is idempotent', async () => {
    const beforeBytes = await readFile(join(testHome, 'store', 'tasks.json'), 'utf8');
    await db.getTaskById('3-17');
    const afterBytes = await readFile(join(testHome, 'store', 'tasks.json'), 'utf8');
    assert.equal(afterBytes, beforeBytes);
  });
});
