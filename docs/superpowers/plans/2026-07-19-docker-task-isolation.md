# Docker Environment Isolation (autonomous tasks) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Executor note:** this plan targets a fast executor (Gemini). Each task is
> self-contained, assumes no prior context, and ends with an independently
> verifiable deliverable. Final whole-branch review happens separately.

**Goal:** Let an autonomous task's agent run its shell work inside a project-defined
Docker image, extending the existing per-task git-worktree isolation, with file
access confined to the working dir.

**Architecture:** A task-agnostic infra module (`lib/docker.ts`) provides container
primitives and claude-code hook/settings builders. The container's lifecycle is
tied to the task worktree (create on first heartbeat, remove at DONE), orchestrated
by the caller. Enforcement is a *run-level* concern: native agents get a
`docker exec` redirect in the `bash` tool via `ToolContext.dockerContainer`;
claude-code agents get a `PreToolUse` Bash-rewrite hook (via `--settings`) plus a
working-dir-scoped permission allowlist. The harness only *honors* the isolation;
the caller decides to apply it.

**Tech Stack:** TypeScript (ESM, strict), Node built-in test runner via `tsx`,
`docker` CLI on the host, pnpm workspaces, Changesets.

## Global Constraints

- ESM only (`"type": "module"`); imports use explicit `.js` extensions.
- TypeScript `strict` but `noImplicitAny: false`; `moduleResolution: "bundler"`.
- Tests are co-located `*.test.ts`, run with Node's test runner through `tsx`. No Jest/vitest.
- Atomic writes for persisted config/state: never a raw `writeFile` on a destination path.
- All `~/.caretaker/` paths come from accessor functions (`dataDir()`), resolved at call time.
- Subprocess spawns for shell/git/docker use `commandEnv()` from `packages/cli/src/harness/tools/builtin/shell-env.ts`.
- **This is phase 1.** Docker isolation may later be extended to the *agent* level
  (chat + heartbeat + all surfaces). Keep the docker primitives task-agnostic (name
  passed as a parameter), keep the claude-code hook/settings builder separate from
  the task-role `claudeCodeTaskExtras`, and keep config resolution behind a single
  `resolveDockerImage(...)` chokepoint. Do NOT add an `AgentConfig` docker field or
  any chat wiring — out of scope.
- Run the whole suite + typecheck after each task: `pnpm -F @hyperwindmill/caretaker-cli test` and `pnpm -F @hyperwindmill/caretaker-cli typecheck` (tests run via tsx and do NOT type-check; typecheck is a separate gate).
- Every task ends with a commit. Changeset lands in the final task.

## File Structure

- **Create** `packages/cli/src/lib/docker.ts` — task-agnostic infra: container argv
  builders, `ensureContainer`/`execInContainer`/`removeContainer`, the PreToolUse
  Bash-rewrite hook script constant, `dockerClaudeSettings()`, `dockerDevAllowlist()`.
- **Create** `packages/cli/src/lib/docker.test.ts` — argv + settings/allowlist tests.
- **Modify** `packages/types/src/index.ts` — `ProjectConfig.dockerImage`.
- **Modify** `packages/cli/src/store/db.ts` — `Task.dockerContainer`.
- **Modify** `packages/cli/src/harness/tools/types.ts` — `ToolContext.dockerContainer`.
- **Modify** `packages/cli/src/harness/loop.ts` — `RunOptions.dockerContainer` → `ToolContext`.
- **Modify** `packages/cli/src/harness/tools/builtin/bash.ts` — docker-exec branch.
- **Modify** `packages/cli/src/harness/tools/builtin/bash.test.ts` — redirect test.
- **Modify** `packages/cli/src/harness/claude_code_runner.ts` — `--settings` in
  `buildClaudeArgs`; write temp settings + hook script when `opts.claudeCode.docker` set.
- **Modify** `packages/cli/src/cli/web/scheduler/task_roles.ts` — `resolveDockerImage()`.
- **Modify** `packages/cli/src/cli/web/scheduler/task_strategy.ts` — ensure container,
  bootstrap-in-container, thread native run, compose claude-code docker extras,
  teardown at DONE.
- **Modify** `packages/cli/src/cli/web/scheduler/task_review.ts` — teardown at finalize.
- **Modify** `packages/cli/src/cli/web/server.ts` — accept `dockerImage` in project create/update.
- **Modify** webview project form (`packages/webview-ui/src/…` project settings) — `dockerImage` input.
- **Modify** `CLAUDE.md`, `README.md`; add a changeset.

---

### Task 1: Config + type fields + `resolveDockerImage`

**Files:**
- Modify: `packages/types/src/index.ts` (ProjectConfig, after `maxRunSeconds`)
- Modify: `packages/cli/src/store/db.ts` (Task interface, after `maxRunSeconds`)
- Modify: `packages/cli/src/cli/web/scheduler/task_roles.ts` (add function)
- Test: `packages/cli/src/cli/web/scheduler/task_roles.test.ts` (create if absent)

**Interfaces:**
- Produces: `ProjectConfig.dockerImage?: string | null`; `Task.dockerContainer?: string | null`;
  `resolveDockerImage(task: Pick<Task,'projectId'>, project: Pick<ProjectConfig,'dockerImage'> | null | undefined): string | null` (returns a trimmed non-empty image ref or `null`).

