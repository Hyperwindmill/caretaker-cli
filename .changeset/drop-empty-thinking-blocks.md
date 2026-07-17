---
'caretaker-cli': patch
'webview-ui': patch
---

fix(claude-code): drop empty thinking blocks. Opus (extended thinking off) emits an empty `thinking` block in the final assistant message; it was persisted and rendered as an empty "Thinking Process" box when a chat was reloaded (never live). Guard at parse time (`claude_code_stream`) plus render-side guards in the web and TUI reload paths so already-persisted empty blocks are hidden too.
