---
"webview-ui": patch
"caretaker-vscode": patch
---

VSCode sidebar no longer exposes the Projects (autonomous tasks) entry point. Projects is scheduler-driven, and the VSCode surface never boots the scheduler, so the button was misleading there. It's now gated to the sidebar layout (web/desktop) only — the same gating already applied to the Scheduler settings tab.
