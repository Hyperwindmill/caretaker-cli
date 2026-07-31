# Project Remote Repository — Design

Date: 2026-07-31
Status: approved

## Problem

To host the caretaker web server remotely, a project must be able to *be* a repository:
the server clones it itself, keeps it fresh, and pushes task work back to the remote so
it is reachable from anywhere. Today `ProjectConfig.workingDir` must point at a
pre-existing local checkout, and nothing in the codebase ever pushes.

## Decisions (approved)

1. **Reuse `workingDir` as the clone destination** — no separate `cloneDir` field. When
   `repositoryUrl` is set and `workingDir` is blank, a runtime accessor resolves the
   default `~/.caretaker/repos/<projectId>` (resolved at call time via `dataDir()`, never
   persisted, so it follows `CARETAKER_HOME` like every other path).
2. **Push at all three moments**: best-effort after every per-cycle WIP commit; gating
   before finalize; gating before manual discard.
3. **Push failure at finalize blocks the task** (state `blocked`, worktree kept, retried) —
   not best-effort. Rationale: on a remote host an expired token must be loud; the
   worktree is only removed once the branch is safely on the remote.
4. **git CLI everywhere** (extend `task_git.ts`), not isomorphic-git. One backend on one
   repo; worktrees need the CLI anyway; token via env + inline credential helper.
5. **UI has a "Clone / Sync now" button; cloning state is derived, never persisted.**

## Data model

Two optional fields on `ProjectConfig` (`packages/types/src/index.ts`):

- `repositoryUrl?: string` — HTTPS remote of the project repository.
- `repositoryToken?: string` — access token, AES-256-GCM encrypted at rest.

Encryption follows the existing choke-point pattern: `saveConfig()` in
`packages/cli/src/store/json.ts` encrypts `projects[].repositoryToken` in place, guarded
by `isEncrypted()` so a client round-tripping the ciphertext never double-encrypts
(the guard `patchSource` is missing). `POST /api/projects` encrypts too. Decrypt happens
only at use time inside `task_git.ts`; the plaintext is never sent to the client.

`projectWorkingDir(project)` accessor: `workingDir` if set; else, when `repositoryUrl` is
set, `join(dataDir(), 'repos', project.id)`; else the current behaviour (workingDir
required).

## Sync (clone / pull)

New `syncProjectRepo(project)` in `packages/cli/src/lib/task_git.ts`:

- Destination missing or empty → `git clone <url> <dest>`.
- Destination is a valid repo → `git fetch` + `git pull --ff-only` on the clone's default
  branch. Task worktrees are untouched — they are born from the clone's `HEAD` right
  after the sync.
- Destination exists but is not a valid repo (crashed clone, junk) → treated as broken:
  wiped and re-cloned.

**Atomic clone**: clone into a temp sibling (`<dest>.cloning-<pid>`) then rename into
place — the repo's atomic-write convention applied to directories. A crash leaves only
temp junk (cleaned on the next sync), never a half-cloned `workingDir`.

**Call sites**: the task heartbeat (`scheduler/task_strategy.ts`) calls it right before
`ensureWorktree`, only when `repositoryUrl` is set. A sync failure (bad URL, expired
token, network) sends the task to `blocked` with the command output as `blockedReason` —
the same pattern as a bootstrap failure. Sync runs host-side, outside the Docker
container, like all of `task_git.ts`; no new mounts.

**Concurrency**: an in-memory per-project in-flight `Set<projectId>` (same pattern as
`runningTasks` in `scheduler/locks.ts` and `backendStarting` in voice_backend). A second
concurrent sync for the same project → 409 from the endpoint; a heartbeat that finds a
sync in flight skips that task's tick (retries in 15 s), never blocks.

## Auth

HTTPS + token only (no SSH — no precedent in the repo, and a PAT is the remote-host use
case). Convention: username `x-access-token`, password = token (same as plugin fetchers).

The token travels in a child-process env var read by an inline credential helper:

```
git -c credential.helper='!f(){ echo username=x-access-token; echo password=$CARETAKER_GIT_TOKEN; }; f' ...
```

Never on argv (visible in `ps`), never embedded in the remote URL persisted in
`.git/config` (the stored remote stays clean). Without a token, git uses ambient auth
(public repo or the system credential helper).

## Push

New `pushBranch(repoRoot, branch, auth)` in `task_git.ts`. Every push call site is gated
on `project.repositoryUrl` being set — projects with a plain local `workingDir` keep
today's behaviour exactly, even if the user configured a remote by hand. Three call
points, two semantics:

- **Per-cycle** (after `commitWip` in the heartbeat): best-effort — failure is logged,
  the cycle continues. The remote shows task progress in near-real-time.
- **Finalize** (the three `finalizeDone` call sites in `task_strategy.ts`): push
  **before** removing the worktree; on failure the task goes `blocked` with the reason,
  the worktree stays, and the next tick retries. The worktree is removed only after a
  successful push.
- **Manual discard** (`POST /api/tasks/:id/discard-worktree` + `task_discard_worktree`
  tool): push after the WIP commit; on failure the request returns an error and the
  worktree stays — discard never destroys unpushed work.

Note: even on a lost push the branch survives in the local clone under `~/.caretaker`,
so work is never truly lost; blocking finalize is about visibility and the remote-host
contract, not data loss.

## Web API

- `POST /api/projects/:id/sync` — runs `syncProjectRepo`, streams ndjson progress
  (`application/x-ndjson`, flushed as produced; terminal line carries the final status) —
  the exact `POST /api/voice/backend/start` pattern. 409 while a sync for that project is
  in flight.
- `GET /api/projects/:id/repo-status` — derived state, read from disk at request time:
  `absent` | `cloned` (+ current branch/commit) | `broken` | `syncing` (from the
  in-flight set). Nothing persisted.

## UI (`packages/webview-ui/src/ProjectsTabSettings.tsx`)

- `repositoryUrl` text field — validation: must start with `https://` (no `git@`; SSH is
  unsupported).
- `repositoryToken` password-type input, masked, modeled on `PluginsTab`'s authToken.
- `workingDir` shows the resolved default as placeholder when a URL is set.
- "Clone / Sync now" button, visible when `repositoryUrl` is set, driving the sync
  endpoint with streamed progress; status badge fed by `repo-status`. The button's real
  value is immediate URL/token validation at configuration time; the lazy heartbeat sync
  remains the guarantee for fully-autonomous remote flows.

## Testing

- `task_git.test.ts` (co-located, node test runner via tsx): a local bare repo as
  `origin` exercises real clone/pull/push without network or tokens — clone-if-absent,
  ff-pull, broken-dir re-clone, atomic temp+rename, push per-cycle/finalize/discard
  paths, failure→blocked semantics.
- Unit tests for the credential-helper construction (env var name, no token on argv).

## Docs & release

`CLAUDE.md` (layer 5 + State on disk) and `README.md` updated in the same unit of work.
Changeset: `minor`.

## Out of scope (YAGNI)

Periodic background pull, SSH auth, multiple remotes, mid-task pull, auto-PR creation on
the remote.
