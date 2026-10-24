---
'@hyperwindmill/caretaker-cli': patch
---

Autonomous tasks: clearer end-of-cycle instructions so agents call `task_complete` instead of `task_yield` when the work is done. The developer prompt now ends with an explicit three-way choice (complete / block / yield), the `task_yield` and `task_complete` descriptions say when each applies, and `task_yield` on a task whose checklist is all done returns a reminder to complete it.