- [ ] **Step 1: Add the `ProjectConfig.dockerImage` field.**

In `packages/types/src/index.ts`, immediately after the `maxRunSeconds?: number | null;` field of `ProjectConfig`, add:

```ts
  /**
   * Docker image the autonomous task agent runs its shell work inside (e.g.
   * `node:22`). Unset/empty = run on the host worktree in place. Phase-1:
   * project-level only. The worktree is bind-mounted into the container at an
   * identical absolute path; only shell commands + bootstrap run in the
   * container, and file access is confined to the working dir.
   */
  dockerImage?: string | null;
```

- [ ] **Step 2: Add the `Task.dockerContainer` field.**

In `packages/cli/src/store/db.ts`, in the `Task` interface immediately after `maxRunSeconds?: number | null;`, add:

```ts
  /** Name of the docker container isolating this task's runs (set when the
   *  project has a dockerImage). Parallel to branch/worktreePath. */
  dockerContainer?: string | null;
```

- [ ] **Step 3: Write the failing test for `resolveDockerImage`.**

Append to `packages/cli/src/cli/web/scheduler/task_roles.test.ts` (create the file with the imports below if it does not exist):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDockerImage } from './task_roles.js';

test('resolveDockerImage: project image trimmed, else null', () => {
  assert.equal(resolveDockerImage({ projectId: 1 }, { dockerImage: '  node:22 ' }), 'node:22');
  assert.equal(resolveDockerImage({ projectId: 1 }, { dockerImage: '' }), null);
  assert.equal(resolveDockerImage({ projectId: 1 }, { dockerImage: null }), null);
  assert.equal(resolveDockerImage({ projectId: 1 }, null), null);
  assert.equal(resolveDockerImage({ projectId: 1 }, undefined), null);
});
```

- [ ] **Step 4: Run it to confirm it fails.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/task_roles.test.ts`
Expected: FAIL — `resolveDockerImage` is not exported.

- [ ] **Step 5: Implement `resolveDockerImage`.**

In `packages/cli/src/cli/web/scheduler/task_roles.ts`, add after the `resolveMaxRunSeconds` function:

```ts
/**
 * Resolve the docker image for a task's runs. Phase-1: project-level only, so
 * the task arg is accepted (for a future per-task override tier) but unused.
 * This is the single config chokepoint — a later agent-level tier is added here.
 */
export function resolveDockerImage(
  _task: Pick<Task, 'projectId'>,
  project: Pick<ProjectConfig, 'dockerImage'> | null | undefined,
): string | null {
  const img = project?.dockerImage?.trim();
  return img ? img : null;
}
```

- [ ] **Step 6: Run the test to confirm it passes.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/task_roles.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit.**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/types/src/index.ts packages/cli/src/store/db.ts packages/cli/src/cli/web/scheduler/task_roles.ts packages/cli/src/cli/web/scheduler/task_roles.test.ts
git commit -m "feat(tasks): dockerImage/dockerContainer config fields + resolveDockerImage"
```

---

### Task 2: Container primitives in `lib/docker.ts`

**Files:**
- Create: `packages/cli/src/lib/docker.ts`
- Test: `packages/cli/src/lib/docker.test.ts`

**Interfaces:**
- Produces:
  - `containerName(projectId: number, taskId: number): string` → `caretaker-task-<pid>-<tid>`
  - `containerRunArgs(name: string, image: string, mountRoot: string, workdir: string, uid?: number, gid?: number): string[]`
  - `containerExecArgs(name: string, cwd: string, cmd: string): string[]`
  - `ensureContainer(name: string, image: string, mountRoot: string, workdir: string): Promise<void>`
  - `execInContainer(name: string, cwd: string, cmd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; output: string }>`
  - `removeContainer(name: string): Promise<void>`

- [ ] **Step 1: Write the failing test for the argv builders.**

Create `packages/cli/src/lib/docker.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerName, containerRunArgs, containerExecArgs } from './docker.js';

test('containerName is deterministic', () => {
  assert.equal(containerName(3, 42), 'caretaker-task-3-42');
});

test('containerRunArgs: identical-path mount, --user, --name, sleep infinity', () => {
  const args = containerRunArgs('c1', 'node:22', '/wt', '/wt/app', 1000, 1000);
  assert.deepEqual(args, [
    'run', '-d',
    '--user', '1000:1000',
    '-v', '/wt:/wt',
    '-w', '/wt/app',
    '--name', 'c1',
    'node:22',
    'sleep', 'infinity',
  ]);
});

test('containerRunArgs: omits --user when uid/gid undefined', () => {
  const args = containerRunArgs('c1', 'node:22', '/wt', '/wt', undefined, undefined);
  assert.equal(args.includes('--user'), false);
});

