---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
'caretaker-vscode': patch
'caretaker-desktop': patch
'caretaker-types': patch
---

Make the autonomous task execution log more compact: tool calls now render as
left-aligned bubbles with a shortened preview instead of full-width blocks, and
consecutive tool calls flow inline on a wrapping row instead of each occupying its
own line. Hover or focus a bubble to preview its full arguments; click to pin an
expandable, scrollable popover. The main chat and scheduler views are unchanged.



