import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdir, readdir, rename } from 'node:fs/promises';
import { join, relative, dirname, basename } from 'node:path';
import { dataDir } from '../store/db.js';
import { commandEnv } from '../harness/tools/builtin/shell-env.js';
import { execInContainer } from './docker.js';
import { decrypt, isEncrypted } from './encryption.js';

const exec = promisify(execFile);
const execShell = promisify(execCb);

async function git(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
  timeout?: number,
): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...commandEnv(), ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    timeout,
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

// Inline credential helper: git shells this out and reads username/password
// from stdout. The token travels only in the child env (CARETAKER_GIT_TOKEN)
// — never on argv (visible in `ps`), never in .git/config.
const CRED_HELPER = '!f(){ echo username=x-access-token; echo password=$CARETAKER_GIT_TOKEN; }; f';

export function gitAuthArgs(hasToken: boolean): string[] {
  if (!hasToken) return [];
  // First -c clears any configured helpers so ours is the only one consulted —
  // a system helper answering first with stale credentials would shadow the token.
  return ['-c', 'credential.helper=', '-c', `credential.helper=${CRED_HELPER}`];
}

export function gitAuthEnv(token?: string | null): Record<string, string> {
  // GIT_TERMINAL_PROMPT=0: the scheduler must never hang on an interactive
  // username/password prompt — fail fast with a real error instead.
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (token) env.CARETAKER_GIT_TOKEN = isEncrypted(token) ? decrypt(token) : token;
  return env;
}

// Network ops only: a hung TCP connection would hold syncingProjects and the
// task lock until the OS timeout. Local git commands stay unbounded on purpose
// (a worktree add on a huge repo is slow but legitimate).
const NET_TIMEOUT_MS = 120_000;

/** Network git ops (clone/fetch/pull/push): auth + a readable error carrying
 *  git's stderr, which becomes blockedReason / UI copy downstream. */
async function netGit(cwd: string, args: string[], token?: string | null): Promise<string> {
  try {
    return await git(cwd, [...gitAuthArgs(!!token), ...args], gitAuthEnv(token), NET_TIMEOUT_MS);
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    const detail = e.killed
      ? `timed out after ${NET_TIMEOUT_MS / 1000}s`
      : (e.stderr || e.message || String(err)).toString().trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

/**
 * Last line of defence before a remote URL reaches git. Form and API
 * validation are UX; this is the enforcement point, because a URL git accepts
 * gets written into `.git/config` and passed on argv. Anything that put a
 * credential-bearing URL into the config by another route — a hand-edited
 * `caretaker.json`, a surface whose save path lacks the check, a restored
 * backup — is stopped here rather than leaking the secret.
 */
function assertCleanRemoteUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // No scheme: a filesystem path, which cannot carry credentials.
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      'Refusing to use a repository URL with embedded credentials: git would store it in .git/config and expose it in the process list. Remove the credentials from the URL and use the access token field.',
    );
  }
  // Deliberately NOT enforcing https here — that transport policy belongs to
  // config validation (lib/repo_url.ts). A filesystem path is a legitimate
  // remote for a local mirror and for the tests.
}

export async function pushBranch(
  worktreePath: string,
  branch: string,
  repo: { url: string; token?: string | null },
): Promise<void> {
  assertCleanRemoteUrl(repo.url);
  // Push to the configured URL, not "origin": correct even when workingDir is a
  // pre-existing local repo whose origin points elsewhere.
  await netGit(worktreePath, ['push', repo.url, `${branch}:${branch}`], repo.token);
}

export function projectWorkingDir(project: {
  id: number;
  workingDir?: string | null;
  repositoryUrl?: string | null;
}): string {
  const dir = (project.workingDir || '').trim();
  if (dir) return dir;
  // Remote-backed with no explicit dir: managed clone under the data dir.
  // Resolved at call time (dataDir() follows CARETAKER_HOME), never persisted.
  if ((project.repositoryUrl || '').trim()) return join(dataDir(), 'repos', String(project.id));
  return '';
}

/**
 * The clone directory caretaker owns for this project, or null when the repo
 * lives in a user-chosen `workingDir` (or the project isn't remote-backed).
 * The delete path uses this: anything non-null is caretaker's to remove,
 * anything null must never be touched.
 */
export function managedRepoDir(project: {
  id: number;
  workingDir?: string | null;
  repositoryUrl?: string | null;
}): string | null {
  if ((project.workingDir || '').trim()) return null;
  return projectWorkingDir(project) || null;
}

export type ProjectRepoStatus ={ state: 'absent' | 'cloned' | 'broken'; branch?: string; commit?: string };

