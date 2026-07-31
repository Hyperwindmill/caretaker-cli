---
'@hyperwindmill/caretaker-cli': minor
'caretaker-types': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
---

Projects can be backed by a remote HTTPS git repository: caretaker clones the repo itself (into the project directory, or a managed folder under `~/.caretaker/repos/` by default), pulls right before each task's worktree is created, and pushes task branches to the remote — after every work cycle (best-effort) and, as a hard gate, before worktrees are removed at task completion or manual discard. Access tokens are stored encrypted and passed to git via an inline credential helper (never on the command line or in `.git/config`); repository URLs carrying embedded credentials are rejected, since those would end up in both. The Projects settings UI gains Repository URL/token fields plus a Clone/Sync button with streamed progress and a derived repo-status badge (`POST /api/projects/:id/sync`, `GET /api/projects/:id/repo-status`).
