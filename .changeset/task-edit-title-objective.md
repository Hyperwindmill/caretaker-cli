---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'caretaker-types': minor
---

Make a task's title and objective editable after creation. The task edit view now shows a title input and an objective textarea with Save/Cancel instead of read-only text, backed by a new `PATCH /api/tasks/:id` route and a new `mcp__task__task_update_details` tool (both accept either field on its own; a blank title is rejected, an empty objective is allowed). Edits are not blocked while a task is running — the objective is re-read at the start of each cycle.