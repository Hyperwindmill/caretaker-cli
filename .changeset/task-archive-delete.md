---
"caretaker-cli": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
"caretaker-types": minor
---

Add task archive and delete: archived tasks are hidden by default with a "Show archived" toggle and are excluded from the scheduler heartbeat; delete permanently removes a task and its messages from the store. Both are available as MCP tools (task_archive, task_unarchive, task_delete), REST endpoints, and confirm-gated UI actions. A locked/running task cannot be deleted (409) to avoid zombie resurrection by the heartbeat.
