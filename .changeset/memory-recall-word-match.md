---
'@hyperwindmill/caretaker-cli': patch
---

Memory recall matches keywords word-by-word: any word of a multi-word keyword fires ("reaper linux" now surfaces on "reaper"), and the full phrase scores higher because every word matches. Whole-keyword substring matching made multi-word keywords stricter instead of looser.