test('containerExecArgs wraps in sh -lc', () => {
  assert.deepEqual(containerExecArgs('c1', '/wt/app', 'ls -a'), [
    'exec', '-w', '/wt/app', 'c1', 'sh', '-lc', 'ls -a',
  ]);
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/docker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the primitives.**

Create `packages/cli/src/lib/docker.ts`:

```ts
// Task-agnostic Docker container primitives. The container NAME is always a
// parameter — this module knows nothing about tasks/projects, so a future
// agent-level isolation can reuse it with a different naming scheme + mount.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandEnv } from '../harness/tools/builtin/shell-env.js';

const exec = promisify(execFile);

/** Deterministic container name for a task — the caller's naming policy. */
export function containerName(projectId: number, taskId: number): string {
  return `caretaker-task-${projectId}-${taskId}`;
}

/** `docker run` argv. Mount is identical-path (`-v <root>:<root>`) so host and
 *  container agree on absolute paths. `--user` keeps written files owned by the
 *  host user (else root-owned files break the host WIP commit / review diff).
 *  ponytail: if an image lacks a matching /etc/passwd entry, set HOME=/tmp; tune when a real image needs it. */
export function containerRunArgs(
  name: string,
  image: string,
  mountRoot: string,
  workdir: string,
  uid?: number,
  gid?: number,
): string[] {
  const args = ['run', '-d'];
  if (typeof uid === 'number' && typeof gid === 'number') {
    args.push('--user', `${uid}:${gid}`);
  }
  args.push('-v', `${mountRoot}:${mountRoot}`, '-w', workdir, '--name', name, image, 'sleep', 'infinity');
  return args;
}

export function containerExecArgs(name: string, cwd: string, cmd: string): string[] {
  return ['exec', '-w', cwd, name, 'sh', '-lc', cmd];
}

/** Returns 'running' | 'stopped' | 'absent' for a container name. */
async function containerState(name: string): Promise<'running' | 'stopped' | 'absent'> {
  try {
    const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      env: commandEnv(),
    });
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

/** Idempotent: reuse a running container of this name; recreate a stopped/absent one. */
export async function ensureContainer(
  name: string,
  image: string,
  mountRoot: string,
  workdir: string,
): Promise<void> {
  const state = await containerState(name);
  if (state === 'running') return;
  if (state === 'stopped') await removeContainer(name);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  await exec('docker', containerRunArgs(name, image, mountRoot, workdir, uid, gid), {
    env: commandEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Run one command in the container. Never throws on a non-zero exit — returns
 *  the code + combined output, mirroring the bash tool's contract. */
export async function execInContainer(
  name: string,
  cwd: string,
  cmd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await exec('docker', containerExecArgs(name, cwd, cmd), {
      env: commandEnv(),
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return { exitCode: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { exitCode: code, output: (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '') };
  }
}

export async function removeContainer(name: string): Promise<void> {
  await exec('docker', ['rm', '-f', name], { env: commandEnv() }).catch(() => {});
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/docker.test.ts`
Expected: PASS (argv-builder tests; the exec-spawning functions are not exercised here).

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/cli/src/lib/docker.ts packages/cli/src/lib/docker.test.ts
git commit -m "feat(docker): task-agnostic container primitives (lib/docker.ts)"
```

---

### Task 3: claude-code hook script + settings/allowlist builders

**Files:**
- Modify: `packages/cli/src/lib/docker.ts`
- Modify: `packages/cli/src/lib/docker.test.ts`

**Interfaces:**
- Produces:
  - `DOCKER_BASH_HOOK_SCRIPT: string` — a `.mjs` source that reads a PreToolUse hook payload on stdin and emits `updatedInput.command` wrapping the original Bash command in `docker exec`. Invoked as `node <scriptPath> <container> <workdir>`.
  - `dockerClaudeSettings(container: string, workdir: string, hookScriptPath: string): Record<string, unknown>` — a Claude Code settings object registering the hook for the `Bash` matcher.
  - `dockerDevAllowlist(workdir: string): string[]` — permission allowlist confining file tools to `workdir`, allowing `Bash` (contained by docker), `Glob`/`Grep`, and `mcp__task`.

- [ ] **Step 1: Write the failing tests.**

Append to `packages/cli/src/lib/docker.test.ts`:

```ts
import { DOCKER_BASH_HOOK_SCRIPT, dockerClaudeSettings, dockerDevAllowlist } from './docker.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dockerClaudeSettings registers a PreToolUse Bash hook', () => {
  const s = dockerClaudeSettings('c1', '/wt/app', '/tmp/h.mjs') as any;
  const entry = s.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash');
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'node /tmp/h.mjs c1 /wt/app');
});

test('dockerDevAllowlist confines writers to workdir, allows Bash', () => {
  const a = dockerDevAllowlist('/wt/app');
  assert.ok(a.includes('Bash'));
  assert.ok(a.includes('mcp__task'));
  assert.ok(a.some((r) => r.startsWith('Edit(') && r.includes('/wt/app')));
  assert.ok(a.some((r) => r.startsWith('Write(') && r.includes('/wt/app')));
});

