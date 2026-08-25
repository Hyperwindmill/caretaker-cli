---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

New provider type `acp`: drive any Agent Client Protocol agent (claude-agent-acp, codex-acp, Google agy_acp_server, …) as a caretaker runner — side-by-side with the claude-code runner. One ACP client implementation covers chat on every surface, scheduled runs, and autonomous task cycles (planner read-only via permission policy, Docker confinement via deny-execute + a bridge-injected run_command tool).
