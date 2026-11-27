---
"@hyperwindmill/caretaker-cli": patch
---

A project whose working directory is reached through a symlink (on macOS, anything under `/tmp` or `/var`) now maps onto the task worktree instead of a non-existent `../../…` path. This also makes the `task_git` and `task_delete` tests pass on macOS.
