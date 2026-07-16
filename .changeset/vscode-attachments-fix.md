---
'caretaker-vscode': patch
---

Fix attachments silently dropped in the VSCode sidebar: the webview sent them with the `start` message, but the extension host ignored the field, so the agent never saw attached files (reported as "PDF reading doesn't work"). The host now persists each attachment via `saveAttachment` and passes the records to the harness (`promptAttachments` + `sessionId`), matching the web server behaviour — `read_attachment` now resolves correctly in the sidebar too.
