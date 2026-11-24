---
"@hyperwindmill/caretaker-cli": minor
---

Long task lists can be read in pages. `GET /api/tasks/:id/messages` accepts `after` (a message id) and `limit` (1–500), and `GET /api/projects/:id/tasks` accepts `after` (a task's `seq`) and `limit`, so a long thread or a large project can be read through the API port or a remote orchestrator, whose 1 MB result cap would otherwise reject them for good. Without the parameters both routes answer as before. A task message longer than 100 000 characters is now stored truncated, with a visible marker, so a single message can never block a paged read.
