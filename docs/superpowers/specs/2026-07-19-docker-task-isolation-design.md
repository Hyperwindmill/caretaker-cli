# Docker environment isolation for autonomous task runs

**Date:** 2026-07-19
**Status:** Design approved, pending spec review
**Scope:** v1 — `dockerImage` (reproducible-environment knob) only. The orthogonal
`sandboxEnabled` (OS-level safety knob, Claude Code native sandbox) is a separate
future feature, explicitly out of scope here.

## Goal

Let an autonomous task's agent run its shell work inside a defined Docker image
(specific node/toolchain/OS/libs) instead of directly on the scheduler host,
extending the existing per-task git-worktree isolation. The motivation is a
**reproducible execution environment**, not a security sandbox (that is the
separate `sandboxEnabled` knob).

## Key insight (what keeps this small)

LLM inference (provider HTTP calls) stays in the caretaker host process — it is
**not** containerized. Only *side effects* need the container: shell commands
(`bash` tool) and `bootstrapCommands`. With a **bind mount of the worktree at an
identical absolute path** (`-v <wt>:<wt> -w <wt>`), the file tools
(`read_file`/`write`/`edit`/`multiedit`/`glob`/`grep`) need **no** redirection —
host and container see the same files at the same paths. Only `bash` +
bootstrap run inside the container.

## Config surface

- **`ProjectConfig.dockerImage?: string | null`** — image ref (e.g. `node:22`, or
  a project-custom image). `null`/empty/absent = current behavior (in-place / host
  worktree). Mirrors the existing `bootstrapCommands` / `maxRunSeconds` project
  fields in `packages/types/src/index.ts` and `packages/cli/src/store/db.ts`.
- **Web API**: accept `dockerImage` in project create/update in
  `packages/cli/src/cli/web/server.ts` (alongside `bootstrapCommands`).
- **Webview**: a text input for the image in the project form (same panel as
  bootstrap commands).
- **Out of scope (deferred):** per-task `Task.dockerImage` override. v1 is
  project-level only; a project-level image is already a complete feature. Add the
  task override when a real need appears.

## Container lifecycle — new `packages/cli/src/lib/task_docker.ts`

A sibling module to `task_git.ts` (keeps `task_git.ts` git-only). All functions
build `docker` argv and spawn via `execFile` with `commandEnv()` (same env policy
as `task_git.ts`), honoring an `AbortSignal` where a run is involved.

- **`containerName(projectId, taskId): string`** → deterministic
  `caretaker-task-<projectId>-<taskId>`. Determinism gives idempotency across
  scheduler restarts.
- **`ensureContainer(image, mountRoot, workdir, projectId, taskId): Promise<string>`**
  - If a container with that name is already running → reuse (return the name).
  - Else if a stopped container with that name exists → remove it, then create.
  - Else create: `docker run -d --user <uid>:<gid> -v <mountRoot>:<mountRoot>
    -w <workdir> --name <name> <image> sleep infinity`.
  - `mountRoot` = the worktree path (whole worktree, so paths match); `workdir` =
    the agent working dir (worktree root, or a subdir for below-root projects, as
    `agentDirIn` already computes).
  - Network is **on** by default (needed for `pnpm install` / builds).
  - `--user <uid>:<gid>` is **mandatory**: without it the container writes files as
    root, which breaks the host-side WIP commit and the review diff.
    `// ponytail: if the image lacks a matching /etc/passwd entry, set HOME=/tmp;
    tune when a real image needs it.`
  - Returns the container name; caller persists it on `task.dockerContainer`.
- **`execInContainer(name, cmd, cwd, timeoutMs, signal): Promise<{exitCode, output}>`**
  → `docker exec -w <cwd> <name> sh -lc <cmd>`. Used by both the native bash
  redirect and the docker-aware bootstrap.
- **`removeContainer(name): Promise<void>`** → `docker rm -f <name>`, best-effort.

**Task field:** `task.dockerContainer?: string | null` (parallel to `branch` /
`worktreePath`), persisted in the store DB (`packages/cli/src/store/db.ts`).

**Creation point:** in the task heartbeat (`scheduler/task_strategy.ts`), right
after `ensureWorktree` and **before** bootstrap, only when the resolved project
`dockerImage` is set. A creation failure (docker absent, image pull fails, `run`
fails) sends the task to **`blocked`** with the docker error as `blockedReason`
plus a `block` message, and the agent does not run — identical to the existing
bootstrap-failure path.

**Non-git projects:** docker still applies; `mountRoot`/`workdir` are the live
`project.workingDir`. Same risk profile as today's in-place non-git runs.

## Enforcement — native (OpenAI-compatible) provider

- `ToolContext` (`packages/cli/src/harness/tools/types.ts`) gains an optional
  **`dockerContainer?: string`**.
