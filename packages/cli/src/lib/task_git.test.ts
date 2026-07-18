import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, chmod } from 'node:fs/promises';
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
const { isGitRepo, ensureWorktree, commitWip, finalizeDone, discardWorktree, agentDirIn, runBootstrap } =
  await import('./task_git.js');

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

test('runBootstrap runs commands in order and stops at the first failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-boot-'));

  // Success path: both commands run, second one's file proves order.
  await runBootstrap(dir, ['echo a > a.txt', 'echo b > b.txt']);
  assert.ok((await stat(join(dir, 'a.txt'))).isFile());
  assert.ok((await stat(join(dir, 'b.txt'))).isFile());

  // Failure path: the failing command aborts before the third runs.
  await assert.rejects(
    () => runBootstrap(dir, ['echo ok > ok.txt', 'exit 3', 'echo never > never.txt']),
    /Bootstrap command failed/,
  );
  assert.ok((await stat(join(dir, 'ok.txt'))).isFile());
  await assert.rejects(() => stat(join(dir, 'never.txt')));

  await rm(dir, { recursive: true, force: true });
});

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
  assert.match(log.stdout, /chore\(auto\): Do the Thing!/);

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
  assert.match(log.stdout, /chore\(auto\): Abandon me/); // pending work was committed, not lost
  await rm(repo, { recursive: true, force: true });
});

test('commitWip bypasses a failing pre-commit hook and works without configured identity', async () => {
  // Start from a normal repo (needs identity for the initial commit)...
  const repo = await makeRepo();
  // ...then make every future commit hostile: a hook that always rejects, and no identity.
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  await g(repo, ['config', '--unset', 'user.email']);
  await g(repo, ['config', '--unset', 'user.name']);

  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 2, 5, 'Hook hostile');
  await writeFile(join(agentWorkingDir, 'out.txt'), 'work\n');

  // Without --no-verify (hook) and without a fallback identity this commit would fail.
  assert.equal(await commitWip(worktreePath, 'Hook hostile'), true);
  const log = await g(repo, ['log', '--oneline', branch]);
  assert.match(log.stdout, /chore\(auto\): Hook hostile/);

  await finalizeDone(worktreePath);
  await rm(repo, { recursive: true, force: true });
});

test('runBootstrap uses the probed shell environment (PATH) for commands', async () => {
  // Directly populate the shell-env cache as if probeShellEnv() had run, so a
  // binary that only exists on the probed PATH is found by runBootstrap.
  const { setShellEnvForTest } = await import('../harness/tools/builtin/shell-env.js');
  const binDir = await mkdtemp(join(tmpdir(), 'ct-path-'));
  // A fake "pnpm" that just writes a marker file into the cwd.
  const fakePnpm = join(binDir, 'pnpm');
  await writeFile(fakePnpm, '#!/bin/sh\necho ran > marker.txt\n');
  await chmod(fakePnpm, 0o755);

  const dir = await mkdtemp(join(tmpdir(), 'ct-boot-env-'));
  // On Linux the probed PATH is prepended, so a bare `pnpm` resolves to our shim.
  // On macOS/Windows the probe is a no-op, so skip there (no probed PATH to honour).
  if (process.platform === 'linux') {
    setShellEnvForTest({ PATH: binDir });
    try {
      await runBootstrap(dir, ['pnpm install']);
      assert.ok((await stat(join(dir, 'marker.txt'))).isFile());
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    await rm(binDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
