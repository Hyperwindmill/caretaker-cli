---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
---

Review fixes on the slug-ids work: project deletion from the settings form no longer races the new referential guard (the DELETE route is now awaited as the single delete path, instead of an optimistic saveConfig that the guard would reject with a spurious error), and `GET /api/tasks/:id/messages` gains the same charset guard as its sibling routes.
