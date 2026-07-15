---
"caretaker-cli": minor
"caretaker-types": minor
---

Add OAuth authentication for http MCP servers. An explicit per-server
"Authenticate" action runs the SDK OAuth flow (Dynamic Client Registration +
PKCE) via an ephemeral loopback callback, and tokens are stored AES-256-GCM
encrypted in `mcp.json`. Passive connects use the saved tokens and refresh them
automatically; unattended runs never open a browser.








