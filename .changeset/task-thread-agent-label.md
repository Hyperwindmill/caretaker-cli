---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

feat(tasks): show the agent name and model on assistant bubbles in the task log

Assistant messages in the task execution thread said only "assistant". They now
carry the responsible agent's `name · model` — the developer agent for cycle
output, the planner agent for the submitted plan — resolved with the same
task → project → default fallback chain the runtime uses. Regular chat is
unchanged (still "assistant").
