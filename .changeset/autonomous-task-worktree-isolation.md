---
'caretaker-cli': minor
'webview-ui': minor
---

Autonomous tasks now run in a dedicated git worktree on a per-task branch (caretaker/task-<id>-<slug>). Progress is committed every heartbeat cycle; on completion the worktree is removed and the branch is left for review. Non-git projects run in place as before. Adds a "Discard worktree" action (web button + mcp__task__task_discard_worktree tool).
