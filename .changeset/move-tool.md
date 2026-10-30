---
'@hyperwindmill/caretaker-cli': minor
---

New native `move` tool: moves or renames a file or directory inside the agent's working directory, creating the destination's parent directories. It never overwrites: an existing destination is refused. Off by default like every other tool. The planner role never gets it, except in SDD mode, where both the source and the destination must be markdown files.
