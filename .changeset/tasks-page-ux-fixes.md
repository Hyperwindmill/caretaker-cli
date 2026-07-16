---
"caretaker-cli": patch
"webview-ui": patch
---

Fix tasks page UX: restore one-click archive, fix "not found" after archiving, and bring the checklist back into the task log view.

- Fix archive navigation: after archiving/unarchiving from the edit view, navigate back to the list (previously left the user on a "Task not found" screen when "Show archived" was off).
- Add an inline Archive button on each task row in the list view (with a confirm dialog), restoring the one-click archive flow.
- Restore the checklist sidebar on the left side of the task log view, with live progress count and toggleable items.