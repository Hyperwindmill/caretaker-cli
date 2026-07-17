---
'caretaker-cli': patch
---

fix(tui): stop the shell-env probe from suspending the TUI on Linux. The boot-time interactive-shell probe (`bash -i -c env`, used to pick up NVM/volta PATH) ran in the same session as the process, so its job-control setup sent SIGTTIN/SIGTTOU to our process group and stopped the TUI right after the menu rendered (`[1]+ Stopped`). Spawning it `detached: true` (own session, no controlling terminal) disables bash's job control while still sourcing `.bashrc`.
