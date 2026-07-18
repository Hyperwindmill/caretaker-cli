---
"@hyperwindmill/caretaker-cli": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

fix(tasks): persist the running agent identity on each cycle message so the log distinguishes planner from developer

The previous label resolved the agent live in the UI by message type, which
couldn't tell a planning cycle's heartbeat output from a developer cycle's — so
planning bubbles showed the developer name. The per-cycle message now stores
`agentLabel` (`name · model`) captured at run time from the role-resolved agent,
and the thread renders that. It's text of the moment, so it stays correct even
if the agent is later renamed or re-modelled. The live UI heuristic remains only
as a fallback for older messages.
