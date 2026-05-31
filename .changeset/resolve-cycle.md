---
"caretaker-types": patch
"webview-ui": patch
"caretaker-cli": patch
---

Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
