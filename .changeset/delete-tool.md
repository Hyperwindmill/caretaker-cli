---
'@hyperwindmill/caretaker-cli': minor
---

New native `delete` tool: removes a file or an empty directory inside the agent's working directory, so agents without `bash` can clean up. It is never recursive and refuses the working directory itself. Off by default like every other tool (opt it in from the tool picker). The planner role never gets it, except in SDD mode, where it may delete markdown files only.
