---
"caretaker-cli": patch
"caretaker-types": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

Fix misleading planner/reviewer fallback labels: at task level an unset role falls back to the project-level role first (then the developer chain), so the empty option now reads "Project default" instead of "Same as developer"; tooltips spell out the actual chain. Project-level selects read "Same as assigned agent" (accurate there — a project role has no higher default).
