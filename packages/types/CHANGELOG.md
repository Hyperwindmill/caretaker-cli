# caretaker-types

## 0.4.1

## 0.4.0

### Minor Changes

- 0eac4c4: Add OAuth authentication for http MCP servers. An explicit per-server
  "Authenticate" action runs the SDK OAuth flow (Dynamic Client Registration +
  PKCE) via an ephemeral loopback callback, and tokens are stored AES-256-GCM
  encrypted in `mcp.json`. Passive connects use the saved tokens and refresh them
  automatically; unattended runs never open a browser.

  Re-authenticating on a fresh loopback port discards the stale DCR registration
  together with its orphaned tokens, so the browser flow runs cleanly instead of
  failing a refresh against a re-registered client.

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

### Patch Changes

- 77d3d8a: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.

## 0.2.1

### Patch Changes

- 254fba9: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
