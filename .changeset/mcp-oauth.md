---
"caretaker-cli": minor
"caretaker-types": minor
---

Add OAuth authentication for http MCP servers. An explicit per-server
"Authenticate" action runs the SDK OAuth flow (Dynamic Client Registration +
PKCE) via an ephemeral loopback callback, and tokens are stored AES-256-GCM
encrypted in `mcp.json`. Passive connects use the saved tokens and refresh them
automatically; unattended runs never open a browser.

Re-authenticating on a fresh loopback port discards the stale DCR registration
together with its orphaned tokens, so the browser flow runs cleanly instead of
failing a refresh against a re-registered client.








