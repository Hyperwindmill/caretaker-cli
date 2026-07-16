---
"caretaker-cli": patch
---

Autonomous task WIP commits now use `--no-verify` and supply a fallback git identity only when the target repo has none configured. Previously a repo with a failing pre-commit hook (husky/lint-staged) or no configured `user.name`/`user.email` would make every WIP commit throw — silently stalling progress each heartbeat and, worse, leaving the worktree undeletable at DONE (and via the manual discard button), since worktree removal runs only after a successful commit.
