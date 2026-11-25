---
"@hyperwindmill/caretaker-cli": minor
---

Remote orchestration polls again at once while results are waiting to be delivered, and right after a message is approved or rejected, so a chain of dependent commands runs at the speed of the calls instead of one poll interval per step. The poll interval is now the longest wait between polls; the wire protocol is unchanged.
 The demo orchestrator gains an optional `onResult` hook.
