---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

feat(tasks): show the reviewer agent identity on review output in the task log

Review output was rendered as a plain user bubble, so it wasn't clear which
agent ran the review. The `review` message now stores the reviewer's
`name · model` (captured at run time, like the per-cycle developer/planner
label) and renders as a labeled "🔎 Code review" bubble, confirming the review
was done by the expected agent.
