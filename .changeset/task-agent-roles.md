---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
---

Implement Planning Phase, Multi-agent Roles, and Review Gate controls. This adds:
- Extended schema configuration on ProjectConfig, Task, and Project to store overrides for developer, planner, and reviewer agents.
- Planning phase logic (when a task is active but has the status `'planning'`), during which standard mutating tools are stripped, and a sandboxed Planner Agent must submit a plan using `mcp__task__task_submit_plan` before development begins.
- Review gate logic (when a task is in `'reviewing'` status), enabling code review of completed worktrees or direct finalization when the review gate is disabled.
- Frontend views and control selects in ProjectsTab and ProjectsTabSettings to configure these role assignments and flags dynamically.
