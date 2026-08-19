---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Project ids are now user-chosen slugs and task ids are `<projectSlug>-<seq>` composites; ids are never reused after deletion. Existing numeric ids migrate automatically and byte-compatibly on first use (worktrees, containers, and managed clones keep their names). `ProjectConfig.id` and `Task.id`/`Task.projectId` are now strings; `Task.seq` and `ProjectConfig.nextTaskSeq` are new fields.
