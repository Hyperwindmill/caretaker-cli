---
'webview-ui': patch
---

Fix conversation delete in VSCode sidebar mode by replacing the disabled
`window.confirm()` call with an inline React confirmation dialog. The
overlay supports Escape-key and backdrop-click dismissal and renders
correctly inside both the sidebar and chat layouts (fixes a JSX syntax
error that broke the build).