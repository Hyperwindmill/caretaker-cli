import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, chmod, mkdir } from 'node:fs/promises';
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
const {
  isGitRepo,
  ensureWorktree,
  commitWip,
  finalizeDone,
  discardWorktree,
  agentDirIn,
  runBootstrap,
  pushBranch,
  gitAuthArgs,
  gitAuthEnv,
  projectWorkingDir,
  managedRepoDir,
  projectRepoStatus,
  syncProjectRepo,
} = await import('./task_git.js');

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
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, '1-42', 'Do the Thing!');

  assert.equal(branch, 'caretaker/task-1-42-do-the-thing');
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
  assert.match(branches.stdout, /caretaker\/task-1-42-do-the-thing/);

  await rm(repo, { recursive: true, force: true });
});

test('discardWorktree commits pending work then removes the worktree', async () => {
  const repo = await makeRepo();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, '1-7', 'Abandon me');
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

  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, '2-5', 'Hook hostile');
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

async function makeBareOrigin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-origin-'));
  await g(dir, ['init', '-q', '--bare', '-b', 'main']);
  return dir;
}

test('gitAuthArgs/gitAuthEnv keep the token off argv and in the env', async () => {
  const { encrypt } = await import('./encryption.js');

  assert.deepEqual(gitAuthArgs(false), []);
  const args = gitAuthArgs(true);
  // Clears configured helpers first, then installs ours.
  assert.equal(args[1], 'credential.helper=');
  assert.match(args[3], /^credential\.helper=!f\(\)/);
  assert.ok(!args.join(' ').includes('tok-plain'), 'token must never be an argument');

  const env = gitAuthEnv('tok-plain');
  assert.equal(env.CARETAKER_GIT_TOKEN, 'tok-plain');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  // Encrypted blobs are decrypted at use time.
  assert.equal(gitAuthEnv(encrypt('tok-enc')).CARETAKER_GIT_TOKEN, 'tok-enc');
  // No token: still non-interactive, no env var.
  const bare = gitAuthEnv(null);
  assert.equal(bare.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!('CARETAKER_GIT_TOKEN' in bare));
});

test('git operations refuse a remote URL carrying embedded credentials', async () => {
  // Entry-point validation is UX; this is the enforcement point. A credential
  // URL that reached the config by any other route (hand-edited caretaker.json,
  // the VSCode save path, a restored backup) must never reach git, which would
  // write it into .git/config and put it on argv.
  const dirty = 'https://user:ghp_secret@example.com/o/r.git';
  const repo = await makeRepo();
  const { branch, worktreePath } = await ensureWorktree(repo, '9-31', 'Dirty remote');

  await assert.rejects(() => pushBranch(worktreePath, branch, { url: dirty }), /credentials/i);
  await assert.rejects(
    () => drain(syncProjectRepo({ id: '31', workingDir: '', repositoryUrl: dirty })),
    /credentials/i,
  );

  await finalizeDone(worktreePath);
  await rm(repo, { recursive: true, force: true });
});

test('pushBranch pushes the task branch to the remote from the worktree', async () => {
  const repo = await makeRepo();
  const origin = await makeBareOrigin();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, '3-11', 'Push me');
  await writeFile(join(agentWorkingDir, 'out.txt'), 'work\n');
  await commitWip(worktreePath, 'Push me');

  await pushBranch(worktreePath, branch, { url: origin });

  const branches = await g(origin, ['branch', '--list', branch]);
  assert.match(branches.stdout, /caretaker\/task-3-11-push-me/);

  // Failure is a readable error, not a hang (GIT_TERMINAL_PROMPT=0).
  await assert.rejects(
    () => pushBranch(worktreePath, branch, { url: join(tmpdir(), 'ct-no-such-remote') }),
    /git push failed/,
  );

  await finalizeDone(worktreePath);
  await rm(repo, { recursive: true, force: true });
  await rm(origin, { recursive: true, force: true });
});

