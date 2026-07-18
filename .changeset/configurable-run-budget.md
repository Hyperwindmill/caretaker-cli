---
"@hyperwindmill/caretaker-cli": minor
"webview-ui": minor
"caretaker-types": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

feat(tasks): configurable per-cycle run budget (maxRunSeconds) at project and task level

The per-invocation wall-clock budget is now configurable instead of a hardcoded
value, and it's a real enforced abort for every provider — not just prompt text
for native runs. `maxRunSeconds` resolves task → project → provider default
(120s native, 900s claude-code) via `resolveMaxRunSeconds`, and the run (plus
the review pass) aborts when it exceeds the budget, reusing the same
AbortController that Pause fires. Set it on the project settings form or per task
in the task settings; leave empty to inherit. Native runs stay additionally
turn-bounded by `agent.maxTurns`.