test('DOCKER_BASH_HOOK_SCRIPT wraps stdin command in docker exec (base64 round-trip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docker-hook-test-'));
  const script = join(dir, 'hook.mjs');
  writeFileSync(script, DOCKER_BASH_HOOK_SCRIPT);
  const payload = JSON.stringify({ tool_input: { command: 'echo "hi there" && ls' } });
  const out = execFileSync('node', [script, 'c1', '/wt/app'], { input: payload }).toString();
  const parsed = JSON.parse(out);
  const wrapped = parsed.hookSpecificOutput.updatedInput.command;
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(wrapped.startsWith('docker exec -w /wt/app c1 sh -lc '));
  // the base64 payload decodes back to the original command
  const b64 = wrapped.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)![1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'echo "hi there" && ls');
});
```

- [ ] **Step 2: Run to confirm failure.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/docker.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement the builders + hook script.**

Append to `packages/cli/src/lib/docker.ts`:

```ts
// PreToolUse hook: rewrite every Bash command so it runs inside the container.
// Mechanical (not a prompt instruction) — the agent cannot forget. argv:
// [container, workdir]. base64 dodges nested-quote hell in the wrapped command.
export const DOCKER_BASH_HOOK_SCRIPT = `let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const [container, workdir] = process.argv.slice(2);
  let cmd = '';
  try { cmd = JSON.parse(raw)?.tool_input?.command ?? ''; } catch { cmd = ''; }
  const b64 = Buffer.from(cmd, 'utf8').toString('base64');
  const wrapped = \`docker exec -w \${workdir} \${container} sh -lc "echo \${b64} | base64 -d | sh"\`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: wrapped } },
  }));
});
`;

export function dockerClaudeSettings(
  container: string,
  workdir: string,
  hookScriptPath: string,
): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${hookScriptPath} ${container} ${workdir}` }],
        },
      ],
    },
  };
}

/** Confine claude-code file tools to the working dir. Bash is allowed (the docker
 *  hook contains it); writers are path-scoped to workdir; mcp__task stays open. */
export function dockerDevAllowlist(workdir: string): string[] {
  const scope = `${workdir}/**`;
  return [
    `Read(${scope})`,
    `Edit(${scope})`,
    `Write(${scope})`,
    `MultiEdit(${scope})`,
    'Glob',
    'Grep',
    'mcp__task',
    'Bash',
  ];
}
```

- [ ] **Step 4: Run to confirm pass.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/docker.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/cli/src/lib/docker.ts packages/cli/src/lib/docker.test.ts
git commit -m "feat(docker): claude-code PreToolUse Bash-rewrite hook + confinement allowlist"
```

> ⚠️ **Verification deferred to Task 8 (live smoke):** the exact Claude Code
> permission-rule path prefix (e.g. `Edit(/abs/**)` vs `Edit(//abs/**)`) and the
> hook stdin field (`tool_input.command`) must be confirmed against a real `claude`
> CLI. Adjust `dockerDevAllowlist` / the hook script if the live smoke shows the
> confinement or rewrite does not take effect.

---

### Task 4: Native `bash` tool docker-exec redirect

**Files:**
- Modify: `packages/cli/src/harness/tools/types.ts` (ToolContext)
- Modify: `packages/cli/src/harness/loop.ts` (RunOptions + ctx)
- Modify: `packages/cli/src/harness/tools/builtin/bash.ts`
- Test: `packages/cli/src/harness/tools/builtin/bash.test.ts`

**Interfaces:**
- Consumes: `containerExecArgs` from `lib/docker.ts` (Task 2).
- Produces: `ToolContext.dockerContainer?: string`; `RunOptions.dockerContainer?: string`.

- [ ] **Step 1: Add `ToolContext.dockerContainer`.**

In `packages/cli/src/harness/tools/types.ts`, inside `ToolContext` (after `sessionId?`), add:

```ts
  /** When set, the `bash` tool runs commands inside this docker container
   *  (`docker exec`) instead of on the host. A run-level isolation property —
   *  the caller decides; the tool only honors it. */
  dockerContainer?: string;
```

- [ ] **Step 2: Add `RunOptions.dockerContainer` and thread it into the context.**

In `packages/cli/src/harness/loop.ts`: in `RunOptions` (after `claudeCode?`), add:

```ts
  /** Native-loop only: run `bash` commands inside this docker container. */
  dockerContainer?: string;
```

In the same file, in the `toolCtx` object literal (currently ends with `sessionId: opts.sessionId,`), add:

```ts
    dockerContainer: opts.dockerContainer,
```

- [ ] **Step 3: Write the failing redirect test.**

In `packages/cli/src/harness/tools/builtin/bash.test.ts`, add a test that asserts the spawn goes through `docker exec` when `ctx.dockerContainer` is set. Match the file's existing spawn-mocking style; if it does not mock spawn, use this self-contained form:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashTool } from './bash.js';

test('bash redirects into docker exec when ctx.dockerContainer is set', async () => {
  const res = await bashTool.execute(
    { command: 'echo docker-redirect-marker' },
    {
      signal: new AbortController().signal,
      workingDir: '/tmp',
      readPaths: new Set(),
      dockerContainer: '__caretaker_no_such_container__',
    } as any,
  );
  // No such container → docker exec fails fast; the point is the command was
  // routed to `docker`, not run on the host (host `echo` would have succeeded).
  assert.match(res.content, /docker|No such container|Cannot connect|not found/i);
  assert.doesNotMatch(res.content, /docker-redirect-marker/);
});
```

