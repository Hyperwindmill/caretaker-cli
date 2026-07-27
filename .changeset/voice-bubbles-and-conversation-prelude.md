---
"@hyperwindmill/caretaker-cli": minor
"caretaker-desktop": minor
"caretaker-vscode": minor
"webview-ui": minor
"caretaker-types": minor
---

Conversation-mode voice now speaks every finalized assistant bubble in order
as it closes (previously only the last bubble of a turn was read), and the
agent is told via a per-turn system-prompt block that its reply will be read
aloud, so it writes well-punctuated, speakable prose. The mic reopens only
after the last bubble finishes playing and the harness turn is over. Applies
to both native and claude-code providers. The voice flag is wired end-to-end:
the renderer sets it on the start message for conversation-mode transcripts,
the web server forwards it to harness.run, and the VSCode host ignores it
(voice is unavailable in the sidebar, and the field is optional).