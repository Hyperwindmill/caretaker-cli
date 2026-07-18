---
"@hyperwindmill/caretaker-cli": patch
---

Reject unrecognized checklist item status values at the `task_update_checklist_item`/`task_update_checklist` tool boundary and the `/api/tasks/:id/checklist-item` endpoint, instead of silently persisting whatever string the agent sent. Fixes checklist items getting stuck unchecked when an agent sends a synonym like "completed" instead of the exact enum value "done".
