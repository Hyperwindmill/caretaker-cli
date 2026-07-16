---
'caretaker-cli': patch
---

Fix PDF parsing crash in the VSCode extension host: unpdf's bundled pdfjs assigns `globalThis.navigator` at import time, which throws ("Cannot set property navigator ... only a getter") on hosts exposing navigator as a getter-only nullish property. `read_document`/`read_attachment` now redefine it as a writable data property before loading unpdf. Also replace the PDF fallback: pandoc cannot read PDFs (write-only), so the fallback now uses pdftotext (poppler) when installed.
