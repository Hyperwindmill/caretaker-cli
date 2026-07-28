# Web Server Dockerfile — Design

**Status:** proposed
**Date:** 2026-07-28
**Task:** #3 "Dockerfile for web"

## Goal

Ship a suitable, efficient, standards-compliant container image that serves
`caretaker-cli web`, on Node 24, with clear documentation of how to expose the
host Docker daemon (so caretaker's own autonomous-task isolation still works
from inside a container) and which volumes to mount.

## Scope

- **New** `Dockerfile.web` at the repo root — a multi-stage image whose entry
  point is `caretaker-cli web`.
- **New** `docker-compose.web.yml` at the repo root — the runnable, heavily
  commented reference invocation (mirrors the existing `docker-compose.voice.yml`
  convention).
- README section documenting the run model.
- A changeset (the five packages are one fixed group).

Out of scope: any source/code change (this is a container-packaging task). The
web command already accepts `--host`/`--port`; no new env-var plumbing is added.

## Why a NEW file and not the existing `./Dockerfile`

The repo already has a root `Dockerfile`, but it is the **per-project
task-isolation image** (`FROM node:24-bookworm`, provides the toolchain a
project's autonomous tasks run inside; COPYs nothing — the worktree is
bind-mounted at run time). It is referenced by a project's "Docker image"
setting (`./Dockerfile`) and built into `caretaker-project-<id>:latest` by the
scheduler (`lib/docker.ts` `buildImage`, `scheduler/task_strategy.ts`).

That image and the web-server image are unrelated deliverables with opposite
shapes (one is a bind-mount target that runs `sleep infinity`; the other is a
long-running Node service that COPYs and runs the built CLI). Overwriting the
task-isolation image would break task Docker isolation. Hence a separate
`Dockerfile.web`. The existing root `.dockerignore` (excludes
`node_modules`/`dist`/`.git`) is shared and is correct for both: the web build
reinstalls deps and rebuilds `dist` inside the image.

## The identical-path constraint (the crux)

caretaker isolates each autonomous task in a **sibling** container that it
launches by calling the **host** Docker daemon. `lib/docker.ts`
`containerRunArgs` bind-mounts with `-v <root>:<root>` — an *identical* absolute
path on host and in the task container — plus the git common dir the same way
(`extraMounts`), so host and container agree on absolute paths (required for the
host-side WIP commit / review diff and in-container git to line up).

When caretaker itself runs in a container and drives the host daemon over a
mounted `/var/run/docker.sock` (Docker-out-of-Docker / "DooD"), the paths in
`docker run -v A:A` are resolved by the **host** daemon against the **host**
filesystem — not caretaker's container filesystem. The two mount roots caretaker
passes are:

- the worktree: `$CARETAKER_HOME/worktrees/<projectId>-<taskId>`
  (`lib/task_git.ts` `worktreePathFor` → `dataDir()`), and
- the git common dir: under the project's real repo (the "workspaces folder").

Therefore, for task-in-Docker isolation to work from a containerized caretaker,
**both** the caretaker home **and** the workspaces folder must be bind-mounted
at an **identical absolute path on host and in the caretaker container**
(bind *source == target*). If they were mounted at different paths, the sibling
task container would bind-mount a host path that does not contain the worktree,
and the agent would run against an empty directory.

This is non-negotiable and is the reason the two volume mounts are
"standardized" (fixed, source==target) rather than free-form.

## Standardized mounts

| Purpose | Mount (source == target) | Notes |
|---|---|---|
| Caretaker home | `-v /srv/caretaker:/srv/caretaker` + `CARETAKER_HOME=/srv/caretaker` | All state: config JSON, sessions (JSONL), scheduler logs, plugins, MCP, encrypted secrets, **and task worktrees**. Must be source==target (worktrees are mounted into sibling task containers). |
| Workspaces | `-v /srv/workspaces:/srv/workspaces` | Where project repos live; every project's `workingDir` must be under this path. Must be source==target (the git common dir is mounted into sibling task containers). |
| Host Docker daemon | `-v /var/run/docker.sock:/var/run/docker.sock` | DooD. Lets caretaker build/pull images and run/stop/exec sibling task containers on the host daemon. Optional — omit it and autonomous **task Docker isolation** is simply unavailable; ordinary chat, scheduler, and in-place (non-Docker) task runs still work. |

`/srv/caretaker` and `/srv/workspaces` are the documented defaults; the only
hard rule is source==target for both.

## Base image & stages (efficiency / "best standards")

Multi-stage:

