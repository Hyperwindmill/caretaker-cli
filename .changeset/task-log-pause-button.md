---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
"caretaker-types": patch
---

fix(tasks): restore the Pause/Activate button in the task log view and make it available during planning and reviewing

The refactor dropped the pause control from the task log header, so an autonomous
task viewed in its log could no longer be paused. The button is back in the log
header and, together with the task detail view, now treats `planning` and
`reviewing` as pausable (not just `active`) — pausing an off-track agent aborts
the current cycle (the heartbeat skips post-processing on a paused task) and
prevents the next one, whatever phase the task is in.