export async function projectRepoStatus(project: {
  id: number;
  workingDir?: string | null;
  repositoryUrl?: string | null;
}): Promise<ProjectRepoStatus> {
  const dest = projectWorkingDir(project);
  if (!dest) return { state: 'absent' };
  let entries: string[];
  try {
    entries = await readdir(dest);
  } catch {
    return { state: 'absent' };
  }
  if (entries.length === 0) return { state: 'absent' };
  if (!(await isGitRepo(dest))) return { state: 'broken' };
  try {
    const branch = await git(dest, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const commit = await git(dest, ['rev-parse', '--short', 'HEAD']);
    return { state: 'cloned', branch, commit };
  } catch {
    return { state: 'cloned' };
  }
}

export type SyncProgress = {
  step: 'clean' | 'clone' | 'pull' | 'done' | 'error';
  message: string;
  status?: ProjectRepoStatus;
};

/**
 * Clone-or-pull a remote-backed project's repository. Progress is yielded for
 * the ndjson endpoint; the heartbeat just drains it. Throws on failure —
 * callers turn that into a blocked task / in-band error line.
 */
export async function* syncProjectRepo(project: {
  id: number;
  workingDir?: string | null;
  repositoryUrl?: string | null;
  repositoryToken?: string | null;
}): AsyncGenerator<SyncProgress> {
  const url = (project.repositoryUrl || '').trim();
  if (!url) throw new Error('Project has no repository URL');
  assertCleanRemoteUrl(url);
  const dest = projectWorkingDir(project);
  const token = project.repositoryToken;
  let status = await projectRepoStatus(project);

  if (status.state === 'broken') {
    // Auto-wipe only the managed default path. A user-chosen workingDir that
    // isn't a repo could be anything (Documents, home…) — never delete it.
    if ((project.workingDir || '').trim()) {
      throw new Error(
        `Directory ${dest} exists but is not a git repository. ` +
          `Refusing to overwrite a user-chosen directory — point the project at an empty or valid path.`,
      );
    }
    yield { step: 'clean', message: `Removing broken checkout at ${dest}` };
    await rm(dest, { recursive: true, force: true });
    status = { state: 'absent' };
  }

  if (status.state === 'absent') {
    const parent = dirname(dest);
    await mkdir(parent, { recursive: true });
    // Sweep temp dirs left by crashed clones (`<name>.cloning-<pid>`).
    for (const entry of await readdir(parent)) {
      if (entry.startsWith(`${basename(dest)}.cloning-`)) {
        yield { step: 'clean', message: `Removing stale temp clone ${entry}` };
        await rm(join(parent, entry), { recursive: true, force: true });
      }
    }
    const tmp = `${dest}.cloning-${process.pid}`;
    yield { step: 'clone', message: `Cloning ${url}` };
    await netGit(parent, ['clone', url, tmp], token);
    // Atomic hand-over: the destination only ever appears as a complete clone.
    await rm(dest, { recursive: true, force: true }); // absent = missing or empty dir
    await rename(tmp, dest);
  } else {
    // Realign `origin` to the configured URL before touching the network:
    // fetch/pull talk to whatever origin is, and the credential helper answers
    // for ANY host it's asked about (no host matching). An inherited or
    // pre-existing clone pointing elsewhere would be offered the project's
    // token — confused deputy. `url` already passed assertCleanRemoteUrl.
    const currentOrigin = await git(dest, ['remote', 'get-url', 'origin']).catch(() => null);
    if (currentOrigin !== url) {
      await git(dest, ['remote', currentOrigin === null ? 'add' : 'set-url', 'origin', url]);
      yield { step: 'clean', message: `Realigned origin to ${url}` };
    }
    yield { step: 'pull', message: 'Fetching and fast-forwarding' };
    await netGit(dest, ['fetch', 'origin'], token);
    try {
      await netGit(dest, ['pull', '--ff-only'], token);
    } catch (e) {
      // Diverged (upstream force-push, stray local commit, realigned origin):
      // ff-only then fails identically on every retry, so without a self-heal
      // the project is stuck until someone deletes the dir by hand. Only
      // caretaker writes to the MANAGED clone (tasks work in worktrees), so
      // there is no user work to lose. A user-chosen workingDir is never reset
      // — same rule as the `broken` wipe above.
      if ((project.workingDir || '').trim()) throw e;
      const upstream = await git(dest, ['rev-parse', '--abbrev-ref', '@{upstream}']).catch(() => null);
      if (!upstream) throw e;
      yield { step: 'clean', message: `Diverged from ${upstream} — resetting the managed clone` };
      await git(dest, ['reset', '--hard', upstream]);
    }
  }

  yield { step: 'done', message: `Repository ready at ${dest}`, status: await projectRepoStatus(project) };
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

export async function discardWorktree(
  worktreePath: string,
  title: string,
  push?: { branch: string; url: string; token?: string | null },
): Promise<void> {
  await commitWip(worktreePath, title);
  // Push BEFORE removal: a failed push aborts the discard so unpushed work
  // never loses its worktree. Callers surface the error to the user/agent.
  if (push) await pushBranch(worktreePath, push.branch, push);
  await finalizeDone(worktreePath);
}
