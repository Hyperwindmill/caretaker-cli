import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { dataDir } from '../store/db.js';
import { commandEnv } from '../harness/tools/builtin/shell-env.js';
import { execInContainer } from './docker.js';

const exec = promisify(execFile);
const execShell = promisify(execCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: commandEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
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

/**
 * Absolute git common dir for a (linked) worktree — the main repo's shared
 * `.git`, which holds the object store and `worktrees/<id>`. A worktree's own
 * `.git` file points inside here, so mounting this path into a container (at
 * an identical path) is what makes in-container git resolve. Returns null when
 * it can't be determined (e.g. not a git dir).
 */
export async function gitCommonDir(worktreePath: string): Promise<string | null> {
  try {
    return await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    return null;
  }
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

/**
 * Run project bootstrap commands once in a freshly created worktree, in order.
 * Stops at the first non-zero exit and throws with the failed command + its
 * output, so the caller can surface why setup failed. Each command gets a
 * generous timeout so a hung install can't wedge the scheduler tick.
 * ponytail: 10-min per-command timeout; make it configurable if a real project needs longer.
 */
export async function runBootstrap(
  cwd: string,
  commands: string[],
  dockerContainer?: string,
): Promise<void> {
  for (const command of commands) {
    const cmd = command.trim();
    if (!cmd) continue;
    if (dockerContainer) {
      const { exitCode, output } = await execInContainer(dockerContainer, cwd, cmd, 10 * 60 * 1000);
      if (exitCode !== 0) {
        throw new Error(`Bootstrap command failed: \`${cmd}\`\n${output.trim()}`);
      }
      continue;
    }
    try {
      await execShell(cmd, {
        cwd,
        env: commandEnv(),
        timeout: 10 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
      throw new Error(`Bootstrap command failed: \`${cmd}\`\n${detail}`);
    }
  }
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
