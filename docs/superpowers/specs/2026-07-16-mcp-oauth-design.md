# MCP OAuth authentication — design

**Date:** 2026-07-16
**Status:** approved (brainstorming)

## Problem

Caretaker manages MCP servers, but http servers only carry **static headers**
(`Authorization: Bearer …`, encrypted at rest). Servers protected by OAuth —
e.g. `lh-gitlab` (`https://git.one.leviahub.com/api/v4/mcp`), which uses
OAuth with Dynamic Client Registration — cannot be used at all: there is no
authorization flow and no token storage.

## What the SDK already gives us

`@modelcontextprotocol/sdk` 1.29.0 implements the whole OAuth machinery:
`StreamableHTTPClientTransport({ authProvider })`, the `auth()` helper,
`UnauthorizedError`, Dynamic Client Registration (RFC 7591), PKCE, and
**automatic access-token refresh** via the refresh token. The only thing
missing is an `OAuthClientProvider` implementation that (a) persists
client-info + tokens, and (b) drives the interactive redirect + code capture.

## Decisions

1. **Trigger:** explicit user "Authenticate" action per server. Passive
   connects (including unattended scheduler / headless runs) never open a
   browser — on a 401 they surface "needs authentication" via
   `lastConnectError`.
2. **Callback capture:** ephemeral loopback listener on
   `http://127.0.0.1:<free-port>/callback`. Portable across TUI, web, desktop
   and VSCode; no dependency on the web server being up. Standard CLI-OAuth
   pattern.
3. **Client registration:** Dynamic Client Registration only. No manual
   `client_id`/`client_secret` fields (YAGNI — add if a real server needs
   pre-registration).
4. **No model-facing tool:** the flow is inherently interactive (browser +
   human), so it has no builtin/MCP tool mirror. This is a deliberate
   exception to the affordance→tool rule: an unauthenticated MCP server simply
   contributes no tools to a run (connect fails, server is skipped), exactly as
   in Claude Code, so there is nothing actionable to expose to the model.

## Architecture

Two paths over one storage location:

- **Passive** (`mcp/client.ts` pool, `getClient`): every http transport gets
  an `authProvider`. Saved tokens are used and auto-refreshed by the SDK.
  Harmless for servers that respond 200 with static headers. No token / failed
  refresh → `UnauthorizedError` → recorded as `lastConnectError`.
- **Interactive** (`authenticateMcpServer(id)`, explicit action): the SDK
  connect dance —

  ```
  transport = new StreamableHTTPClientTransport(url, { authProvider })
  try { await client.connect(transport) }
  catch (UnauthorizedError) {          // redirectToAuthorization already opened the browser
    const code = await waitForLoopbackCallback()
    await transport.finishAuth(code)   // exchanges code→tokens, saved via provider
    await client.connect(transport)    // retry, now authorized
  }
  ```

## Components

### Storage — `McpServerConfig` (packages/types)

New optional field:

```ts
/** OAuth state for an http MCP server, AES-256-GCM encrypted at rest:
 *  a single encrypted JSON blob of { clientInformation, tokens }. */
oauthState?: string;
```

One encrypted blob, not N fields: a single `encrypt()`/`decrypt()` round-trip,
inherits the existing atomic-write, and the secrets (`client_secret`,
`refresh_token`) never touch disk in cleartext. The PKCE code verifier is
**not** persisted — it lives on the provider instance for the duration of one
interactive flow. OAuth discovery state is not persisted (re-discovery is
cheap; skipping it means nothing to invalidate).

### `packages/cli/src/mcp/oauth.ts` (new)

- `class StoredOAuthProvider implements OAuthClientProvider` — backed by one
  `mcp.json` row (`oauthState`). Implements `clientInformation` /
  `saveClientInformation`, `tokens` / `saveTokens` (load → decrypt blob →
  mutate → encrypt → atomic save via `loadMcpServers`/`saveMcpServers`),
  `saveCodeVerifier` / `codeVerifier` (in-memory), `redirectUrl`,
  `clientMetadata`, and `redirectToAuthorization(url)` → opens the browser.
- `buildAuthProvider(server)` — used by `client.ts` for the passive path.
- `authenticateMcpServer(id)` — the interactive flow: pick a free port, start
  the loopback listener, run the connect dance, `finishAuth`, reconnect, close
  the listener. Persistence side-effects happen through the provider.
- `revokeMcpAuth(id)` — clears `oauthState` (logout).

### `packages/cli/src/lib/open_url.ts` (new)

Cross-platform browser opener (`xdg-open` / `open` / `start`), ~8 lines of
`child_process`. No installed dependency covers it.
`// ponytail: 3 OS branches, that's the whole feature.`

### `packages/cli/src/mcp/client.ts` (edit)

`openClient` attaches `authProvider: buildAuthProvider(server)` to the http
transport. No other change to the pool.

## UI wiring (explicit action)

- **Web** (`cli/web/server.ts`): an `authenticate` action (route or WS message)
  by server id → `authenticateMcpServer(id)`. Browser opens server-side;
  `redirect_uri` is `127.0.0.1:<port>`.
  `// ponytail: loopback assumes server and browser on the same host; a remote web server is not covered.`
- **TUI** (`tui/mcp_servers.tsx`): an "Authenticate" key on the selected http
  row.
- **VSCode**: expose `authenticateMcpServer` through the harness; the sidebar
  button calls it. Loopback works identically.
- **Status in UI**: derived, no new field — `oauthState.tokens` present →
  "authenticated"; `lastConnectError` matching 401 / Unauthorized → "needs
  authentication".

## Error handling

- Server without DCR support → `auth()` fails; surface a clear
  "server does not support dynamic client registration" error, do not persist
  partial state.
- User closes the browser / no callback → the loopback wait times out
  (bounded, e.g. 5 min), listener closes, error surfaced. No dangling port.
- Refresh failure on a passive connect → `UnauthorizedError` →
  `lastConnectError`; the user re-runs "Authenticate".

## Testing

- `StoredOAuthProvider` persistence: `saveClientInformation` + `saveTokens`
  round-trip through an encrypted `oauthState` blob; `tokens()` /
  `clientInformation()` read it back; cleartext secrets never appear in the
  on-disk JSON (assert the blob is `isEncrypted`). File-scoped
  `CARETAKER_HOME` isolation.
- Loopback callback: the listener resolves with the `code` query param and
  rejects/times out otherwise.
- `revokeMcpAuth` clears the blob.
- The full SDK OAuth handshake (discovery/DCR/exchange/refresh) is the SDK's
  own tested surface — not re-tested here.

## Out of scope

- Manual client credentials (no DCR).
- Remote (non-localhost) web server OAuth.
- Any model-facing tool.