- [ ] **Step 4: Run to confirm failure.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/bash.test.ts`
Expected: FAIL — host `echo` runs, output contains `docker-redirect-marker`.

- [ ] **Step 5: Implement the redirect.**

In `packages/cli/src/harness/tools/builtin/bash.ts`:

1. Add the import at the top (after the existing imports):

```ts
import { containerExecArgs } from '../../../lib/docker.js';
```

2. Replace the spawn block (the `const isWindows = …` through the `spawn('bash', …)` ternary — the block that currently builds `child`) with:

```ts
      // Docker isolation (run-level): route the command through the task
      // container instead of the host. Precedes the platform branch — when a
      // container is set we always use `docker exec`.
      const isWindows = process.platform === 'win32';
      const child = ctx.dockerContainer
        ? spawn('docker', containerExecArgs(ctx.dockerContainer, ctx.workingDir, a.command as string), {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: bashEnv(),
          })
        : isWindows
          ? spawn(a.command as string, [], {
              cwd: ctx.workingDir,
              shell: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: bashEnv(),
            })
          : spawn('bash', ['-c', a.command as string], {
              cwd: ctx.workingDir,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: bashEnv(),
            });
```

- [ ] **Step 6: Run to confirm pass.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/bash.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit.**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/cli/src/harness/tools/types.ts packages/cli/src/harness/loop.ts packages/cli/src/harness/tools/builtin/bash.ts packages/cli/src/harness/tools/builtin/bash.test.ts
git commit -m "feat(tasks): native bash tool runs in docker container when set"
```

---

### Task 5: `--settings` support in the claude-code runner

**Files:**
- Modify: `packages/cli/src/harness/claude_code_runner.ts`
- Test: `packages/cli/src/harness/claude_code_runner.test.ts` (add a `buildClaudeArgs` case)

**Interfaces:**
- Consumes: `DOCKER_BASH_HOOK_SCRIPT`, `dockerClaudeSettings` from `lib/docker.ts` (Task 3).
- Produces:
  - `ClaudeArgsInput.settingsPath?: string` → emits `--settings <path>`.
  - `ClaudeCodeRunExtras.docker?: { container: string; workdir: string }` — when set, the runner writes a temp hook script + settings file and passes `--settings`.

- [ ] **Step 1: Write the failing `buildClaudeArgs` test.**

In `packages/cli/src/harness/claude_code_runner.test.ts`, add:

```ts
test('buildClaudeArgs emits --settings when settingsPath is set', () => {
  const args = buildClaudeArgs({ persistSession: false, settingsPath: '/tmp/s.json' });
  const i = args.indexOf('--settings');
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], '/tmp/s.json');
});
```

(Ensure `buildClaudeArgs` is imported in that test file; it is already exported from the runner.)

- [ ] **Step 2: Run to confirm failure.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_runner.test.ts`
Expected: FAIL — `--settings` absent.

- [ ] **Step 3: Add `settingsPath` to `ClaudeArgsInput` + `buildClaudeArgs`.**

In `packages/cli/src/harness/claude_code_runner.ts`:

In `ClaudeArgsInput` add `settingsPath?: string;` (after `mcpConfigPath?`). In `buildClaudeArgs`, after the `mcpConfigPath` line, add:

```ts
  if (i.settingsPath) args.push('--settings', i.settingsPath);
```

- [ ] **Step 4: Run to confirm pass.**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `docker` extra + temp-file wiring.**

In `packages/cli/src/harness/claude_code_runner.ts`:

1. Add the import (after the existing `resolvedServerRuntime` import):

```ts
import { DOCKER_BASH_HOOK_SCRIPT, dockerClaudeSettings } from '../lib/docker.js';
```

2. In `ClaudeCodeRunExtras`, add:

```ts
  docker?: { container: string; workdir: string };
```

3. In `runClaudeCode`, after the mcp-config temp file is built (`const mcp = await buildMcpConfigFile(...)`), add the settings temp-file block:

```ts
  // Per-run --settings temp file: registers the PreToolUse Bash-rewrite hook
  // so claude-code shell commands run inside the task's docker container.
  let settings: { settingsPath: string; cleanup: () => Promise<void> } | null = null;
  if (opts.claudeCode?.docker) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'caretaker-cc-settings-'));
    const hookPath = path.join(dir, 'docker-hook.mjs');
    await writeFile(hookPath, DOCKER_BASH_HOOK_SCRIPT, { mode: 0o700 });
    const settingsPath = path.join(dir, 'settings.json');
    const obj = dockerClaudeSettings(opts.claudeCode.docker.container, opts.claudeCode.docker.workdir, hookPath);
    await writeFile(settingsPath, JSON.stringify(obj), { mode: 0o600 });
    settings = { settingsPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }
```

4. In `runAttempt`'s `buildClaudeArgs({...})` call, add:

```ts
      settingsPath: settings?.settingsPath,
```

5. In the outer `finally` block (currently `await mcp?.cleanup().catch(() => {});`), add:

```ts
    await settings?.cleanup().catch(() => {});
```

- [ ] **Step 6: Typecheck + run the runner tests.**

Run:
```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_runner.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/cli/src/harness/claude_code_runner.ts packages/cli/src/harness/claude_code_runner.test.ts
git commit -m "feat(claude-code): --settings temp file with docker Bash-rewrite hook"
```

---

### Task 6: Heartbeat integration — ensure container, bootstrap-in-container, wire both providers

**Files:**
- Modify: `packages/cli/src/lib/task_git.ts` (`runBootstrap` gains an optional container)
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts`

