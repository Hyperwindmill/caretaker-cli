---
'@hyperwindmill/caretaker-cli': minor
---

Memory subsystem step 2: the memory sweep's per-chunk call now also extracts durable memories (project/global scope, fact/episode kind, tone-derived importance) into a new `memories` folder-DB collection. Write path only; same model-call count as before. Pure extraction helpers and scope resolution.
