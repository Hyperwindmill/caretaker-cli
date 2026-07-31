# Project Remote Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A caretaker project can be backed by a remote HTTPS git repository: the server clones it on demand (defaulting under `~/.caretaker/repos/<projectId>`), pulls right before creating a task worktree, and pushes task branches to the remote (per-cycle best-effort; gating before finalize and manual discard), with an encrypted per-project access token.

**Architecture:** Everything git lives in `packages/cli/src/lib/task_git.ts` via the existing CLI-`git()` helper (no isomorphic-git). Token auth uses an inline credential helper reading a child-process env var — never argv, never `.git/config`. Cloning state is derived from disk + an in-memory per-project in-flight set; nothing persisted. Web API adds an ndjson sync endpoint (voice-backend pattern) and a derived repo-status endpoint.

**Tech Stack:** TypeScript ESM, Node built-in test runner via tsx, Hono (+ `hono/streaming`), React (webview-ui), AES-256-GCM via `lib/encryption.ts`.

**Design spec:** `docs/superpowers/specs/2026-07-31-project-remote-repository-design.md`

## Global Constraints

- Package manager: pnpm. Run CLI tests as `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test <file>`; typecheck as `pnpm -F @hyperwindmill/caretaker-cli typecheck`; webview tests as `pnpm -F webview-ui test`.
- Auth: HTTPS + token only, username convention `x-access-token`. No SSH. Token env var name: `CARETAKER_GIT_TOKEN`.
- The token must never appear on argv, in `.git/config`, in logs, or in error messages surfaced to tasks/UI.
- Every clone/pull/push behaviour applies **only** when `project.repositoryUrl` is set (trimmed non-empty). Plain local projects keep today's behaviour exactly.
- All sync/push git commands run host-side (never inside a task Docker container).
- Cloning/sync state is never persisted to `caretaker.json` or the folder DB.
- Paths under `~/.caretaker/` always come from `dataDir()` resolved at call time.
- Conventional commits, no AI attribution. Every task that changes a package needs the changeset in Task 8 (one changeset covers the whole feature).
- **Safety deviation from contract (approved rationale in plan review):** a `broken` destination is auto-wiped and re-cloned **only when it is the managed default path** (i.e. `project.workingDir` is blank). A user-chosen `workingDir` that exists but is not a git repo makes the sync fail with an explanatory error instead of wiping user data.

---

### Task 1: `ProjectConfig` fields + token encryption at rest

**Files:**
- Modify: `packages/types/src/index.ts` (ProjectConfig, after `dockerImage`, ~line 61)
- Modify: `packages/cli/src/store/json.ts:86-103` (`saveConfig`)
- Create: `packages/cli/src/store/json_projects.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `isEncrypted` from `packages/cli/src/lib/encryption.js`.
- Produces: `ProjectConfig.repositoryUrl?: string | null`, `ProjectConfig.repositoryToken?: string | null` — used by every later task. `saveConfig` guarantees `projects[].repositoryToken` is encrypted on disk.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/store/json_projects.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope CARETAKER_HOME so config and encryption key land in a temp dir.
process.env.CARETAKER_HOME = await mkdtemp(join(tmpdir(), 'ct-json-proj-'));

const { saveConfig, configPath } = await import('./json.js');
const { isEncrypted } = await import('../lib/encryption.js');

const project = {
  id: 1,
  name: 'p',
  description: '',
  workingDir: '',
  agentId: 'a',
  active: true,
  repositoryUrl: 'https://example.com/org/repo.git',
  repositoryToken: 'ghp_supersecret',
};

test('saveConfig encrypts projects[].repositoryToken at rest, without double-encrypting', async () => {
  await saveConfig({ port: 1, providers: [], projects: [{ ...project }] });

  const raw = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.ok(isEncrypted(raw.projects[0].repositoryToken), 'token must be encrypted on disk');
  assert.ok(!JSON.stringify(raw).includes('ghp_supersecret'), 'plaintext must not hit disk');

  // Round-trip an already-encrypted config (the saveConfig websocket path):
  // the blob must pass through unchanged, not be encrypted twice.
  const first = raw.projects[0].repositoryToken;
  await saveConfig({ port: 1, providers: [], projects: [{ ...project, repositoryToken: first }] });
  const raw2 = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.equal(raw2.projects[0].repositoryToken, first);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/json_projects.test.ts`
