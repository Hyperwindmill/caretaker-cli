---
'@hyperwindmill/caretaker-cli': minor
---

Memory daemon step 3: the read path. A host-side lexical keyword match on the user message injects a `<memories>` block (top-K titles) into the prelude on every surface, and a new `mcp__memory__memory_read` builtin returns memory bodies on demand — each read increments the memory's recall accounting (`recallCount`/`lastRecalledAt`), the acquired strength signal for future consolidation and decay. Autonomous task cycles receive the project's memories via explicit host-side scope (their worktree never matches the project directory). `memory_read` is auto-included (and hidden from the tool pickers) whenever memory is configured — the same switch as the injected block, so reading is never permission-gated.
