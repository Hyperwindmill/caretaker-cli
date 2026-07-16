---
"caretaker-cli": minor
"webview-ui": minor
---

Autonomous git tasks now enter a `reviewing` state between `active` and `done`.
`task_complete` sends a git-isolated task to `reviewing`; the DONE review runs
as its own heartbeat cycle (no longer inline), transitioning to `active` on
changes-requested or `done` on pass/max-rounds. The UI shows reviewing tasks as
active (purple, with a Pause control and an "In review" label) instead of
misleadingly inactive. Non-git tasks finalize directly to `done` as before.
