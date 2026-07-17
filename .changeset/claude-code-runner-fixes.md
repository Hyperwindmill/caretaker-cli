---
"caretaker-cli": patch
---

Final-review fixes for the Claude Code runner: the task bridge URL now honors `--host` instead of hardcoding `127.0.0.1`; claude-code task heartbeat and review cycles are now bounded by a 15-minute wall-clock timeout (the Claude Code CLI has no `--max-turns`); a stale/GC'd `--resume` session id is retried once without `--resume` instead of wedging the session forever; and Windows spawn-error messages now hint at pointing the provider `command` at `claude.exe` instead of an npm `.cmd` shim.
