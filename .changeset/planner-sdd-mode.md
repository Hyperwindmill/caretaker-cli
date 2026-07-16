---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Planner SDD mode (opt-in): a new `sddEnabled` tri-state gate (task inherits from project, default off) lets the planner create and edit markdown files during the planning phase — write/edit/multiedit are wrapped with a `.md`-only path guard instead of stripped, while bash stays unavailable. Spec conventions (where/how) are left to the project's own AGENTS.md / agent prompt; the documents land on the task branch via the per-cycle WIP commit. Surfaced everywhere the other gates are: `task_create` (`sdd_enabled`), `task_get_state`, `PATCH /api/tasks/:id/flags`, task/project creation APIs, and the task/project settings UI.
