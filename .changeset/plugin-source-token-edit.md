---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
---

Editing a git plugin source in the web GUI no longer breaks its token with `401 Unauthorized` (#2): the token field starts empty and an empty field keeps the stored token, like the TUI. Tokens already damaged by earlier edits work again on the next sync.
