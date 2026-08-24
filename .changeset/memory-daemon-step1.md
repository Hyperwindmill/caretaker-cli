---
'@hyperwindmill/caretaker-cli': minor
---

Memory subsystem step 1: a scheduler memory-sweep loop maintaining a per-session cursor and rolling summary (`session_digests` collection), configured via the new `memory` key (`MemoryConfig` in caretaker-types) referencing the *agent* that runs the summarize calls — every provider type works, claude-code included, since the sweep launches through the harness loop. Off unless configured. Sweep failures are isolated per session: a digest save that throws (e.g. a hand-copied session file whose name the store rejects) skips that session instead of aborting the sweep.
