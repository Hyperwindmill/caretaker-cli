---
"caretaker-cli": patch
---

Fix git plugin refresh failing on Windows with a spurious "local changes" error. isomorphic-git's in-place fetch+checkout reports the working tree as dirty on Windows (filemode/stat mismatch or locked files) and throws even with `force: true`, where Linux succeeds. The updater now falls back to a fresh shallow reclone when the in-place update throws, self-healing the cache on any platform.