/** Seed a bare origin with one commit on main; returns its path (file-transport URL). */
async function seededOrigin(): Promise<string> {
  const origin = await makeBareOrigin();
  const work = await makeRepo();
  await g(work, ['remote', 'add', 'origin', origin]);
  await g(work, ['push', '-q', 'origin', 'main']);
  await rm(work, { recursive: true, force: true });
  return origin;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

const remoteProject = (id: string, url: string, workingDir = '') => ({
  id, name: 'p', description: '', workingDir, agentId: 'a', active: true,
  repositoryUrl: url,
});

test('projectWorkingDir resolves default under dataDir only for remote-backed projects', () => {
  assert.equal(projectWorkingDir({ id: '9', workingDir: '/x', repositoryUrl: 'https://e/r' }), '/x');
  assert.equal(
    projectWorkingDir({ id: '9', workingDir: '', repositoryUrl: 'https://e/r' }),
    join(CT_HOME, 'repos', '9'),
  );
  assert.equal(projectWorkingDir({ id: '9', workingDir: '' }), '');
});

test('syncProjectRepo clones when absent, then fast-forwards on the next sync', async () => {
  const origin = await seededOrigin();
  const project = remoteProject('91', origin);
  const dest = join(CT_HOME, 'repos', '91');

  await drain(syncProjectRepo(project));
  assert.ok((await stat(join(dest, 'README.md'))).isFile());
  assert.equal((await projectRepoStatus(project)).state, 'cloned');

  // Push a new commit to the origin from a second clone...
  const second = await mkdtemp(join(tmpdir(), 'ct-second-'));
  await g(second, ['clone', '-q', origin, 'w']);
  const w = join(second, 'w');
  await g(w, ['config', 'user.email', 't@e.com']);
  await g(w, ['config', 'user.name', 'T']);
  await writeFile(join(w, 'new.txt'), 'x\n');
  await g(w, ['add', '-A']);
  await g(w, ['commit', '-q', '-m', 'more']);
  await g(w, ['push', '-q', 'origin', 'main']);

  // ...and the next sync fast-forwards it in.
  await drain(syncProjectRepo(project));
  assert.ok((await stat(join(dest, 'new.txt'))).isFile());

  await rm(origin, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

test('managedRepoDir returns a path only for caretaker-owned clones', () => {
  // Remote-backed, no workingDir: caretaker's own dir, safe to delete.
  assert.equal(managedRepoDir({ id: '7', repositoryUrl: 'https://e/r' }), join(CT_HOME, 'repos', '7'));
  // User-chosen dir, and non-remote project: never ours.
  assert.equal(managedRepoDir({ id: '7', workingDir: '/home/me/code', repositoryUrl: 'https://e/r' }), null);
  assert.equal(managedRepoDir({ id: '7', workingDir: '' }), null);
});

test('syncProjectRepo realigns origin to the configured URL before fetching', async () => {
  const originA = await seededOrigin();
  const dest = join(CT_HOME, 'repos', '96');
  await drain(syncProjectRepo(remoteProject('96', originA)));

  // Origin B: a clone of A with one extra commit, so the switch fast-forwards.
  const originB = await makeBareOrigin();
  const tmp = await mkdtemp(join(tmpdir(), 'ct-bwork-'));
  await g(tmp, ['clone', '-q', originA, 'w']);
  const w = join(tmp, 'w');
  await g(w, ['config', 'user.email', 't@e.com']);
  await g(w, ['config', 'user.name', 'T']);
  await writeFile(join(w, 'from-b.txt'), 'b\n');
  await g(w, ['add', '-A']);
  await g(w, ['commit', '-q', '-m', 'b']);
  await g(w, ['push', '-q', originB, 'main']);

  await drain(syncProjectRepo(remoteProject('96', originB)));
  assert.equal((await g(dest, ['remote', 'get-url', 'origin'])).stdout.trim(), originB);
  assert.ok((await stat(join(dest, 'from-b.txt'))).isFile());

  await rm(originA, { recursive: true, force: true });
  await rm(originB, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
});

// Both sides commit, so the histories genuinely diverge and `pull --ff-only`
// fails on every retry (a clone that is merely ahead still fast-forwards).
async function diverge(clone: string, origin: string, marker: string): Promise<void> {
  await g(clone, ['config', 'user.email', 't@e.com']);
  await g(clone, ['config', 'user.name', 'T']);
  await writeFile(join(clone, marker), 'local\n');
  await g(clone, ['add', '-A']);
  await g(clone, ['commit', '-q', '-m', 'local side']);

  const tmp = await mkdtemp(join(tmpdir(), 'ct-upstream-'));
  await g(tmp, ['clone', '-q', origin, 'w']);
  const w = join(tmp, 'w');
  await g(w, ['config', 'user.email', 't@e.com']);
  await g(w, ['config', 'user.name', 'T']);
  await writeFile(join(w, 'upstream.txt'), 'them\n');
  await g(w, ['add', '-A']);
  await g(w, ['commit', '-q', '-m', 'upstream side']);
  await g(w, ['push', '-q', 'origin', 'main']);
  await rm(tmp, { recursive: true, force: true });
}

test('syncProjectRepo resets a diverged MANAGED clone, refuses a user-chosen one', async () => {
  const origin = await seededOrigin();
  const dest = join(CT_HOME, 'repos', '97');
  await drain(syncProjectRepo(remoteProject('97', origin)));
  await diverge(dest, origin, 'stray.txt');

  await drain(syncProjectRepo(remoteProject('97', origin)));
  assert.equal(
    (await g(dest, ['rev-parse', 'HEAD'])).stdout.trim(),
    (await g(dest, ['rev-parse', 'origin/main'])).stdout.trim(),
  );
  await assert.rejects(() => stat(join(dest, 'stray.txt')));
  assert.ok((await stat(join(dest, 'upstream.txt'))).isFile());

  // Same divergence in a user-chosen workingDir: surface the error, keep the work.
  const origin2 = await seededOrigin();
  const userDir = await mkdtemp(join(tmpdir(), 'ct-userdiv-'));
  await g(userDir, ['clone', '-q', origin2, 'r']);
  const repo = join(userDir, 'r');
  await diverge(repo, origin2, 'mine.txt');
  await assert.rejects(() => drain(syncProjectRepo(remoteProject('98', origin2, repo))), /git pull failed/);
  assert.ok((await stat(join(repo, 'mine.txt'))).isFile());

  await rm(origin, { recursive: true, force: true });
  await rm(origin2, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

test('syncProjectRepo wipes and re-clones a broken MANAGED dir, refuses a user-chosen one', async () => {
  const origin = await seededOrigin();

  // Managed default path (workingDir blank): junk dir is wiped and re-cloned.
  const managedDest = join(CT_HOME, 'repos', '92');
  await mkdir(managedDest, { recursive: true });
  await writeFile(join(managedDest, 'junk.txt'), 'not a repo\n');
  await drain(syncProjectRepo(remoteProject('92', origin)));
  assert.ok((await stat(join(managedDest, 'README.md'))).isFile());
  await assert.rejects(() => stat(join(managedDest, 'junk.txt')));

  // User-chosen workingDir: refuse to wipe, fail with a readable error.
  const userDir = await mkdtemp(join(tmpdir(), 'ct-user-'));
  await writeFile(join(userDir, 'precious.txt'), 'do not delete\n');
  await assert.rejects(
    () => drain(syncProjectRepo(remoteProject('93', origin, userDir))),
    /not a git repository/,
  );
  assert.ok((await stat(join(userDir, 'precious.txt'))).isFile());

  await rm(origin, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

test('syncProjectRepo sweeps stale temp clones and surfaces clone failures', async () => {
  const origin = await seededOrigin();
  const dest = join(CT_HOME, 'repos', '94');
  const stale = `${dest}.cloning-99999`;
  await mkdir(stale, { recursive: true });
  await drain(syncProjectRepo(remoteProject('94', origin)));
  await assert.rejects(() => stat(stale));
  assert.equal((await projectRepoStatus(remoteProject('94', origin))).state, 'cloned');

  await assert.rejects(
    () => drain(syncProjectRepo(remoteProject('95', join(tmpdir(), 'ct-no-remote')))),
    /git clone failed/,
  );
  // A failed clone leaves no half-cloned destination.
  assert.equal((await projectRepoStatus(remoteProject('95', 'https://x'))).state, 'absent');

  await rm(origin, { recursive: true, force: true });
});

test('discardWorktree pushes before removal; a failed push keeps the worktree', async () => {
  const repo = await makeRepo();
  const origin = await makeBareOrigin();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, '4-21', 'Discard remote');
  await writeFile(join(agentWorkingDir, 'wip.txt'), 'unsaved\n');

  // Failed push (bogus remote): worktree must survive.
  await assert.rejects(
    () => discardWorktree(worktreePath, 'Discard remote', {
      branch,
      url: join(tmpdir(), 'ct-missing-origin'),
    }),
    /git push failed/,
  );
  assert.ok((await stat(worktreePath)).isDirectory());

  // Successful push: branch lands on the origin, worktree removed.
  await discardWorktree(worktreePath, 'Discard remote', { branch, url: origin });
  await assert.rejects(() => stat(worktreePath));
  const branches = await g(origin, ['branch', '--list', branch]);
  assert.match(branches.stdout, /caretaker\/task-4-21-discard-remote/);

  await rm(repo, { recursive: true, force: true });
  await rm(origin, { recursive: true, force: true });
});