**Interfaces:**
- Consumes: `ensureContainer`, `execInContainer`, `containerName` from `lib/docker.ts`;
  `resolveDockerImage` from `task_roles.ts`; `dockerDevAllowlist` from `lib/docker.ts`.
- Produces: containers created/reused per tick; `task.dockerContainer` persisted;
  native runs carry `dockerContainer`; claude-code runs carry `claudeCode.docker` +
  confinement extras.

- [ ] **Step 1: Make `runBootstrap` container-aware.**

In `packages/cli/src/lib/task_git.ts`:

1. Add the import:

```ts
import { execInContainer } from './docker.js';
```

2. Change the signature and body of `runBootstrap`. Replace the current function with:

```ts
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
```

- [ ] **Step 2: Import the docker helpers into the heartbeat.**

In `packages/cli/src/cli/web/scheduler/task_strategy.ts`, add to the imports:

```ts
import { ensureContainer, removeContainer, containerName, dockerDevAllowlist } from '../../../lib/docker.js';
import { resolveDockerImage } from './task_roles.js';
```

(Extend the existing `./task_roles.js` import list rather than duplicating it.)

- [ ] **Step 3: Ensure the container per tick and route bootstrap through it.**

In `runTaskHeartbeatTick`, the git-worktree block currently creates the worktree and runs bootstrap inside the `else if (await isGitRepo(...))` branch. Restructure so the container is ensured for BOTH the "just created" and "reused" cases, and bootstrap (first-creation only) runs inside it.

Replace the worktree/bootstrap region (from `let workingDir = baseWorkingDir;` down to the comment `// Non-git projects fall through: …`) with:

```ts
    let workingDir = baseWorkingDir;
    let mountRoot = baseWorkingDir;
    let worktreeJustCreated = false;

    if (task.worktreePath) {
      workingDir = await agentDirIn(task.worktreePath, baseWorkingDir);
      mountRoot = task.worktreePath;
    } else if (await isGitRepo(baseWorkingDir)) {
      const wt = await ensureWorktree(baseWorkingDir, task.projectId, task.id, task.title);
      task.branch = wt.branch;
      task.worktreePath = wt.worktreePath;
      await saveTask(task);
      workingDir = wt.agentWorkingDir;
      mountRoot = wt.worktreePath;
      worktreeJustCreated = true;
      console.log(`[task_heartbeat] Task #${task.id} worktree ${wt.worktreePath} (branch ${wt.branch})`);
    }
    // Non-git projects fall through: workingDir/mountRoot stay baseWorkingDir (run in place).

    // Docker isolation (project-level, phase 1): ensure the task's container is
    // up (idempotent by name), before bootstrap. A failure blocks the task with
    // the docker error — same policy as a failed bootstrap command.
    const dockerImage = resolveDockerImage(task, project);
    let dockerContainer: string | undefined;
    if (dockerImage) {
      const name = containerName(task.projectId, task.id);
      try {
        await ensureContainer(name, dockerImage, mountRoot, workingDir);
        dockerContainer = name;
        if (task.dockerContainer !== name) {
          task.dockerContainer = name;
          await saveTask(task);
        }
      } catch (dockErr) {
        const reason = dockErr instanceof Error ? dockErr.message : String(dockErr);
        task.status = 'blocked';
        task.blockedReason = reason;
        task.updatedAt = new Date().toISOString();
        await saveTask(task);
        await addTaskMessage({
          taskId: task.id,
          role: 'assistant',
          messageType: 'block',
          content: `Docker container setup failed — task blocked.\n\n${reason}`,
        });
        console.error(`[task_heartbeat] Task #${task.id} docker setup failed, blocked:`, reason);
        return;
      }
    }

    // Project bootstrap: run once in the fresh worktree (inside the container
    // when docker is active) before the agent's first cycle. A failure blocks.
    if (worktreeJustCreated) {
      const bootstrap = (project.bootstrapCommands || []).filter((c) => c.trim());
      if (bootstrap.length > 0) {
        try {
          console.log(`[task_heartbeat] Task #${task.id} running ${bootstrap.length} bootstrap command(s)`);
          await runBootstrap(workingDir, bootstrap, dockerContainer);
        } catch (bootErr) {
          const reason = bootErr instanceof Error ? bootErr.message : String(bootErr);
          task.status = 'blocked';
          task.blockedReason = reason;
          task.updatedAt = new Date().toISOString();
          await saveTask(task);
          await addTaskMessage({
            taskId: task.id,
            role: 'assistant',
            messageType: 'block',
            content: `Bootstrap failed — task blocked.\n\n${reason}`,
          });
          console.error(`[task_heartbeat] Task #${task.id} bootstrap failed, blocked:`, reason);
          return;
        }
      }
    }
```

- [ ] **Step 4: Pass `dockerContainer` into the native run and add the claude-code system-prompt line.**

Still in `runTaskHeartbeatTick`, in the `harness.run({...})` options object (currently includes `workingDir, claudeCode, signal`), add `dockerContainer,`:

```ts
          workingDir,
          claudeCode,
          dockerContainer,
          signal,
