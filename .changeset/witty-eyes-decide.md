---
'@hyperwindmill/caretaker-cli': patch
---

Drop the last GPL dependency: the TUI wordmark is now a static banner (generated
once with figlet, MIT) instead of ink-big-text, whose transitive `cfonts` is
GPL-3.0 — not shippable inside the FSL-licensed Electron installers, which bundle
the CLI's production tree. Same look, one dependency fewer.
