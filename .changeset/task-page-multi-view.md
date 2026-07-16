---
'caretaker-cli': minor
'webview-ui': minor
---

Restructure the autonomous task page into a multi-view section with a paginated
tasks table, a dedicated task log route, and a dedicated task edit route.

- The task page is no longer an all-in-one 3-column layout. It now uses a
  lightweight view-router with three routes: **list**, **log**, and **edit**.
  The tasks table gets the full width of the pane.
- **Project filter**: the projects sidebar is replaced by a project filter
  dropdown at the top of the list view. The selected project is persisted to
  localStorage and remembered across sessions, defaulting to the first project
  on first load. The "Show archived" toggle is also persisted.
- Project management (add / delete) is removed from this view — projects are
  created and managed from the Settings panel instead.
- **List view**: a proper paginated tasks table (20 rows/page) with columns
  for ID, title, status badge, checklist progress bar, branch, last-updated
  timestamp, and an edit action. Row click opens the log view; the edit
  button opens the edit view.
- **Log view**: the execution thread (messages + composer) is now its own
  route with a back button and a status-aware header, keeping the live 3s
  polling.
- **Edit view**: the objective, checklist, and status actions (pause /
  activate / archive / delete / discard worktree) live in their own route
  with a back button and a "View Log" shortcut.
- Back buttons reuse the existing `.settings-panel__back-btn` style. New
  CSS classes (`.task-table`, `.task-table__pagination`, `.task-view__header`,
  `.task-view__project-filter`) were added to `styles.css`.