---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
---

The update banner's **Update CLI** and **Copy command**, and the TUI's update line, use `pnpm add -g` when the CLI was installed with pnpm, instead of always `npm i -g`.
