# Plan: Fix project setup — bootstrap commands can't find `pnpm`

## Task

- **ID:** 13
- **Title:** Fix project setup
- **Symptom:** `Bootstrap command failed: \`pnpm install\` / /bin/sh: 1: pnpm: not found`
- **Root cause:** `runBootstrap` in `packages/cli/src/lib/task_git.ts` spawns each
  bootstrap command via `execShell(cmd, { cwd, ... })` with **no `env` option**, so the
  child inherits `process.env` verbatim. On Linux the caretaker process is launched as a
  non-interactive shell, so `~/.bashrc` (which exports the version-manager PATH that puts
  `pnpm`/`node`/`nvm`/`fnm`/`volta` on `PATH`) is never sourced. The result: `pnpm` is
  not on the inherited `PATH` and the bootstrap fails on the very first command, blocking
  the task.

## Context — why this is the right fix

The harness already solved this exact problem for the agent's own `bash` tool. On boot,
`packages/cli/src/index.ts` fires `probeShellEnv()` (from
`harness/tools/builtin/shell-env.ts`) in the background. That probe spawns an
**interactive** shell (`bash -i -c 'env'`, detached so it doesn't grab the TTY), parses
out `PATH` plus version-manager vars (`NVM_DIR`, `VOLTA_HOME`, `FNM_DIR`, …), and caches
the result. The `bash` builtin then calls `mergeShellEnv(scrubbedEnv())` to prepend the
probed `PATH` and inject the other vars before spawning its child (`bash.ts:32-38`,
`bash.ts:80/85`).

`runBootstrap` (and the sibling `git()` helper in the same file) simply never opted into
that machinery — they pass no `env`, so they get the raw, un-probed `process.env`. The
scheduler's task heartbeat (`scheduler/task_strategy.ts:192-196`) calls `runBootstrap`
unattended, in a process that has already completed the probe, so the fix is purely to
reuse the same env-merge the `bash` tool already uses.

This is a **bug fix in existing behaviour**, not a new feature: the bootstrap feature
(shipped in 0.12.0, CHANGELOG `5372744`) was always meant to run `pnpm install` etc., and
it can't on any Linux box where `pnpm` arrives via a version manager. No public contract
changes; no schema change; no new user-facing surface.

## Scope & non-goals

**In scope**
- Make `runBootstrap` resolve commands with the same probed shell environment the `bash`
  tool uses, so version-manager-managed binaries (`pnpm`, `node`, `npx`, …) are on `PATH`.
- Apply the same env to the `git()` helper in `task_git.ts` for consistency (harmless on
  systems where `git` is already at `/usr/bin/git`; fixes git invocations on boxes where
  git itself is only on the user's extended `PATH`).
- Add a focused unit test proving a probed `PATH` is honoured by `runBootstrap`.
- Keep the existing failure semantics: stop at the first non-zero exit, throw with the
  failed command + output (so the scheduler still blocks the task with a clear reason).

**Non-goals (explicitly out of scope)**
- Do **not** change the probe itself (`shell-env.ts`) — it already works and is cached.
- Do **not** add a retry / "install pnpm for me" fallback — the fix is to find the
  user's existing `pnpm`, not to install tooling.
- Do **not** change `claude_code_runner.ts`'s `env: process.env` in this task. It's a
  separate, pre-existing path and Claude Code is expected to be on `PATH` per the README;
  touching it here would expand the blast radius without a reported failure. (Worth a
  follow-up, not this task.)
- Do **not** add new config fields, UI, or API surface.

## Design decisions

### 1. Reuse `mergeShellEnv`, don't duplicate the logic

`mergeShellEnv(existingEnv)` (in `harness/tools/builtin/shell-env.ts`) already does
exactly what we need: prepends the probed `PATH` to the existing one (user tools take
precedence) and sets the other version-manager vars only if not already present. It is a
pure, synchronous, cached getter — no I/O, no probe trigger. Reusing it keeps one source
of truth for "what env do spawned shells get".

### 2. Where the helper lives

`task_git.ts` is under `packages/cli/src/lib/`; `shell-env.ts` is under
`packages/cli/src/harness/tools/builtin/`. Importing across that boundary is fine — the
`harness` layer is not a dependency of `lib`; `lib` may depend on `harness` (there is no
circularity: `shell-env.ts` only imports `node:child_process`). We import
`mergeShellEnv` from `../../../harness/tools/builtin/shell-env.js`. This mirrors how
`bash.ts` already imports it from its sibling.

**Alternative considered:** move `mergeShellEnv`/`getShellEnv` into `lib/` and have both
`bash.ts` and `task_git.ts` import from there. Rejected for this task: it's a larger
refactor with a wider diff and test churn, and the current location is fine — the probe
is a harness-side concern and `lib` depending on it is acceptable. (A future cleanup could
lift it to `lib/shell-env.ts`; not now.)

### 3. Linux-only, like the `bash` tool

`mergeShellEnv` returns the env unchanged on macOS/Windows (the probe returns an empty
result there, see `shell-env.ts:75-83`), so wrapping the call in
`if (process.platform === 'linux')` is an optimization, not a correctness gate. We'll
mirror `bash.ts:34-37` exactly: build a `scrubbedEnv()` base, then `mergeShellEnv` it on
Linux. This keeps the behaviour identical to the `bash` tool, including the secret-scrub
policy, so bootstrap commands get the same env the agent's own shell would.

### 4. Scrub secrets, same as `bash`

Bootstrap commands run in an unattended scheduler context. We must not leak
`*_TOKEN`/`*_KEY`/`*_SECRET`/`OPENCODE_*`/`CLAUDE_*` into the child env any more than the
`bash` tool does. So the base env is `scrubbedEnv()` (the same regex set from `bash.ts`),
then `mergeShellEnv` layers the probed vars on top. We'll factor the scrub list so it
isn't duplicated — see step 2 below.

## Implementation steps

### Step 1 — Export a shared `commandEnv()` helper

File: `packages/cli/src/harness/tools/builtin/shell-env.ts`

Add a small, reusable builder next to `mergeShellEnv`:

```ts
// Secret env patterns scrubbed from spawned command envs. Shared by the bash
// tool and by bootstrap/git spawns so unattended runs don't leak tokens.
export const SECRET_ENV_PATTERNS = [
  /^OPENCODE_/, /^CLAUDE_/, /_TOKEN$/, /_KEY$/, /_SECRET$/,
];

/** Base env for spawned shells: process.env with secret vars scrubbed. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build the env for a spawned shell command: scrubbed process.env, with the
 * probed interactive-shell PATH and version-manager vars merged in on Linux.
 * macOS/Windows return the scrubbed env unchanged (login shells there already
 * source profiles correctly). Mirrors what the `bash` tool uses.
 */
export function commandEnv(): NodeJS.ProcessEnv {
  const base = scrubbedEnv();
  if (process.platform === 'linux') {
    return mergeShellEnv(base);
  }
  return base;
}
```

Then **delete** the local `SECRET_ENV_PATTERNS` and `scrubbedEnv` from
`harness/tools/builtin/bash.ts` and import the shared ones, so `bashEnv()` becomes:

```ts
import { commandEnv } from './shell-env.js';
// ...
function bashEnv(): NodeJS.ProcessEnv {
  return commandEnv();
}
```

(Kept as a thin wrapper so `bash.ts` reads cleanly and the call sites in `bash.ts`
don't change.) This is a pure refactor: identical behaviour, single source of truth.

### Step 2 — Use `commandEnv()` in `task_git.ts`

File: `packages/cli/src/lib/task_git.ts`

- Import `commandEnv` from `../harness/tools/builtin/shell-env.js`.
- In `runBootstrap`, pass `env: commandEnv()` to `execShell`:

  ```ts
  await execShell(cmd, {
    cwd,
    env: commandEnv(),
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  ```

- In the internal `git()` helper, pass `env: commandEnv()` to `exec` as well, so a git
  binary only on the user's extended `PATH` is found. (Git is usually at `/usr/bin/git`,
  so this is defensive and low-risk; it matches the "one env policy for spawned commands"
  direction.)

No other callers of `runBootstrap` or `git()` need changes — they're internal to this
file and the scheduler.

### Step 3 — Unit test: probed PATH is honoured by `runBootstrap`

File: `packages/cli/src/lib/task_git.test.ts`

Add a test that proves the env flows through. We can't rely on a real version manager in
CI, so the test seeds the cache directly:

```ts
test('runBootstrap uses the probed shell environment (PATH) for commands', async () => {
  // Directly populate the shell-env cache as if probeShellEnv() had run, so a
  // binary that only exists on the probed PATH is found by runBootstrap.
  const { setShellEnvForTest } = await import('../harness/tools/builtin/shell-env.js');
  const binDir = await mkdtemp(join(tmpdir(), 'ct-path-'));
  // A fake "pnpm" that just writes a marker file.
  const fakePnpm = join(binDir, 'pnpm');
  await writeFile(fakePnpm, '#!/bin/sh\necho ran > marker.txt\n');
  await chmod(fakePnpm, 0o755);

  const dir = await mkdtemp(join(tmpdir(), 'ct-boot-env-'));
  setShellEnvForTest({ PATH: binDir }); // probed PATH contains only binDir

  await runBootstrap(dir, ['pnpm install']);
  assert.ok((await stat(join(dir, 'marker.txt'))).isFile());

  await rm(binDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});
```

This requires a tiny test-only escape hatch in `shell-env.ts`:

```ts
/** @internal test-only: set the cached probe result directly. */
export function setShellEnvForTest(env: Record<string, string>): void {
  cachedResult = { env, success: true };
}
```

(Placed under the existing `cachedResult`/`getShellEnv` block. Production code never calls
it; it's only for deterministic tests that can't rely on a real interactive shell probe.)

### Step 4 — Changeset

File: `.changeset/fix-bootstrap-shell-env.md` (new)

```markdown
---
"@hyperwindmill/caretaker-cli": patch
---

fix(tasks): bootstrap commands now resolve version-manager binaries (pnpm, npx, …)

`runBootstrap` (the per-project `bootstrapCommands` that run once on a fresh task
worktree) spawned each command with the raw `process.env`, which on Linux does not
source `~/.bashrc`. That left `pnpm`/`node`/`nvm`/`fnm`/`volta` off `PATH` when
installed via a version manager, so `pnpm install` failed with
`/bin/sh: pnpm: not found` and blocked the task. Bootstrap (and the internal
`git()` helper) now reuse the same probed interactive-shell environment the
`bash` tool already uses (`commandEnv()`), so user-installed tooling is found.
Secret env vars (`*_TOKEN`/`*_KEY`/`*_SECRET`/`OPENCODE_*`/`CLAUDE_*`) are
scrubbed the same way as for the `bash` tool.
```

(One package — the change is entirely inside `caretaker-cli`. The fixed group will still
bump all five on release, but only `caretaker-cli` needs a changeset entry; the others
have no code change.)

## Files touched

| File | Change |
|---|---|
| `packages/cli/src/harness/tools/builtin/shell-env.ts` | Add `SECRET_ENV_PATTERNS`, `scrubbedEnv`, `commandEnv`, `setShellEnvForTest` exports |
| `packages/cli/src/harness/tools/builtin/bash.ts` | Use shared `commandEnv()` instead of local `scrubbedEnv`/`SECRET_ENV_PATTERNS` (pure refactor, same behaviour) |
| `packages/cli/src/lib/task_git.ts` | Pass `env: commandEnv()` to `runBootstrap`'s `execShell` and to the internal `git()` helper |
| `packages/cli/src/lib/task_git.test.ts` | Add test proving probed `PATH` is used by `runBootstrap` |
| `.changeset/fix-bootstrap-shell-env.md` | New changeset (patch) |

## Verification

1. `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts` — new test passes, existing tests still pass.
2. `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/bash.test.ts` — bash tool tests still pass (refactor is behaviour-preserving).
3. `pnpm -F @hyperwindmill/caretaker-cli typecheck` — no type errors from the new import.
4. Manual: with a Linux box where `pnpm` is on the nvm/fnm `PATH` only, unblock task #13 (`task_unblock`) and let the next heartbeat re-run the bootstrap — `pnpm install` should now succeed and the task should leave `blocked`.

## Risk & rollback

- **Risk:** Low. The env merge is already battle-tested by the `bash` tool; we're
  extending its use to two more spawn sites. The scrub policy is shared, not re-implemented.
- **Regression surface:** The `bash.ts` refactor is the only behaviour-adjacent change;
  it's a pure extract-and-import with identical output. Covered by the existing
  `bash.test.ts` secret-scrub test.
- **Rollback:** Revert the commit; no on-disk state or schema is touched.