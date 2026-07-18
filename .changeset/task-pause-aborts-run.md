---
"@hyperwindmill/caretaker-cli": patch
---

fix(tasks): Pause now aborts the in-flight autonomous run, not just the next tick

Pausing (or blocking) a running autonomous task previously only kept the *next*
heartbeat from claiming it — the current cycle kept running to the end of its
turn budget, so an agent gone off the rails (e.g. a model looping on empty tool
calls) appeared to ignore Pause. The heartbeat now registers an AbortController
per running task (`runningTaskControllers` in `scheduler/locks.ts`) and threads
its signal into the developer/planner run and the review pass; the
`POST /api/tasks/:id/status` pause path calls `abortRunningTask`, so the loop
stops between turns. Native runs previously got no abort signal at all (only
claude-code did); this closes that gap for both.
