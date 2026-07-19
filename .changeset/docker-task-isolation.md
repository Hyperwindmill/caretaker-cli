---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
---

Introduce Docker Environment Isolation for autonomous tasks. Projects can now configure a `dockerImage` (via API, config file, or settings UI) to execute all heartbeat task runs (planning, development, and review phases) inside a dedicated, isolated Docker container bind-mounting the task's git worktree. Native shell commands are executed inside the container, and Claude Code agents route commands into the container via settings hook redirection.
