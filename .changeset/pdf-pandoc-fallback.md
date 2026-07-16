---
'caretaker-cli': patch
---

Add pandoc fallback for PDF parsing: `read_document` and `read_attachment` try the native unpdf parser first, and if it throws, fall back to pandoc when installed on the system. If pandoc also fails, a combined error (unpdf + pandoc) is surfaced; if pandoc is not installed, the original unpdf error propagates. Defensive hardening — extraction failures now always have a recovery path or a clear error.