Expected: FAIL — `token must be encrypted on disk` (saveConfig doesn't touch projects yet). A TS error about the unknown field is also possible before Step 3.

- [ ] **Step 3: Add the type fields**

In `packages/types/src/index.ts`, inside `ProjectConfig` after the `dockerImage` field:

```ts
  /**
   * HTTPS remote of the project repository. When set, the project is
   * remote-backed: the scheduler clones it on demand (into `workingDir`, or
   * `~/.caretaker/repos/<id>` when workingDir is blank), pulls before creating
   * a task worktree, and pushes task branches back. Unset = plain local project.
   */
  repositoryUrl?: string | null;
  /**
   * Access token for `repositoryUrl` (HTTPS, username `x-access-token`).
   * Encrypted at rest by saveConfig (encrypt() blob, see lib/encryption.ts).
   */
  repositoryToken?: string | null;
```

- [ ] **Step 4: Encrypt in saveConfig**

In `packages/cli/src/store/json.ts`, inside `saveConfig` after the telegram loop (before the `c.voice?.apiKey` line):

```ts
  for (const project of c.projects || []) {
    if (project.repositoryToken && !isEncrypted(project.repositoryToken)) {
      project.repositoryToken = encrypt(project.repositoryToken);
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/json_projects.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: clean.

```bash
git add packages/types/src/index.ts packages/cli/src/store/json.ts packages/cli/src/store/json_projects.test.ts
git commit -m "feat(types,store): add project repositoryUrl/repositoryToken, encrypt token at rest"
```

---

### Task 2: git auth helpers + `pushBranch` in task_git.ts

**Files:**
- Modify: `packages/cli/src/lib/task_git.ts`
- Test: `packages/cli/src/lib/task_git.test.ts` (append)

**Interfaces:**
- Consumes: private `git(cwd, args)` helper (`task_git.ts:12`), `decrypt`/`isEncrypted` from `../lib/encryption.js` (import as `./encryption.js`).
- Produces (used by Tasks 3-6):
  - `gitAuthArgs(hasToken: boolean): string[]`
  - `gitAuthEnv(token?: string | null): Record<string, string>`
  - `pushBranch(worktreePath: string, branch: string, repo: { url: string; token?: string | null }): Promise<void>`
  - private `netGit(cwd, args, token?)` — wraps network git ops with auth + readable errors.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/lib/task_git.test.ts` (the file already sets `CARETAKER_HOME` and defines `makeRepo()`; extend the dynamic import list on line 17 with `pushBranch, gitAuthArgs, gitAuthEnv`):

```ts
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
  assert.ok(!args.join(' ').includes('tok'), 'token must never be an argument');

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

test('pushBranch pushes the task branch to the remote from the worktree', async () => {
  const repo = await makeRepo();
  const origin = await makeBareOrigin();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 3, 11, 'Push me');
  await writeFile(join(agentWorkingDir, 'out.txt'), 'work\n');
  await commitWip(worktreePath, 'Push me');

  await pushBranch(worktreePath, branch, { url: origin });

  const branches = await g(origin, ['branch', '--list', branch]);
  assert.match(branches.stdout, /caretaker\/task-11-push-me/);

  // Failure is a readable error, not a hang (GIT_TERMINAL_PROMPT=0).
  await assert.rejects(
    () => pushBranch(worktreePath, branch, { url: join(tmpdir(), 'ct-no-such-remote') }),
    /git push failed/,
  );

  await finalizeDone(worktreePath);
  await rm(repo, { recursive: true, force: true });
  await rm(origin, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: FAIL — `gitAuthArgs` / `pushBranch` not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/task_git.ts`:

Add to imports: `import { decrypt, isEncrypted } from './encryption.js';`

Change the private `git()` helper (line 12) to accept extra env:

```ts
async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...commandEnv(), ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}
```

Add below `isGitRepo`:

```ts
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

/** Network git ops (clone/fetch/pull/push): auth + a readable error carrying
 *  git's stderr, which becomes blockedReason / UI copy downstream. */
async function netGit(cwd: string, args: string[], token?: string | null): Promise<string> {
  try {
    return await git(cwd, [...gitAuthArgs(!!token), ...args], gitAuthEnv(token));
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).toString().trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export async function pushBranch(
  worktreePath: string,
  branch: string,
  repo: { url: string; token?: string | null },
): Promise<void> {
  // Push to the configured URL, not "origin": correct even when workingDir is a
  // pre-existing local repo whose origin points elsewhere.
  await netGit(worktreePath, ['push', repo.url, `${branch}:${branch}`], repo.token);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/task_git.ts packages/cli/src/lib/task_git.test.ts
git commit -m "feat(cli): git token auth helpers and pushBranch in task_git"
```

---

### Task 3: `projectWorkingDir`, `projectRepoStatus`, `syncProjectRepo`

**Files:**
- Modify: `packages/cli/src/lib/task_git.ts`
- Test: `packages/cli/src/lib/task_git.test.ts` (append)

**Interfaces:**
- Consumes: `netGit`, `git`, `isGitRepo` from Task 2; `dataDir` from `../store/db.js` (already imported).
- Produces (used by Tasks 5-7):
  - `projectWorkingDir(project: { id: number; workingDir?: string | null; repositoryUrl?: string | null }): string` — `workingDir` if set, else `<dataDir>/repos/<id>` when remote-backed, else `''`.
  - `type ProjectRepoStatus = { state: 'absent' | 'cloned' | 'broken'; branch?: string; commit?: string }`
  - `projectRepoStatus(project): Promise<ProjectRepoStatus>`
  - `type SyncProgress = { step: 'clean' | 'clone' | 'pull' | 'done' | 'error'; message: string; status?: ProjectRepoStatus }`
  - `syncProjectRepo(project: ProjectConfig): AsyncGenerator<SyncProgress>` — throws on failure (consumers turn that into blocked/ndjson-error).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/lib/task_git.test.ts` (extend the import list with `projectWorkingDir, projectRepoStatus, syncProjectRepo`; add `mkdir` to the fs imports on line 3):

```ts
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

const remoteProject = (id: number, url: string, workingDir = '') => ({
  id, name: 'p', description: '', workingDir, agentId: 'a', active: true,
  repositoryUrl: url,
});

test('projectWorkingDir resolves default under dataDir only for remote-backed projects', () => {
  assert.equal(projectWorkingDir({ id: 9, workingDir: '/x', repositoryUrl: 'https://e/r' }), '/x');
  assert.equal(
    projectWorkingDir({ id: 9, workingDir: '', repositoryUrl: 'https://e/r' }),
    join(CT_HOME, 'repos', '9'),
  );
  assert.equal(projectWorkingDir({ id: 9, workingDir: '' }), '');
});

test('syncProjectRepo clones when absent, then fast-forwards on the next sync', async () => {
  const origin = await seededOrigin();
  const project = remoteProject(91, origin);
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

test('syncProjectRepo wipes and re-clones a broken MANAGED dir, refuses a user-chosen one', async () => {
  const origin = await seededOrigin();

  // Managed default path (workingDir blank): junk dir is wiped and re-cloned.
  const managedDest = join(CT_HOME, 'repos', '92');
  await mkdir(managedDest, { recursive: true });
  await writeFile(join(managedDest, 'junk.txt'), 'not a repo\n');
  await drain(syncProjectRepo(remoteProject(92, origin)));
  assert.ok((await stat(join(managedDest, 'README.md'))).isFile());
  await assert.rejects(() => stat(join(managedDest, 'junk.txt')));

  // User-chosen workingDir: refuse to wipe, fail with a readable error.
  const userDir = await mkdtemp(join(tmpdir(), 'ct-user-'));
  await writeFile(join(userDir, 'precious.txt'), 'do not delete\n');
  await assert.rejects(
    () => drain(syncProjectRepo(remoteProject(93, origin, userDir))),
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
  await drain(syncProjectRepo(remoteProject(94, origin)));
  await assert.rejects(() => stat(stale));
  assert.equal((await projectRepoStatus(remoteProject(94, origin))).state, 'cloned');

  await assert.rejects(
    () => drain(syncProjectRepo(remoteProject(95, join(tmpdir(), 'ct-no-remote')))),
    /git clone failed/,
  );
  // A failed clone leaves no half-cloned destination.
  assert.equal((await projectRepoStatus(remoteProject(95, 'https://x'))).state, 'absent');

  await rm(origin, { recursive: true, force: true });
});
```

Note: `CT_HOME` is the existing file-scope constant (line 13). `stat` is already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: FAIL — `projectWorkingDir` / `syncProjectRepo` not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/task_git.ts`. Extend the node imports: `import { rm, mkdir, readdir, rename } from 'node:fs/promises';` and add `basename` to the `node:path` import.

```ts
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

export type ProjectRepoStatus = { state: 'absent' | 'cloned' | 'broken'; branch?: string; commit?: string };

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
    yield { step: 'pull', message: 'Fetching and fast-forwarding' };
    await netGit(dest, ['fetch', 'origin'], token);
    await netGit(dest, ['pull', '--ff-only'], token);
  }

  yield { step: 'done', message: `Repository ready at ${dest}`, status: await projectRepoStatus(project) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/task_git.ts packages/cli/src/lib/task_git.test.ts
git commit -m "feat(cli): syncProjectRepo (atomic clone-or-pull) and derived repo status"
```

---

### Task 4: `discardWorktree` pushes before removal

**Files:**
- Modify: `packages/cli/src/lib/task_git.ts:170-173` (`discardWorktree`)
- Test: `packages/cli/src/lib/task_git.test.ts` (append)

**Interfaces:**
- Consumes: `pushBranch` (Task 2).
- Produces: `discardWorktree(worktreePath: string, title: string, push?: { branch: string; url: string; token?: string | null }): Promise<void>` — with `push`, a failed push throws **before** `finalizeDone`, so the worktree survives. Existing two-arg callers are unaffected.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/lib/task_git.test.ts`:

```ts
test('discardWorktree pushes before removal; a failed push keeps the worktree', async () => {
  const repo = await makeRepo();
  const origin = await makeBareOrigin();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 4, 21, 'Discard remote');
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
  assert.match(branches.stdout, /caretaker\/task-21-discard-remote/);

  await rm(repo, { recursive: true, force: true });
  await rm(origin, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: FAIL — discardWorktree takes 2 args / doesn't push.

- [ ] **Step 3: Implement**

Replace `discardWorktree` in `packages/cli/src/lib/task_git.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/task_git.ts packages/cli/src/lib/task_git.test.ts
git commit -m "feat(cli): discardWorktree pushes to the remote before removing the worktree"
```

---

### Task 5: scheduler integration — sync before worktree, per-cycle push, push-gated finalize

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/locks.ts`
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts` (lines 178-196, 492-516, 546-659)
- Verify: `pnpm -F @hyperwindmill/caretaker-cli typecheck` + full CLI suite (scheduler wiring has no direct test file today — behaviour is covered by the task_git unit tests; the wiring is exercised by typecheck and the existing suite).

**Interfaces:**
- Consumes: `syncProjectRepo`, `projectWorkingDir`, `pushBranch` (Tasks 2-3); `saveTask`, `addTaskMessage`, `getTaskById` (already imported in task_strategy.ts).
- Produces: `syncingProjects: Set<number>` in `locks.ts` (shared with Task 6's endpoints); private `pushOrBlock(task, project)` in task_strategy.ts.

- [ ] **Step 1: Add the shared in-flight set**

Append to `packages/cli/src/cli/web/scheduler/locks.ts`:

```ts
/**
 * Project ids with a repository sync (clone/pull) in flight — shared between
 * the heartbeat's pre-worktree sync and POST /api/projects/:id/sync so the
 * two can never race a clone. Derived state only; never persisted.
 */
export const syncingProjects = new Set<number>();
```

- [ ] **Step 2: Sync before worktree creation in the heartbeat**

In `packages/cli/src/cli/web/scheduler/task_strategy.ts`:

Add imports: `syncProjectRepo`, `projectWorkingDir`, `pushBranch` to the existing `lib/task_git.js` import; `syncingProjects` to the existing `./locks.js` import.

Replace line 178:

```ts
    const baseWorkingDir = projectWorkingDir(project) || agent.workingDir || process.cwd();
```

Insert immediately after it (before the `let workingDir = baseWorkingDir;` line):

```ts
    // Remote-backed project: clone-or-pull the repository right before the
    // first worktree is created. Failure blocks the task (bootstrap pattern).
    if (!task.worktreePath && project.repositoryUrl?.trim()) {
      if (syncingProjects.has(project.id)) {
        console.log(`[task_heartbeat] Task #${task.id} repo sync already in flight; skipping tick.`);
        return;
      }
      syncingProjects.add(project.id);
      try {
        for await (const p of syncProjectRepo(project)) {
          console.log(`[task_heartbeat] Task #${task.id} repo sync: ${p.step} — ${p.message}`);
        }
      } catch (syncErr) {
        const reason = syncErr instanceof Error ? syncErr.message : String(syncErr);
        task.status = 'blocked';
        task.blockedReason = reason;
        task.updatedAt = new Date().toISOString();
        await saveTask(task);
        await addTaskMessage({
          taskId: task.id,
          role: 'assistant',
          messageType: 'block',
          content: `Repository sync failed — task blocked.\n\n${reason}`,
        });
        console.error(`[task_heartbeat] Task #${task.id} repo sync failed, blocked:`, reason);
        return;
      } finally {
        syncingProjects.delete(project.id);
      }
    }
```

(The early `return`s are safe: the function's `finally` block at line 532 releases the task lock.)

- [ ] **Step 3: Add `pushOrBlock` helper**

Add near the bottom of task_strategy.ts (above `runReviewCycle`):

```ts
/**
 * Push the task branch before finalizing. Returns true when pushed (or no push
 * applies). On failure: blocks the task with the reason and returns false —
 * the caller must NOT finalize (worktree stays; the user fixes the remote or
 * token and unblocks to retry).
 */
async function pushOrBlock(task: Task, project?: ProjectConfig | null): Promise<boolean> {
  const url = project?.repositoryUrl?.trim();
  if (!url || !task.branch || !task.worktreePath) return true;
  try {
    await pushBranch(task.worktreePath, task.branch, { url, token: project?.repositoryToken });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    task.status = 'blocked';
    task.blockedReason = reason;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);
    await addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'block',
      content: `Push to remote failed — task blocked. The worktree is kept; fix the remote or token and unblock to retry.\n\n${reason}`,
    });
    console.error(`[task_heartbeat] Task #${task.id} push failed, blocked:`, reason);
    return false;
  }
}
```

- [ ] **Step 4: Per-cycle best-effort push + gated finalize in the heartbeat git step**

Replace the git-lifecycle block (lines 496-516, the `const gitTask = await getTaskById(task.id);` block) with:

```ts
    const gitTask = await getTaskById(task.id);
    if (gitTask && gitTask.worktreePath) {
      try {
        if (await commitWip(gitTask.worktreePath, gitTask.title)) {
          console.log(`[task_heartbeat] Task #${task.id} committed WIP to ${gitTask.branch}`);
        }
        const repoUrl = project.repositoryUrl?.trim();
        if (repoUrl && gitTask.branch && gitTask.status !== 'done') {
          // Per-cycle push is best-effort: the remote mirrors progress, but a
          // flaky network must not fail the cycle. Finalize pushes are gated.
          try {
            await pushBranch(gitTask.worktreePath, gitTask.branch, { url: repoUrl, token: project.repositoryToken });
          } catch (pushErr) {
            console.error(`[task_heartbeat] Task #${task.id} per-cycle push failed (best-effort):`, pushErr);
          }
        }
        if (gitTask.status === 'done') {
          if (!(await pushOrBlock(gitTask, project))) return;
          if (gitTask.dockerContainer) {
            await removeContainer(gitTask.dockerContainer);
            gitTask.dockerContainer = null;
          }
          await finalizeDone(gitTask.worktreePath);
          gitTask.worktreePath = null;
          gitTask.updatedAt = new Date().toISOString();
          await saveTask(gitTask);
          console.log(`[task_heartbeat] Task #${gitTask.id} done (review gate off): worktree removed, branch ${gitTask.branch} kept`);
        }
      } catch (gitErr) {
        console.error(`[task_heartbeat] Task #${task.id} git step failed:`, gitErr);
      }
    }
```

- [ ] **Step 5: Gate the two finalize sites in `runReviewCycle`**

Site A — review gate disabled (lines 562-577). After the `if (!current || current.status !== 'reviewing') return;` line and before the `if (current.dockerContainer)` block, insert:

```ts
    if (!(await pushOrBlock(current, project))) return;
```

Site B — final verdict (lines 639-657). In the `else` branch, immediately before the `if (current.dockerContainer)` block, insert:

```ts
    if (!(await pushOrBlock(current, project))) return;
```

- [ ] **Step 6: Typecheck and run the CLI suite**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/locks.ts packages/cli/src/cli/web/scheduler/task_strategy.ts
git commit -m "feat(scheduler): sync remote repo before worktree, push per-cycle and gate finalize on push"
```

---

### Task 6: web API — sync/repo-status endpoints, project fields, discard wiring

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts` (projects routes ~299-349, discard ~479-495, delete ~538-569)
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts:662-690` (`taskDiscardWorktreeTool`)
- Verify: typecheck + full CLI suite (no HTTP-route test harness exists in this repo; route behaviour is thin glue over the Task 3/4 tested functions).

**Interfaces:**
- Consumes: `syncProjectRepo`, `projectRepoStatus`, `projectWorkingDir` (Task 3), `discardWorktree` 3-arg (Task 4), `syncingProjects` (Task 5), `stream` from `hono/streaming` (already used by voice_backend.ts).
- Produces: `POST /api/projects/:id/sync` (ndjson), `GET /api/projects/:id/repo-status`, extended `POST /api/projects`.

- [ ] **Step 1: Extend `POST /api/projects`**

In server.ts, in the POST handler (line 299): add `repositoryUrl, repositoryToken` to the destructuring, then before building `project`:

```ts
      const repoUrl = typeof repositoryUrl === 'string' ? repositoryUrl.trim() : '';
      if (repoUrl && !repoUrl.startsWith('https://')) {
        return c.json({ error: 'repositoryUrl must start with https:// (SSH is not supported)' }, 400);
      }
```

Add to the `project` object literal (after `dockerImage`):

```ts
        repositoryUrl: repoUrl || null,
        repositoryToken:
          repoUrl && typeof repositoryToken === 'string' && repositoryToken.trim()
            ? repositoryToken.trim()
            : null,
```

(`saveConfig` — Task 1 — encrypts the token; nothing else to do here.)

- [ ] **Step 2: Add the sync and repo-status endpoints**

Add after the `DELETE /api/projects/:id` route (line 349). Imports: add `syncProjectRepo, projectRepoStatus` to the `lib/task_git.js` import, `syncingProjects` to the `scheduler/locks.js` import, and `stream` from `'hono/streaming'`:

```ts
  // Clone-or-pull a remote-backed project's repository. Progress streams as
  // ndjson (voice-backend pattern); failures travel in-band as an `error` line
  // so URL/token problems are diagnosable from the UI.
  app.post('/api/projects/:id/sync', async (c) => {
    const id = Number(c.req.param('id'));
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === id);
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.repositoryUrl?.trim()) return c.json({ error: 'project has no repository URL' }, 400);
    if (syncingProjects.has(id)) return c.json({ error: 'sync already running' }, 409);
    syncingProjects.add(id);
    c.header('Content-Type', 'application/x-ndjson');
    return stream(c, async (s) => {
      try {
        for await (const p of syncProjectRepo(project)) {
          await s.writeln(JSON.stringify(p));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await s.writeln(JSON.stringify({ step: 'error', message }));
      } finally {
        syncingProjects.delete(id);
      }
    });
  });

  // Derived repo state — disk + in-flight set at request time, nothing stored.
  app.get('/api/projects/:id/repo-status', async (c) => {
    const id = Number(c.req.param('id'));
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === id);
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.repositoryUrl?.trim()) return c.json({ error: 'project has no repository URL' }, 400);
    if (syncingProjects.has(id)) return c.json({ state: 'syncing' });
    return c.json(await projectRepoStatus(project));
  });
```

- [ ] **Step 3: Wire push into the discard endpoint**

Replace the body of `POST /api/tasks/:id/discard-worktree` (lines 479-495) with:

```ts
    const taskId = Number(c.req.param('id'));
    const task = await getTaskById(taskId);
    if (!task) return c.json({ ok: false, error: 'not found' }, 404);
    if (!task.worktreePath) return c.json({ ok: false, error: 'no worktree' }, 400);

    if (task.dockerContainer) {
      await removeContainer(task.dockerContainer);
      task.dockerContainer = null;
      task.updatedAt = new Date().toISOString();
      await saveTask(task);
    }
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    const repoUrl = project?.repositoryUrl?.trim();
    try {
      await discardWorktree(
        task.worktreePath,
        task.title,
        repoUrl && task.branch
          ? { branch: task.branch, url: repoUrl, token: project?.repositoryToken }
          : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: `Discard aborted — worktree kept. ${message}` }, 500);
    }
    task.worktreePath = null;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return c.json({ ok: true, branch: task.branch });
```

- [ ] **Step 4: Wire push into `DELETE /api/tasks/:id` (best-effort)**

In the delete handler (lines 559-565), replace the `discardWorktree` call:

```ts
    if (task.worktreePath) {
      try {
        const config = await loadConfig();
        const project = (config.projects || []).find((p) => p.id === task.projectId);
        const repoUrl = project?.repositoryUrl?.trim();
        await discardWorktree(
          task.worktreePath,
          task.title,
          repoUrl && task.branch
            ? { branch: task.branch, url: repoUrl, token: project?.repositoryToken }
            : undefined,
        );
      } catch {
        // Best-effort: the user is deleting the task; a failed push must not
        // block deletion (the branch still survives in the local clone).
      }
    }
```

- [ ] **Step 5: Wire push into the `task_discard_worktree` tool**

In `packages/cli/src/harness/tools/builtin/task_tools.ts` (`taskDiscardWorktreeTool.execute`, lines 673-689), replace the `discardWorktree` call block:

```ts
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    const repoUrl = project?.repositoryUrl?.trim();
    try {
      await discardWorktree(
        task.worktreePath,
        task.title,
        repoUrl && task.branch
          ? { branch: task.branch, url: repoUrl, token: project?.repositoryToken }
          : undefined,
      );
    } catch (e) {
      return err(`Discard aborted — worktree kept: ${e instanceof Error ? e.message : String(e)}`);
    }
```

(`loadConfig` is already imported in task_tools.ts.)

- [ ] **Step 6: Typecheck, run suite, commit**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test`
Expected: clean.

```bash
git add packages/cli/src/cli/web/server.ts packages/cli/src/harness/tools/builtin/task_tools.ts
git commit -m "feat(web): project sync/repo-status endpoints, repository fields, push-aware discard"
```

---

### Task 7: webview UI — repository fields, validation, sync button + badge

**Files:**
- Create: `packages/webview-ui/src/project_form_utils.ts`
- Create: `packages/webview-ui/src/project_form_utils.test.ts`
- Create: `packages/webview-ui/src/ProjectRepoSync.tsx`
- Modify: `packages/webview-ui/src/ProjectsTabSettings.tsx`

**Interfaces:**
- Consumes: `POST /api/projects/:id/sync` (ndjson) and `GET /api/projects/:id/repo-status` from Task 6; `ProjectConfig.repositoryUrl/repositoryToken` from Task 1.
- Produces: `validateRepositoryUrl(url: string): string | null` (null = valid); `<ProjectRepoSync projectId={number} />`.

- [ ] **Step 1: Write the failing validation test**

Create `packages/webview-ui/src/project_form_utils.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepositoryUrl } from './project_form_utils.js';

test('validateRepositoryUrl accepts empty and https, rejects ssh and everything else', () => {
  assert.equal(validateRepositoryUrl(''), null);
  assert.equal(validateRepositoryUrl('   '), null);
  assert.equal(validateRepositoryUrl('https://github.com/org/repo.git'), null);
  assert.match(validateRepositoryUrl('git@github.com:org/repo.git')!, /SSH/);
  assert.match(validateRepositoryUrl('ssh://git@host/repo.git')!, /SSH/);
  assert.match(validateRepositoryUrl('http://host/repo.git')!, /https:\/\//);
  assert.match(validateRepositoryUrl('ftp://host/repo')!, /https:\/\//);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F webview-ui test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

Create `packages/webview-ui/src/project_form_utils.ts`:

```ts
/** Empty or a valid https URL → null; anything else → the error message to show. */
export function validateRepositoryUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith('git@') || u.startsWith('ssh://')) {
    return 'SSH remotes are not supported — use an https:// URL with an access token.';
  }
  if (!u.startsWith('https://')) return 'Repository URL must start with https://';
  return null;
}
```

Run: `pnpm -F webview-ui test` — expected: PASS.

- [ ] **Step 4: Create the sync button + badge component**

Create `packages/webview-ui/src/ProjectRepoSync.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';

type RepoStatus = { state: 'absent' | 'syncing' | 'cloned' | 'broken'; branch?: string; commit?: string };

function badgeText(s: RepoStatus): string {
  if (s.state === 'cloned') return s.branch ? `cloned: ${s.branch} @ ${s.commit ?? '?'}` : 'cloned';
  if (s.state === 'syncing') return 'syncing…';
  if (s.state === 'broken') return 'broken (will re-clone)';
  return 'not cloned';
}

/** Repo badge + Clone/Sync button for a saved remote-backed project. Renders
 *  nothing where the API doesn't exist (non-web surfaces): the status fetch
 *  fails and the block stays hidden — same mechanism as the voice backend UI. */
export function ProjectRepoSync({ projectId }: { projectId: number }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetch(`/api/projects/${projectId}/repo-status`)
      .then((r) => (r.ok ? (r.json() as Promise<RepoStatus>) : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const sync = async () => {
    setBusy(true);
    setProgress('');
    try {
      const res = await fetch(`/api/projects/${projectId}/sync`, { method: 'POST' });
      if (res.status === 409) {
        setProgress('A sync is already running.');
        return;
      }
      if (!res.ok || !res.body) {
        setProgress(`Sync failed: HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const p = JSON.parse(line) as { step: string; message: string };
            setProgress(p.step === 'error' ? `Sync failed: ${p.message}` : p.message);
          } catch {
            // Ignore malformed progress lines; the final refresh tells the truth.
          }
        }
      }
    } catch (err) {
      setProgress(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (status === null) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
      <div className="settings-card__badge">{busy ? 'syncing…' : badgeText(status)}</div>
      <button className="btn btn--secondary btn--xs" onClick={sync} disabled={busy}>
        {status.state === 'absent' ? 'Clone now' : 'Sync now'}
      </button>
      {progress && (
        <span style={{ fontSize: '10px', opacity: 0.75, fontFamily: 'var(--font-mono)' }}>{progress}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire the form fields into `ProjectsTabSettings.tsx`**

All edits in `packages/webview-ui/src/ProjectsTabSettings.tsx`:

a. Imports:

```ts
import { validateRepositoryUrl } from './project_form_utils.js';
import { ProjectRepoSync } from './ProjectRepoSync.js';
```

b. Form state (after the `dockerImage` state, line 29):

```ts
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [repositoryToken, setRepositoryToken] = useState('');
```

c. In `startEdit` (after `setDockerImage(...)`): `setRepositoryUrl(proj.repositoryUrl || ''); setRepositoryToken('');`
   In `startCreate` (after `setDockerImage('')`): `setRepositoryUrl(''); setRepositoryToken('');`

d. In `validateAndSave`, compute before the checks:

```ts
    const trimmedRepoUrl = repositoryUrl.trim();
    const repoUrlError = validateRepositoryUrl(trimmedRepoUrl);
    if (repoUrlError) {
      setErrorMsg(repoUrlError);
      return;
    }
```

Relax the workingDir requirement (replace the existing `if (!trimmedDir)` check):

```ts
    if (!trimmedDir && !trimmedRepoUrl) {
      setErrorMsg('Local Working Directory Path is required (or set a Repository URL to use a managed clone).');
      return;
    }
```

e. Add the two fields to both branches of the save (`newProj` object and the edit spread), after `dockerImage`:

Creating:

```ts
        repositoryUrl: trimmedRepoUrl || null,
        repositoryToken: trimmedRepoUrl && repositoryToken.trim() ? repositoryToken.trim() : null,
```

Editing:

```ts
          repositoryUrl: trimmedRepoUrl || null,
          repositoryToken: trimmedRepoUrl
            ? repositoryToken.trim() || editingProject.repositoryToken || null
            : null,
```

(Blank token input on edit = keep the saved encrypted blob; clearing the URL clears the token.)

f. Add the form fields after the working-dir `form-group` (line 227). Note the placeholder communicates the managed default:

```tsx
          <div className="form-group">
            <label htmlFor="project-repo-url">Repository URL (optional)</label>
            <input
              id="project-repo-url"
              type="text"
              placeholder="https://github.com/org/repo.git"
              value={repositoryUrl}
              onChange={(e) => setRepositoryUrl(e.target.value)}
            />
            <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0', lineHeight: 1.5 }}>
              Remote-backed project: caretaker clones this HTTPS repository itself (into the
              directory above, or a managed folder under <code>~/.caretaker/repos/</code> when the
              directory is left empty), pulls right before each task starts, and pushes task
              branches back to the remote. SSH URLs are not supported.
            </p>
          </div>

          {repositoryUrl.trim() && (
            <div className="form-group">
              <label htmlFor="project-repo-token">Repository access token (optional)</label>
              <input
                id="project-repo-token"
                type="password"
                placeholder={editingProject?.repositoryToken ? '•••••••• (leave blank to keep saved token)' : 'e.g. a GitHub/GitLab PAT'}
                value={repositoryToken}
                onChange={(e) => setRepositoryToken(e.target.value)}
                autoComplete="off"
              />
              <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0' }}>
                Stored encrypted. Sent as the <code>x-access-token</code> password over HTTPS only —
                never embedded in the URL. Leave empty for public repositories.
              </p>
            </div>
          )}
```

g. In the saved-project card body (after the badges row at line 411), add:

```tsx
                    {proj.repositoryUrl && <ProjectRepoSync projectId={proj.id} />}
```

- [ ] **Step 6: Build, test, commit**

Run: `pnpm -F webview-ui test && pnpm -F webview-ui build && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: all clean.

```bash
git add packages/webview-ui/src/project_form_utils.ts packages/webview-ui/src/project_form_utils.test.ts packages/webview-ui/src/ProjectRepoSync.tsx packages/webview-ui/src/ProjectsTabSettings.tsx
git commit -m "feat(webview): repository URL/token fields and clone-sync affordance for projects"
```

---

### Task 8: propagate resolved working dir, docs, changeset

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts:62` (`project_list` output)
- Modify: `CLAUDE.md` (layer 5 + State on disk), `README.md`
- Create: `.changeset/project-remote-repository.md`

**Interfaces:**
- Consumes: `projectWorkingDir` (Task 3).

- [ ] **Step 1: Resolve the working dir in `project_list`**

In `packages/cli/src/harness/tools/builtin/task_tools.ts` line 62, replace `workingDir: project.workingDir,` with:

```ts
              workingDir: projectWorkingDir(project),
```

and add `projectWorkingDir` to the existing `lib/task_git.js` import in that file (add the import if the file doesn't have one). Agents then see the effective directory, not a blank string, for managed clones.

- [ ] **Step 2: Update CLAUDE.md**

In the layer-5 **Git worktree isolation** bullet, after the sentence introducing worktree creation, add:

```
Remote-backed projects (`ProjectConfig.repositoryUrl`, HTTPS + optional encrypted `repositoryToken`, `x-access-token` convention) are cloned/ff-pulled host-side by `syncProjectRepo` (`lib/task_git.ts`) right before the first worktree is created — into `workingDir`, or a managed `~/.caretaker/repos/<projectId>` when blank (`projectWorkingDir`, runtime-resolved). Clones are atomic (temp sibling + rename); a broken destination is auto-wiped **only** on the managed path, never on a user-chosen `workingDir`. Sync failures block the task (bootstrap pattern). Pushes: best-effort after each per-cycle WIP commit; **gating** before every `finalizeDone` and before manual discard (`pushOrBlock` — failure blocks the task, worktree kept; discard endpoints/tool return the error). Task deletion pushes best-effort. Token auth is an inline credential helper reading `CARETAKER_GIT_TOKEN` from the child env — never argv, never `.git/config`. Concurrency: `syncingProjects` in `scheduler/locks.ts`, shared with `POST /api/projects/:id/sync` (ndjson progress, voice-backend pattern; 409 when in flight) and `GET /api/projects/:id/repo-status` (state derived from disk, never persisted).
```

In **State on disk** §1, extend the project-config sentence to mention `repositoryUrl`/`repositoryToken` (encrypted like the Telegram/voice keys in `saveConfig`).

- [ ] **Step 3: Update README.md**

In the projects/tasks section, add a short user-facing paragraph: remote-backed projects (repository URL + optional access token in project settings), managed clone location default, pull-before-task, push-per-cycle/at-completion behaviour, the Clone/Sync button, and the note that a push failure blocks the task until unblocked.

- [ ] **Step 4: Create the changeset**

Create `.changeset/project-remote-repository.md`:

```md
---
'@hyperwindmill/caretaker-cli': minor
'caretaker-types': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
---

Projects can be backed by a remote HTTPS git repository: caretaker clones the repo itself (into the project directory, or a managed folder under `~/.caretaker/repos/` by default), pulls right before each task's worktree is created, and pushes task branches to the remote — after every work cycle (best-effort) and, as a hard gate, before worktrees are removed at task completion or manual discard. Access tokens are stored encrypted and passed to git via an inline credential helper (never on the command line or in `.git/config`). The Projects settings UI gains Repository URL/token fields plus a Clone/Sync button with streamed progress and a derived repo-status badge (`POST /api/projects/:id/sync`, `GET /api/projects/:id/repo-status`).
```

- [ ] **Step 5: Full verification and commit**

Run: `pnpm build && pnpm test`
Expected: every package builds and tests green.

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts CLAUDE.md README.md .changeset/project-remote-repository.md
git commit -m "docs: document remote-backed projects; add changeset"
```
