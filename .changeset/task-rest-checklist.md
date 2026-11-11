---
'@hyperwindmill/caretaker-cli': minor
---

Task REST routes for external clients: `POST /api/projects/:id/tasks` now returns the created task (its id and the checklist item ids) and accepts a `status` on each checklist item, and the new `PUT /api/tasks/:id/checklist` replaces a task's whole checklist, like the `task_update_checklist` tool.
