---
'@hyperwindmill/caretaker-cli': patch
---

fix(scheduler): create `scheduler-logs/` before writing the Telegram offset. The offset is committed before any run is logged, so on a fresh `CARETAKER_HOME` it was the first write into that folder and failed with `ENOENT`, breaking every Telegram poll until some other scheduler write created the dir.
