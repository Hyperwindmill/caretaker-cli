---
'@hyperwindmill/caretaker-cli': patch
---

Memory sweep: Telegram chat sessions (`telegram_<chatId>`) no longer fail to save their digest. The store's id guard rejected the underscore, so every sweep re-ran the model on the same chunk and logged `Invalid session id`.
