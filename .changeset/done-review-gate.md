---
'caretaker-cli': minor
'webview-ui': minor
---

Autonomous tasks now run an independent code-review pass when they reach DONE. If the review requests changes, the task reopens (worktree kept) and the review is left in the task history for the agent to address next cycle; a PASS removes the worktree and keeps the branch. Capped at 3 review rounds.
