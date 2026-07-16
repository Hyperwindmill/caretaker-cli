---
"caretaker-cli": patch
"caretaker-desktop": patch
"caretaker-vscode": patch
"webview-ui": patch
"caretaker-types": patch
---

Hide Projects settings tab from the VSCode extension

Completes the gating introduced in 59d3703: the VSCode sidebar no longer shows the "Projects" tab in Settings either. Projects (autonomous tasks) is scheduler-driven, and the VSCode surface never boots the scheduler, so the tab was misleading there. The "Projects" settings tab and the Projects screen are now both gated to the `sidebar` layout (web/desktop) only — matching the Scheduler settings tab. Web and desktop surfaces keep full Projects functionality unchanged.
