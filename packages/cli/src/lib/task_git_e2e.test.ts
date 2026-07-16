import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const g = (cwd: string, args: string[]) => exec('git', args, { cwd });

// File-scope CARETAKER_HOME
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-e2e-home-'));
process.env.CARETAKER_HOME = CT_HOME;

// Imports
const { saveConfig, saveAgents } = await import('../store/json.js');
const { createTask, getTaskById, saveTask, getDb } = await import('../store/db.js');
const { runTaskHeartbeatTick } = await import('../cli/web/scheduler/task_strategy.js');
const { discardWorktree } = await import('./task_git.js');
const { __setFetch, __resetFetch } = await import('../harness/loop.js');

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-e2e-repo-'));
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'test@example.com']);
  await g(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), '# repo\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function mockFetchResponse(content: string): Response {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`,
    `data: [DONE]\n`
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

async function clearDb(db: any) {
  const tasks = (await db.query('SELECT * FROM tasks')) as any[];
  for (const t of tasks) {
    await db.query(`DELETE FROM tasks WHERE id = ${t.id}`);
  }
  const messages = (await db.query('SELECT * FROM task_messages')) as any[];
  for (const m of messages) {
    await db.query(`DELETE FROM task_messages WHERE id = ${m.id}`);
  }
}

test('End-to-end task heartbeat worktree lifecycle', async () => {
  const db = getDb();
  await clearDb(db);
  const repo = await makeRepo();

  // Setup config
  await saveConfig({
    port: 3000,
    providers: [
      {
        name: 'mock-provider',
        endpoint: 'http://localhost:8000',
        apiKey: 'test-key',
      },
    ],
    projects: [
      {
        id: 101,
        name: 'E2E Git Project',
        description: 'Test project',
        workingDir: repo,
        agentId: 'mock-agent',
        active: true,
      },
    ],
  });

  await saveAgents([
    {
      id: 'mock-agent',
      name: 'Mock Agent',
      systemPrompt: 'You are a mock agent.',
      provider: 'mock-provider',
      model: 'mock-model',
      allowedTools: [],
      maxTurns: 30,
    },
  ]);

  // Create a task
  const task = await createTask({
    projectId: 101,
    title: 'E2E Task Title',
    objective: 'Create a test file',
    checklist: [
      { id: '1', text: 'Step 1', status: 'pending', order: 0 },
    ],
    status: 'active',
    blockedReason: null,
    noProgressCount: 0,
    maxNoProgress: 5,
    lockedAt: null,
  });

  // Mock fetch to simulate agent behavior
  __setFetch(async () => {
    await writeFile(join(CT_HOME, 'worktrees', '101-1', 'work.txt'), 'done');
    return mockFetchResponse('Mock agent output text.');
  });

  try {
    // Run the heartbeat tick
    await runTaskHeartbeatTick(new Date());

    // Fetch refreshed task
    const refreshed = await getTaskById(task.id);
    assert.ok(refreshed, 'Task should exist');
    assert.ok(refreshed.worktreePath, 'worktreePath should be set');
    assert.ok(refreshed.branch, 'branch should be set');

    // Verify worktree exists on filesystem
    const wtStat = await stat(refreshed.worktreePath);
    assert.ok(wtStat.isDirectory(), 'worktree path should be a directory');

    // Verify worktree registered in git
    const wts = await g(repo, ['worktree', 'list']);
    assert.match(wts.stdout, new RegExp(refreshed.worktreePath));

    // Verify the commit was made (because compile/wip commits on each heartbeat tick)
    const log = await g(repo, ['log', '--oneline', refreshed.branch]);
    assert.match(log.stdout, /wip: E2E Task Title/);

    // Now, manually discard the worktree
    await discardWorktree(refreshed.worktreePath, refreshed.title);

    // Verify worktree path is gone
    await assert.rejects(() => stat(refreshed!.worktreePath!));

    // Verify git worktree list doesn't contain it
    const wtsAfter = await g(repo, ['worktree', 'list']);
    assert.ok(!wtsAfter.stdout.includes(refreshed.worktreePath!));

    // Verify branch still exists
    const branches = await g(repo, ['branch', '--list', refreshed.branch]);
    assert.match(branches.stdout, new RegExp(refreshed.branch));

  } finally {
    __resetFetch();
    await rm(repo, { recursive: true, force: true });
  }
});

async function seedReviewingTask(): Promise<{ repo: string; taskId: number }> {
  const db = getDb();
  await clearDb(db);
  await rm(join(CT_HOME, 'worktrees'), { recursive: true, force: true });
  const repo = await makeRepo();
  await saveConfig({
    port: 3000,
    providers: [{ name: 'mock-provider', endpoint: 'http://localhost:8000', apiKey: 'test-key' }],
    projects: [{ id: 202, name: 'Review Project', description: '', workingDir: repo, agentId: 'mock-agent', active: true }],
  });
  await saveAgents([{ id: 'mock-agent', name: 'Mock', systemPrompt: 'mock', provider: 'mock-provider', model: 'mock-model', allowedTools: [], maxTurns: 30 }]);

  const task = await createTask({
    projectId: 202, title: 'Review Task', objective: 'Do the thing',
    checklist: [{ id: '1', text: 'Step 1', status: 'pending', order: 0 }],
    status: 'active', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null,
  });

  // One active tick creates the worktree + branch (agent just writes a file).
  __setFetch(async () => {
    const wtPath = join(CT_HOME, 'worktrees', `202-${task.id}`);
    await writeFile(join(wtPath, 'work.txt'), 'working');
    return mockFetchResponse('working');
  });
  await runTaskHeartbeatTick(new Date());

  // Advance to reviewing (as task_complete would for a git task).
  const t = await getTaskById(task.id);
  t!.status = 'reviewing';
  t!.lockedAt = null;
  await saveTask(t!);
  return { repo, taskId: task.id };
}

test('reviewing tick: PASS verdict finalizes to done and removes the worktree', async () => {
  const { repo, taskId } = await seedReviewingTask();
  __setFetch(async () => mockFetchResponse('All good.\nREVIEW_RESULT: PASS'));
  try {
    await runTaskHeartbeatTick(new Date());
    const after = await getTaskById(taskId);
    assert.equal(after!.status, 'done');
    assert.equal(after!.worktreePath, null);
    assert.ok(after!.branch, 'branch is kept');
  } finally {
    __resetFetch();
    await rm(repo, { recursive: true, force: true });
  }
});

test('reviewing tick: CHANGES_REQUESTED reopens to active and keeps the worktree', async () => {
  const { repo, taskId } = await seedReviewingTask();
  __setFetch(async () => mockFetchResponse('Bug on line 4.\nREVIEW_RESULT: CHANGES_REQUESTED'));
  try {
    await runTaskHeartbeatTick(new Date());
    const after = await getTaskById(taskId);
    assert.equal(after!.status, 'active');
    assert.ok(after!.worktreePath, 'worktree is kept for the fix cycle');
  } finally {
    __resetFetch();
    await rm(repo, { recursive: true, force: true });
  }
});

test.after(async () => {
  await rm(CT_HOME, { recursive: true, force: true });
});

