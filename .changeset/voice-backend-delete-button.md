---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'caretaker-types': minor
---

Add a Delete button for the managed Speaches voice backend: `POST /api/voice/backend/delete` removes the container (`docker rm -f`) while keeping the model-cache volume and image, so a container with stale creation-time state (e.g. frozen DNS after switching networks) can be recreated with Start. Idempotent when the container is already gone; refused with 409 while a start is in flight. The Voice settings tab gains a two-step-confirm Delete button.
