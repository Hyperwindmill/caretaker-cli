# Autonomous task worktree isolation — design

Date: 2026-07-16

## Problem

Autonomous tasks run via the task heartbeat (`packages/cli/src/cli/web/scheduler/task_strategy.ts`).
Today the heartbeat resolves `project.workingDir` and runs the agent **directly in that
directory**. Consequences:

- All tasks in the same project share one working tree. Uncommitted work from one task can be
  clobbered by another.
- `task_complete` only sets `status='done'`; there is no git integration, so the output of an
  autonomous run is left as dirty uncommitted changes in the user's working tree with no record.

## Goal

Each autonomous task works in its own git worktree on a dedicated branch, created and managed by
the harness. Progress is committed every heartbeat cycle so it is durable. On completion the
worktree is removed and the branch is left in the repo for the user to review/merge manually.

Non-goals (explicitly deferred): auto-merge into any branch, MR/PR creation, an explicit
"merge to main" UI button. These are future features layered on top of the branch this design
leaves behind.

## Decisions (from brainstorming)

- **DONE semantics**: commit the remainder onto the branch, remove the worktree, **leave the
  branch** (no autonomous merge into main).
- **Commit cadence**: WIP commit at the end of **every** heartbeat cycle if the tree is dirty.
  No squash at DONE — history stays granular and mirrors the task messages.
- **Non-git projects**: fallback to running in-place in `workingDir` (current behavior). Worktree
  isolation applies only when `project.workingDir` is inside a git repo.
- **Worktree location**: `~/.caretaker/worktrees/<projectId>-<taskId>` (outside the repo).
- **Branch name**: `caretaker/task-<id>-<slug(title)>`.

## Schema changes

`Task` (in `packages/cli/src/store/db.ts`) gains two nullable fields:

```ts
branch: string | null;        // dedicated branch name, once created
worktreePath: string | null;  // absolute worktree path while alive; null after DONE/removal
```

Existing tasks lack these fields; reads must treat missing as `null`.

## Git lifecycle module

New module `packages/cli/src/cli/web/scheduler/task_git.ts`, all via `execFile('git', …)`:

- `isGitRepo(dir): Promise<boolean>` — `git -C <dir> rev-parse --is-inside-work-tree`.
- `ensureWorktree(task, project): Promise<{ branch, worktreePath, agentWorkingDir }>`
  - `repoRoot = git -C <workingDir> rev-parse --show-toplevel`
  - branch = `caretaker/task-<id>-<slug>`
  - `git -C <repoRoot> worktree add -b <branch> <wtPath> HEAD`
  - `agentWorkingDir = join(wtPath, relative(repoRoot, project.workingDir))` — preserves a subdir
    working dir when the project points below the repo root.
- `commitWip(worktreePath, title): Promise<boolean>` — if dirty (`git status --porcelain`),
  `git add -A` then `git commit -m "wip: <title> (cycle N)"` where
  `N = (git rev-list --count <firstCommit>..HEAD on branch) + 1`. Returns whether it committed.
- `finalizeDone(worktreePath): Promise<void>` — `git worktree remove --force <wtPath>`.

The lifecycle lives **entirely in the heartbeat**, never in the `task_complete` tool (which stays
dumb: it only sets status). Rationale: removing the worktree from inside the turn currently running
in it is unsafe; the heartbeat does it after `harness.run` returns.

## Heartbeat flow changes (`task_strategy.ts`)

Before `harness.run`:

1. If `task.worktreePath` set → reuse it as the agent working dir.
2. Else if `isGitRepo(project.workingDir)` →
   `ensureWorktree(...)`, persist `branch` + `worktreePath` on the task, use `agentWorkingDir`.
3. Else → fallback: use `project.workingDir` as today (no worktree, no branch).

After `harness.run` (only when the task has a worktree):

- Reload the task.
- If `status === 'done'`: `commitWip(...)` (final), then `finalizeDone(...)`, set
  `worktreePath = null` (keep `branch`), save.
- Else: `commitWip(...)` if dirty, save.

The prompt's workspace line already instructs the agent to operate exclusively inside its working
dir; since the working dir is now the worktree, the sandbox enforces isolation.

## Known limitations (declared, out of scope)

- `task_complete` invoked **interactively** (outside a heartbeat) sets the task to done but does not
  clean the worktree immediately. Upgrade path: a start-of-tick sweep of `done` tasks with
  `worktreePath != null`.
- Deleting a task with a live worktree orphans it. Upgrade path: cascade cleanup in task deletion
  (same family as the recent chat-deletion work).

## Testing

`packages/cli/src/cli/web/scheduler/task_git.test.ts`: create a git repo in a temp dir, then assert
the sequence `ensureWorktree` → write a file → `commitWip` (returns true, commit exists on branch)
→ `finalizeDone` (worktree gone, branch still present in the repo).
