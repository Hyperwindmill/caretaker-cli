---
'webview-ui': patch
---

Fix the voice mode select (Dictate / Conversation) rendering its open dropdown
white-on-white: the select is deliberately transparent, so Chromium painted the
popup panel light while the options inherited the composer's light text. The
options now carry the dropdown colors explicitly.
