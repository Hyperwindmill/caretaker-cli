---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
---

Autonomous task cycles are recorded as sessions and viewed live with the chat renderer; agents receive handoff notes instead of full transcripts.

- Every developer, planner and review cycle is a chat session under its agent, hidden from the chat lists and deleted with its task. The task thread shows one card per cycle; clicking a card opens it full pane, live while it runs.
- Agents get handoffs, not transcripts: history replay and `task_get_state` carry only chat notes, reviews and plans. A cycle that ends without a note gets a host-written fallback.
- The memory sweep reads task cycles through their closing recap only.
- Legacy task threads are shown as they were stored.
