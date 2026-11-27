---
'@hyperwindmill/caretaker-cli': patch
---

Fix the saved transcript of ACP agents: a tool result was stored before its call, so a reloaded session showed an `unknown_tool` block next to an empty one. Results are now stored after the call, and sessions saved before this fix are merged on load.
