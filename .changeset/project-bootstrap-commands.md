---
"@hyperwindmill/caretaker-cli": minor
"webview-ui": minor
"caretaker-types": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

feat(tasks): project-level bootstrap commands run once on worktree setup

Projects gain an optional `bootstrapCommands` list. When a task worktree is
first created (git projects only), the commands run once in order — before the
agent's first cycle — so the agent doesn't spend tokens on setup like
`pnpm install`. The run stops at the first command that fails and blocks the
task with the failed command and its output as the reason. Configured via a new
"Bootstrap Commands" field in the project settings form.
