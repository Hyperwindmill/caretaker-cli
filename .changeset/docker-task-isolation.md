---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
---

Introduce Docker environment isolation for autonomous tasks. Projects can configure a `dockerImage` (via API, config file, or settings UI) so **all** of a task's heartbeat cycles — development, planning, and the DONE-review — run inside a dedicated, isolated Docker container that bind-mounts the task's git worktree (and git metadata) at identical paths and executes as the host user. Native shell commands run in the container via `docker exec`; `claude-code` agents route their shell commands into the container via a PreToolUse settings hook, with file access confined to the working dir. In-container git is best-effort — if the image ships none, add it via a bootstrap command; commits are made host-side regardless. Requires Docker on the scheduler host.
