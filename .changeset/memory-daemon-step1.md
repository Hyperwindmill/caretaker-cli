---
'@hyperwindmill/caretaker-cli': minor
---

Memory subsystem step 1: a scheduler memory-sweep loop maintaining a per-session cursor and rolling summary (`session_digests` collection), configured via the new `memory` key (`MemoryConfig` in caretaker-types). Off unless configured.
