---
'caretaker-cli': patch
---

fix(tui): exit the process cleanly on ESC/Quit. `runCli` rendered the Ink app and returned without awaiting `waitUntilExit()`, so `useApp().exit()` (ESC or the Quit menu item) unmounted the UI but left the event loop alive on background boot handles (MCP pool, model-limits fetch, refresh-on-start) — the TUI looked frozen until Ctrl+C. Now `runCli` awaits `waitUntilExit()` and `process.exit(0)`s.
