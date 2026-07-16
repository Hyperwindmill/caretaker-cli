import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { dataDir } from '../store/db.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

function worktreePathFor(projectId: number, taskId: number): string {
  return join(dataDir(), 'worktrees', `${projectId}-${taskId}`);
}

export async function agentDirIn(worktreePath: string, projectWorkingDir: string): Promise<string> {
  // Preserve a sub-directory working dir when the project points below the repo root.
  const repoRoot = await git(projectWorkingDir, ['rev-parse', '--show-toplevel']);
  const rel = relative(repoRoot, projectWorkingDir);
  return rel ? join(worktreePath, rel) : worktreePath;
}

export async function ensureWorktree(
  projectWorkingDir: string,
  projectId: number,
  taskId: number,
  title: string,
): Promise<{ branch: string; worktreePath: string; agentWorkingDir: string }> {
  const repoRoot = await git(projectWorkingDir, ['rev-parse', '--show-toplevel']);
  const branch = `caretaker/task-${taskId}-${slug(title)}`;
  const worktreePath = worktreePathFor(projectId, taskId);

  try {
    await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  } catch {
    // Branch may already exist from a previous run whose path field was lost — reuse it.
    await git(repoRoot, ['worktree', 'add', worktreePath, branch]);
  }

  const rel = relative(repoRoot, projectWorkingDir);
  const agentWorkingDir = rel ? join(worktreePath, rel) : worktreePath;
  return { branch, worktreePath, agentWorkingDir };
}

async function hasGitIdentity(cwd: string): Promise<boolean> {
  try {
    const [name, email] = await Promise.all([
      git(cwd, ['config', 'user.name']),
      git(cwd, ['config', 'user.email']),
    ]);
    return name.length > 0 && email.length > 0;
  } catch {
    return false;
  }
}

export async function commitWip(worktreePath: string, title: string): Promise<boolean> {
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (!status) return false;
  await git(worktreePath, ['add', '-A']);
  // --no-verify: these are machine-made WIP commits; the repo's pre-commit hooks
  // (husky, lint-staged) belong on the user's real commit/merge after review, not here.
  // Inject a fallback identity ONLY when the repo has none configured — never override the user's.
  const idArgs = (await hasGitIdentity(worktreePath))
    ? []
    : ['-c', 'user.name=Caretaker', '-c', 'user.email=caretaker@localhost'];
  // "chore(auto):" instead of "wip:" — wip is not a conventional-commits type,
  // so commitlint-style hooks and wip-detecting tools warn on it downstream.
  await git(worktreePath, [...idArgs, 'commit', '--no-verify', '-m', `chore(auto): ${title}`]);
  return true;
}

export async function finalizeDone(worktreePath: string): Promise<void> {
  let mainRepo: string;
  try {
    const commonDir = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    mainRepo = dirname(commonDir); // .../<repo>/.git -> .../<repo>
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
    return;
  }
  try {
    await git(mainRepo, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // Metadata inconsistent (e.g. dir already gone): force cleanup + prune.
    await rm(worktreePath, { recursive: true, force: true });
    await git(mainRepo, ['worktree', 'prune']).catch(() => {});
  }
}

export async function discardWorktree(worktreePath: string, title: string): Promise<void> {
  await commitWip(worktreePath, title);
  await finalizeDone(worktreePath);
}
