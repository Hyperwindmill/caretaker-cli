---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
---

Introduce Docker environment isolation for autonomous tasks. Projects can configure a `dockerImage` (via API, config file, or settings UI) so a task's **development and planning cycles** run inside a dedicated, isolated Docker container that bind-mounts the task's git worktree (and git metadata) at identical paths and executes as the host user. Native shell commands run in the container via `docker exec`; `claude-code` agents route their shell commands into the container via a PreToolUse settings hook, with file access confined to the working dir. The DONE-review pass runs on the host (it is git-diff-driven, and git is always available there). In-container git is best-effort — the agent is warned when the image ships none, and commits are made host-side regardless. Requires Docker on the scheduler host.
