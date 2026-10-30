---
'@hyperwindmill/caretaker-cli': patch
'caretaker-vscode': patch
---

Changing an agent's provider while its chat was open in the web GUI, the desktop app or the VSCode sidebar no longer runs the new model against the old provider. The selected agent's provider is now re-resolved whenever the config changes on disk. An already-open conversation also picks up the new agent, provider and tool settings on its next turn instead of keeping the old ones until another session is selected; a turn already running finishes on the settings it started with.
