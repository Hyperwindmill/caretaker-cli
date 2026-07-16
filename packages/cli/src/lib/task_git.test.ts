import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const g = (cwd: string, args: string[]) => exec('git', args, { cwd });

// File-scope CARETAKER_HOME so worktrees land in a temp dir, never the dev store.
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-git-home-'));
process.env.CARETAKER_HOME = CT_HOME;

// Import AFTER setting the env var (dataDir() reads it at call time, but keep the order explicit).
const { isGitRepo, ensureWorktree, commitWip, finalizeDone, discardWorktree, agentDirIn } = await import(
  './task_git.js'
);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-repo-'));
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'test@example.com']);
  await g(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), '# repo\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('isGitRepo true inside a repo, false outside', async () => {
  const repo = await makeRepo();
  const plain = await mkdtemp(join(tmpdir(), 'ct-plain-'));
  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(plain), false);
  await rm(repo, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
});

test('ensureWorktree -> commitWip -> finalizeDone keeps branch, removes worktree', async () => {
  const repo = await makeRepo();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 1, 42, 'Do the Thing!');

  assert.equal(branch, 'caretaker/task-42-do-the-thing');
  assert.equal(agentWorkingDir, worktreePath); // project working dir == repo root

  // Agent produces work in the worktree.
  await writeFile(join(agentWorkingDir, 'out.txt'), 'hello\n');
  const committed = await commitWip(worktreePath, 'Do the Thing!');
  assert.equal(committed, true);

  // A second commit with a clean tree is a no-op.
  assert.equal(await commitWip(worktreePath, 'Do the Thing!'), false);

  // Commit is visible on the branch from the main repo.
  const log = await g(repo, ['log', '--oneline', branch]);
  assert.match(log.stdout, /wip: Do the Thing!/);

  await finalizeDone(worktreePath);

  // Worktree directory is gone...
  await assert.rejects(() => stat(worktreePath));
  // ...but the branch still exists.
  const branches = await g(repo, ['branch', '--list', branch]);
  assert.match(branches.stdout, /caretaker\/task-42-do-the-thing/);

  await rm(repo, { recursive: true, force: true });
});

test('discardWorktree commits pending work then removes the worktree', async () => {
  const repo = await makeRepo();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 1, 7, 'Abandon me');
  await writeFile(join(agentWorkingDir, 'wip.txt'), 'unsaved\n');

  await discardWorktree(worktreePath, 'Abandon me');

  await assert.rejects(() => stat(worktreePath));
  const log = await g(repo, ['log', '--oneline', branch]);
  assert.match(log.stdout, /wip: Abandon me/); // pending work was committed, not lost
  await rm(repo, { recursive: true, force: true });
});
