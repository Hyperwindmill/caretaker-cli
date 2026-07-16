---
"caretaker-cli": patch
"caretaker-types": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

Task worktree auto-commits now use `chore(auto): <title>` instead of `wip: <title>` — `wip` is not a conventional-commits type, so commitlint-style hooks and wip-detecting tools warned on the machine-made commits.
