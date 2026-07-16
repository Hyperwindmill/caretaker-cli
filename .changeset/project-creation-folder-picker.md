---
"webview-ui": patch
---

Add folder picker to project creation modal

The "Register New Project" modal in the Projects tab used a plain text input
for the working directory path. It now uses the existing `FolderPicker`
component (already used in project settings, agents, and plugins tabs), giving
users a "Browse..." button to navigate the filesystem visually instead of
typing the absolute path by hand.