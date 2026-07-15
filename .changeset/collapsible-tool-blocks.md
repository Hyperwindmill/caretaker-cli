---
"webview-ui": patch
---

Web UI: tool use blocks are now collapsed by default. The compact header shows the tool name, a smart one-line arg preview (basename for path-like args such as read/write, the command for shell tools, else truncated JSON), a neutral outcome hint (spinner while running, then line count or byte size of the result), and a chevron. Clicking expands the full pretty-printed args and result. Reuses the existing `<details>` accordion pattern; no bridge/harness changes.
