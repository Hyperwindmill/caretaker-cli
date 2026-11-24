---
"@hyperwindmill/caretaker-cli": minor
---

`GET /api/tasks/:id/messages` accepts `after` (a message id) and `limit` (1–500), so a long task thread can be read in pages — through the API port or a remote orchestrator, whose 1 MB result cap would otherwise reject a long thread for good. Without the parameters the route answers the whole thread as before.
