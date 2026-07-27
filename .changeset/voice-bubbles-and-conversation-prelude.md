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
to both native and claude-code providers.