```

Then extend the claude-code extras block. Replace the `if (isClaudeCode) { … }` block with:

```ts
    if (isClaudeCode) {
      const bridgeUrl = getTaskBridgeUrl();
      bridgeToken = bridgeUrl ? issueBridgeToken() : undefined;
      claudeCode = claudeCodeTaskExtras({
        planning,
        sdd,
        bridge: bridgeUrl && bridgeToken ? { url: bridgeUrl, token: bridgeToken } : undefined,
      });
      // Docker isolation for claude-code (non-planning): swap bypassPermissions
      // for manual + a workdir-scoped allowlist and attach the Bash-rewrite hook.
      // Planning stays as-is (read-only; no shell to contain).
      if (dockerContainer && !planning) {
        claudeCode = {
          ...claudeCode,
          permissionMode: 'manual',
          allowedTools: dockerDevAllowlist(workingDir),
          disallowedTools: undefined,
          docker: { container: dockerContainer, workdir: workingDir },
        };
      }
      if (!bridgeUrl) {
        console.warn('[tasks] claude-code agent without task bridge URL — task tools unavailable this run');
      }
    }
```

Add the system-prompt transparency line for claude-code + docker. In the prompt construction (the `const prompt = planning ? … : buildPrompt(...)` region), after `const prompt = …`, add:

```ts
    const effectivePrompt =
      isClaudeCode && dockerContainer && !planning
        ? `${prompt}\n\n**Execution environment:** your shell commands run inside a Docker container (image \`${dockerImage}\`) mounted at \`${workingDir}\`. File reads/writes are confined to this directory.`
        : prompt;
```

…and change the `harness.run` call to pass `prompt: effectivePrompt` instead of `prompt`.

- [ ] **Step 5: Typecheck + full suite.**

Run:
```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
```
Expected: all green (no test regression; this task is orchestration — its behavior is covered by the live smoke in Task 8 and the unit tests from Tasks 1-5).

- [ ] **Step 6: Commit.**

```bash
git add packages/cli/src/lib/task_git.ts packages/cli/src/cli/web/scheduler/task_strategy.ts
git commit -m "feat(tasks): run heartbeat agent inside project docker container"
```

---

### Task 7: Container teardown at DONE / review-finalize / discard

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts` (done path + runReviewCycle)
- Modify: `packages/cli/src/cli/web/scheduler/task_review.ts` (only if a finalize path lives there; otherwise skip)
- Modify: the discard flow (`task_discard_worktree` tool / `POST /api/tasks/:id/discard-worktree`)

**Interfaces:**
- Consumes: `removeContainer` from `lib/docker.ts`.

- [ ] **Step 1: Remove the container when a task finalizes in the heartbeat done-path.**

In `packages/cli/src/cli/web/scheduler/task_strategy.ts`, in the git lifecycle block, the `if (gitTask.status === 'done') { … }` branch calls `finalizeDone`. Immediately before `await finalizeDone(gitTask.worktreePath);`, add:

```ts
          if (gitTask.dockerContainer) {
            await removeContainer(gitTask.dockerContainer);
            gitTask.dockerContainer = null;
          }
```

- [ ] **Step 2: Remove the container in both finalize paths of `runReviewCycle`.**

In the same file, `runReviewCycle` finalizes in two places (the review-gate-disabled early path and the PASS/max-rounds path), each calling `await finalizeDone(current.worktreePath!);`. Before EACH of those two `finalizeDone` calls, add:

```ts
    if (current.dockerContainer) {
      await removeContainer(current.dockerContainer);
      current.dockerContainer = null;
    }
```

(`current` is the reloaded task in both branches; it is saved right after `finalizeDone`, so the nulled `dockerContainer` persists.)

- [ ] **Step 3: Remove the container on manual worktree discard.**

Locate the discard handler: `grep -rn "discardWorktree\|discard-worktree\|task_discard_worktree" packages/cli/src`. In the handler that loads the task and calls `discardWorktree(...)` (web route + the `task_discard_worktree` tool), before the discard call, add (adapting the task variable name in scope):

```ts
    if (task.dockerContainer) {
      await removeContainer(task.dockerContainer);
      task.dockerContainer = null;
    }
```

Import `removeContainer` from `../../../lib/docker.js` (adjust the relative depth to the file) wherever it is not already imported. Persist the task if the handler saves it (follow the existing save in that handler).

- [ ] **Step 4: Typecheck + full suite.**

Run:
```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
```
Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "feat(tasks): remove docker container on done/review-finalize/discard"
```

---

### Task 8: Web API + webview form + live smoke

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts` (project create + update)
- Modify: the webview project settings form (`grep -rln "bootstrapCommands" packages/webview-ui/src`)

**Interfaces:**
- Consumes: `ProjectConfig.dockerImage` (Task 1).

- [ ] **Step 1: Accept `dockerImage` in project creation.**

In `packages/cli/src/cli/web/server.ts`, `app.post('/api/projects', …)`: add `dockerImage` to the destructured `body`, and to the `project` object literal:

```ts
        dockerImage: typeof dockerImage === 'string' && dockerImage.trim() ? dockerImage.trim() : null,
```

