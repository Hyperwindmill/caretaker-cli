---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
---

Secret fields in the settings forms now behave the same way: the field starts empty when editing, leaving it blank keeps the saved value, and an optional secret has a "Remove saved value" button. This covers the provider API key, the plugin source token, the project repository token, the orchestration token and the Telegram, IMAP and SMTP secrets of a service; the plugin source, repository and orchestration tokens could not be removed before. The voice keys are unchanged. The TUI plugin source form removes the token when `-` is entered.