- The `bash` tool (`packages/cli/src/harness/tools/builtin/bash.ts`, Linux branch
  ~L56-67): if `ctx.dockerContainer` is set, spawn
  `docker exec -w <ctx.workingDir> <name> sh -lc <cmd>` instead of `bash -c`.
  One branch. Windows/macOS paths are unaffected (docker-in-autonomous-tasks is a
  Linux-host scheduler feature; if `dockerContainer` is set the docker-exec branch
  is taken regardless of platform, but in practice this only fires under the web
  scheduler).
- File tools: **unchanged** (bind mount → same paths).
- `runBootstrap` (`task_git.ts`) gains an optional container param; when set it
  routes each command through `execInContainer` instead of host `execShell`.
- The heartbeat threads `task.dockerContainer` into the native run's
  `ToolContext`.

## Enforcement — claude-code provider

claude-code owns its own tools, so we cannot redirect a single tool from our code.
Instead we install a **mechanical** `PreToolUse` hook (not a soft prompt
instruction) via a temp settings file:

- `claude_code_runner.ts` writes a temp settings JSON and passes it with
  **`--settings <file>`** (new plumbing — today the runner passes `--mcp-config`,
  `--append-system-prompt`, `--permission-mode`, but not `--settings`). The temp
  file is cleaned up after the run, same as the existing `--mcp-config` temp file.
- The settings contain a `PreToolUse` hook with `matcher: "Bash"` whose `command`
  is a small node script that:
  1. reads the hook input JSON from stdin,
  2. takes the Bash command from it,
  3. emits `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
     "updatedInput":{"command":"docker exec -w <wd> <name> sh -lc
     \"$(echo <b64>|base64 -d)\""}}}`, where `<b64>` is the original command
     base64-encoded (dodges nested-quote hell) and `<name>`/`<wd>` are interpolated
     at settings-write time.
- ⚠️ **Verify against a real artifact during implementation** (per the project's
  "verify formats from real artifacts" rule): the exact stdin field name carrying
  the Bash command (expected `tool_input.command`) must be confirmed against a real
  Claude Code hook invocation, not assumed from memory. The `updatedInput` output
  field is confirmed from the docs.
- claude runs on the host with cwd = agent working dir; its `Read`/`Edit`/`Write`
  hit the host worktree (fine, mounted at the same path); its `Bash` is rewritten
  into `docker exec`.
- The hook is injected **only** when a docker container is active for the run
  (i.e. `dockerImage` resolved and container created). Ordinary chat / cron /
  Telegram claude-code runs get no such hook.
- Note: this is unrelated to Claude Code's native sandbox (docker is incompatible
  with that sandbox). The two are separate knobs and are never combined.

## Lifecycle edge cases

- **Pause / abort:** container stays up (`sleep infinity`, negligible cost),
  reused on the next cycle. Removed only at DONE / discard.
- **Scheduler restart mid-task:** `ensureContainer` finds the container by its
  deterministic name and reuses it, or recreates it if gone.
- **DONE / discard:** `removeContainer(task.dockerContainer)` is orchestrated in
  the heartbeat (`task_strategy.ts` finalize path and `task_review.ts` finalize),
  **before** `finalizeDone` — it is *not* placed inside `finalizeDone`, which stays
  git-only. The manual `task_discard_worktree` path also removes the container.

## Error handling

Docker unavailable / `docker run` failure / image pull failure → task to
`blocked` with a descriptive `blockedReason` and a `block` message, agent skipped.
`execInContainer` failures during bootstrap follow the existing bootstrap-failure →
`blocked` path.

## Testing (co-located `*.test.ts`, node test runner via `tsx`)

- **native bash redirect:** `bash` tool with `ctx.dockerContainer` set produces a
  `docker exec …` spawn (mock spawn, assert argv); without it, the current
  `bash -c` path is unchanged.
- **claude-code hook generation:** given a container name + workdir, the emitted
  hook settings JSON is well-formed; feeding a sample hook-input JSON through the
  wrapper script yields `updatedInput.command` wrapping the original in
  `docker exec` with correct base64 round-trip.
- **container lifecycle argv:** assert the argv built by `ensureContainer` /
  `removeContainer` (mock `execFile`), including `--user`, identical-path `-v`, and
  the deterministic `--name`.

## Docs + release

- `CLAUDE.md`: layer 5 (git worktree isolation bullet — add the container step) and
  "State on disk" (`ProjectConfig.dockerImage`, `task.dockerContainer`).
- `README.md`: the new project setting (user-facing).
- Changeset: **minor**.

## Execution note

The implementation plan is written for a fast external executor (Gemini): tasks
must be atomic, self-contained, assume minimal prior context, and each be
independently verifiable. Final whole-branch review happens here.