- [ ] **Step 2: Accept `dockerImage` in project update.**

Find the project update handler (`grep -n "PATCH\|/api/projects/:id\|app.put" packages/cli/src/cli/web/server.ts`). In the handler that mutates an existing project, mirror the pattern used for `bootstrapCommands`/`maxRunSeconds`:

```ts
    if ('dockerImage' in body) {
      project.dockerImage = typeof body.dockerImage === 'string' && body.dockerImage.trim()
        ? body.dockerImage.trim()
        : null;
    }
```

- [ ] **Step 3: Add the form field in the webview.**

In the project settings form component (same one that renders the bootstrap-commands input), add a single-line text input bound to `dockerImage`, labeled "Docker image (optional)", placeholder e.g. `node:22`, with helper text: "Run this project's autonomous task agents inside this image. Empty = run on the host." Include it in the create/update payloads next to `bootstrapCommands`. Follow the existing field's controlled-input pattern exactly.

- [ ] **Step 4: Build webview + typecheck.**

Run:
```bash
pnpm -F webview-ui build
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: both succeed.

- [ ] **Step 5: Live smoke (native provider).**

In an isolated home, with Docker available, create a git project with `dockerImage: node:22`, a native agent, and one task; let the heartbeat run. Confirm from `docker ps` that `caretaker-task-<pid>-<tid>` is up, that a `bash` step (e.g. `node --version`) reflects the image's node, and that a `read_file` outside the worktree is rejected. Command sketch:

```bash
CARETAKER_HOME=/tmp/ct-docker pnpm -F @hyperwindmill/caretaker-cli dev web
# configure via the UI, start a task, then:
docker ps --filter name=caretaker-task-
```

- [ ] **Step 6: Live smoke (claude-code provider) — verify the ⚠️ points from Task 3.**

With a claude-code agent + `dockerImage`, run one task cycle. Confirm: (a) shell commands actually execute in the container (`docker exec` visible / node version matches the image), and (b) a write/read outside the worktree is denied. If confinement or the rewrite does not take effect, adjust `dockerDevAllowlist` (permission-rule path prefix) and/or the hook stdin field in `lib/docker.ts`, re-run, and amend the Task 3 commit's follow-up. Record the confirmed rule syntax in a code comment.

- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "feat(web): dockerImage project setting (API + form)"
```

---

### Task 9: Docs + changeset

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Update `CLAUDE.md`.**

In layer 5's "Git worktree isolation" bullet, add a sentence: after the worktree is created and bootstrap has run, if the project has a `dockerImage`, a per-task container (`caretaker-task-<projectId>-<taskId>`, bind-mounting the worktree at an identical absolute path, `--user` host uid/gid) is ensured each tick and torn down at DONE/discard; native `bash` runs via `docker exec`, claude-code via a `PreToolUse` Bash-rewrite hook (`--settings`) plus a workdir-scoped permission allowlist. In "State on disk", note `ProjectConfig.dockerImage` and `Task.dockerContainer`.

- [ ] **Step 2: Update `README.md`.**

Document the project-level "Docker image" setting: what it does (reproducible env for autonomous tasks), that Docker must be installed on the scheduler host, and that file access is confined to the working dir.

- [ ] **Step 3: Create the changeset.**

Create `.changeset/docker-task-isolation.md`:

```md
---
"@hyperwindmill/caretaker-cli": minor
---

Autonomous tasks can run inside a project-defined Docker image. Set a project's
Docker image to isolate the task agent's shell work in a container (bind-mounting
the task worktree at an identical path); native agents redirect `bash` via
`docker exec`, claude-code agents via a PreToolUse Bash-rewrite hook. File access
is confined to the working dir. Requires Docker on the scheduler host.
```

- [ ] **Step 4: Final gate + commit.**

Run:
```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
```
Expected: green.

```bash
git add CLAUDE.md README.md .changeset/docker-task-isolation.md
git commit -m "docs(docker): document dockerImage isolation + changeset"
```

---

## Self-Review

**Spec coverage:** dockerImage config (T1, T8) · task-agnostic primitives / seam #1 (T2) · claude-code hook+allowlist / seam #2 (T3) · native redirect + run-level ToolContext / seam #3 (T4) · `--settings` plumbing (T5) · container lifecycle create+bootstrap (T6) · file-tool confinement both providers (T4 native via sandbox.ts already, T3+T6 claude-code) · system-prompt line (T6) · teardown (T7) · `resolveDockerImage` chokepoint / seam #4 (T1) · docs+changeset (T9). All spec sections mapped.

**Placeholder scan:** none — every code step carries full code; the only deferred
items are the two live-verification points (permission-rule prefix, hook stdin
field), which are explicit verification *steps* in Tasks 3/8, not code gaps.

**Type consistency:** `resolveDockerImage`, `containerName`, `containerExecArgs`,
`dockerClaudeSettings`, `dockerDevAllowlist`, `ClaudeCodeRunExtras.docker`,
`ClaudeArgsInput.settingsPath`, `ToolContext.dockerContainer`,
`RunOptions.dockerContainer`, `Task.dockerContainer`, `ProjectConfig.dockerImage`
are defined once and consumed with matching names/signatures across tasks.