1. **builder** — `FROM node:24-bookworm`. `corepack enable` (honours the
   `packageManager: pnpm@11.15.0` field). Copy manifests first for layer-cached
   installs, then `pnpm install --frozen-lockfile --filter
   @hyperwindmill/caretaker-cli...` (the `...` pulls in the two workspace deps
   `webview-ui` and `caretaker-types`, and **excludes** `vscode-extension` /
   `desktop` — so Electron and the optional `keytar` native build are never
   fetched). Build with `pnpm --filter @hyperwindmill/caretaker-cli... build`
   (topological: types → webview-ui → cli; the cli build's `copy-webview.mjs`
   folds the UI bundle into `dist/webview`). Then
   `pnpm --filter @hyperwindmill/caretaker-cli deploy --prod /app` produces a
   self-contained `/app` (the package `files`: `dist` + `assets/logo.ans`, plus
   a real, non-symlinked `node_modules` of prod deps only). `--prod` deploy is
   clean here precisely because the cli's *runtime* deps contain **no** workspace
   packages (webview-ui/types are devDependencies, already compiled into
   `dist`), sidestepping pnpm's workspace-injection deploy pitfall.
   No build-essential/python3 needed — esbuild ships a prebuilt binary and no
   selected package compiles native code.

2. **runtime** — `FROM node:24-bookworm-slim`. Install only what the web server
   shells out to at run time: `git` (host-side worktree management —
   `lib/task_git.ts` calls the `git` binary), the Docker **client** (`docker`
   CLI, to talk to the mounted host socket), and `ca-certificates`. `bash` is
   present in `-slim` and is required by the interactive-shell PATH probe
   (`harness/tools/builtin/shell-env.ts` runs `bash -i`). caretaker does **not**
   use keytar/libsecret for its own secrets (file-based key, mode 0600 —
   `lib/encryption.ts`), so no libsecret is needed. Copy `/app` from builder.

   Docker client only (not the engine): install `docker-ce-cli` from Docker's
   apt repo. The daemon is the host's, reached over the socket.

## Networking & security

- Inside a container, the CLI default `--host 127.0.0.1` is unreachable from
  outside; the image's CMD binds `--host 0.0.0.0 --port 3000` and `EXPOSE 3000`.
- caretaker has **no built-in auth**. Binding `0.0.0.0` *inside* the container
  is fine, but the host **publish** must stay loopback (`-p 127.0.0.1:3000:3000`)
  or sit behind an authenticating reverse proxy. The compose file and README say
  this explicitly (same posture as `docker-compose.voice.yml`).
- `HEALTHCHECK` uses Node's global `fetch` against `http://127.0.0.1:3000/`
  (no curl in `-slim`).

## User / socket permissions

The `node` base user is uid/gid 1000. Two host-specific alignments matter:

- **Docker socket access:** the container user must be in a group whose gid
  equals the host's `docker` group gid. Done at run time with
  `--group-add <host-docker-gid>` (compose: `group_add`), not baked into the
  image (the gid varies per host).
- **File ownership:** caretaker's own uid/gid is what `ensureContainer` passes
  as `--user` to sibling task containers (`process.getuid()/getgid()`), and it
  owns the worktree files it writes under the mounts. Align the caretaker
  container's `user:` to the host owner of `/srv/workspaces` so worktree files
  and task-written files stay host-consistent. The compose file parameterizes
  this via `${CARETAKER_UID}` / `${CARETAKER_GID}` / `${DOCKER_GID}`.

Running the caretaker container as root is the quick path (simplest socket
access) but leaves worktree/task files root-owned on the host; documented as the
fallback, not the default.

## Alternatives considered

- **Single fat stage** (build + run in one image, `node dist/index.js web`):
  simpler, but ships dev deps + full source and a symlinked pnpm store; larger
  and less clean. Rejected for the efficiency requirement.
- **True Docker-in-Docker** (a nested daemon, `--privileged`): would isolate
  the daemon but then the worktree would have to live inside the nested daemon's
  storage, defeating the host-visible workspaces model and the identical-path
  mount. DooD (socket mount) is the correct fit and the industry default for
  "a container that orchestrates sibling containers".
- **Copying the whole builder tree** instead of `pnpm deploy`: works but fat.
  Kept as the documented fallback if `pnpm deploy` misbehaves in the executor's
  environment (acceptance is "the image serves the UI on :3000").

## Acceptance criteria

1. `docker build -f Dockerfile.web -t caretaker-web .` succeeds.
2. `docker compose -f docker-compose.web.yml up -d` starts; `GET
   http://127.0.0.1:3000/` returns the web UI HTML; the healthcheck goes
   healthy.
3. With the socket mounted and the two identical-path volumes in place, an
   autonomous task on a git project isolates into a sibling
   `caretaker-task-*` container whose worktree bind-mount resolves (agent runs
   against the real worktree, not an empty dir).
4. `CLAUDE.md`/`README.md` updated; changeset present.
