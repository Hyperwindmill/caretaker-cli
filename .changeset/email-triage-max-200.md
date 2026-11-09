---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
---

Email triage: "Max emails per run" now goes up to 200 (the scan window) instead of 50. Only envelopes reach the triage prompt, so the per-call body cap of `email_fetch` no longer applies to it.
