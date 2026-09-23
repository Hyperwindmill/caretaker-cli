---
"@hyperwindmill/caretaker-cli": patch
---

ACP runner: a signal already aborted before `session/prompt` (a Pause or wall-clock budget landing during session setup) now returns immediately as aborted — previously the abort listener never fired for a pre-aborted signal, the cancel was never sent, and a wedged agent could hang the turn forever.
