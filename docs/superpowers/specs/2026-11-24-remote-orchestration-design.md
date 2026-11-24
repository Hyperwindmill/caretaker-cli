# Remote orchestration — design

Date: 2026-11-24

## Intent

A company wants to run autonomous development on its people's machines: the
tasks run on each person's local caretaker, with that person's agents, under
that person's responsibility, and the person can follow every task in their own
GUI. A personal PC (or the desktop app) cannot accept inbound connections, so
the usual "orchestrator calls the worker" direction is inverted: **caretaker
calls the orchestrator**. It registers, polls for messages addressed to it, and
applies them to its own REST API.

The protocol is ours. This document defines version 1.

## Goals

- A caretaker instance, once configured, registers with a remote orchestrator
  and polls it at a configurable interval.
- A message is a REST request against caretaker's documented project/task API;
  its response travels back on the next poll.
- The user decides how much authority the orchestrator has: apply everything,
  or approve each write by hand.
- The user sees the connection state, can test connectivity before saving, and
  sees every message the orchestrator sent and what happened to it.
- A demo orchestrator ships with the CLI: the e2e tests run against it and a
  developer can try the feature locally with `curl`.
- The settings panel moves to a vertical navigation on the wide layout, because
  this adds an eleventh tab.

## Non-goals

- A production orchestrator. Only the protocol, the client and the demo.
- Push or realtime transport (WebSocket, SSE, long polling).
- The orchestrator observing state it did not ask for. It learns task state by
  enqueueing `GET` messages. No automatic snapshot rides the poll.
- Per-route policy rules. The policy is one switch.
- Cancelling a message that is waiting for approval, or expiring it.
- Advertising the instance's agents to the orchestrator. A remote task that
  names no agent falls back to the project's, then the first agent, as today.
- The feature on the TUI, the VSCode sidebar or headless `run`. It is
  web-server-only, like the scheduler (the desktop app gets it by forking the
  web server).
- An agent tool for approving messages or editing this configuration. An agent
  approving remote commands for the user defeats the point of the approval.

## Anti-goals

- A message must never be applied twice, whatever the orchestrator re-sends and
  whenever caretaker crashes.
- In `approve` policy nothing that changes state may run before the user's
  click.
- The orchestrator must not reach anything outside the documented project/task
  routes: not `/api/fs`, not voice, not settings, not token management, not
  this feature's own management routes.
- A failing orchestrator (down, slow, wrong token) must never affect the web
  server, the scheduler or the GUI.

## Trust statement (goes in the README too)

In `auto` policy the orchestrator token grants the orchestrator the full
project/task surface: it can create a project with `bootstrapCommands` and
activate a task, which is code execution on the user's machine. That is the
feature, not a hole. The `approve` policy is the user-side brake.

## Approaches considered

**A. Plain HTTP polling with a REST envelope — chosen.** Three outbound calls
(`health`, `register`, `poll`). A message is `{id, method, path, body}`; caretaker runs it
in-process on its own Hono app and returns `{id, status, body}` with the next
poll. Latency equals the poll interval. Works through any corporate proxy, and
the existing OpenAPI document of the project/task routes is the command
contract, so there is no second command list to maintain.

**B. Persistent outbound channel (WebSocket/SSE).** Realtime, but needs
reconnection, keepalive and survives badly behind proxies that cut long
connections. Much more code for latency that minutes-long autonomous tasks do
not need.

**C. Typed commands (`task.create`, `task.pause`, …) instead of a REST
envelope.** Decouples the protocol from the API's shape, at the price of a
second contract kept aligned with OpenAPI by hand. Rejected.

Daniele picked A, and a **configurable** policy over a fixed "remote tasks
arrive as drafts" rule.

## Protocol v1

Three calls, all to the configured endpoint (a base URL) with
`Authorization: Bearer <token>`. Bodies and answers are JSON.

### Health

```
GET {endpoint}/health
← 200 { "ok": true, "protocol": 1, "name": "<orchestrator's display name>" }
```

The orchestrator introduces itself. It requires the token like the other two
calls, so a `200` proves reachability **and** that the token is accepted. It
has no side effect: nothing is registered. This is what "Test connection"
calls, so the user sees by name where they are about to connect before saving.

### Register

```
POST {endpoint}/register
→ { "protocol": 1, "instanceId": "<uuid>", "name": "<friendly name>", "version": "<caretaker version>" }
← 200 { "ok": true, "name": "<orchestrator's display name>" }
```

The returned `name` is what the panel shows next to "Connected". Idempotent upsert keyed by `instanceId`. `instanceId` is a UUID caretaker
generates once and persists; the name is a label and may change (a later
register carries the new one).

### Poll

```
POST {endpoint}/poll
→ { "instanceId": "<uuid>", "results": [ { "id": "<message id>", "status": 200, "body": <json|string|null> } ] }
← 200 { "messages": [ { "id": "<message id>", "method": "POST", "path": "/api/projects/acme/tasks", "body": <json, optional> } ] }
```

- `results` carries every result not yet delivered. A `2xx` answer to the poll
  is the acknowledgement: caretaker then marks those results delivered and
  never sends them again.
- **Delivery is at-least-once from the orchestrator's side.** It must keep
  offering a message until it has received that message's result. Caretaker
  de-duplicates by message `id` (see Ledger), so re-offering is safe.
- A message waiting for the user's approval has no result yet; the orchestrator
  keeps offering it and caretaker keeps ignoring the duplicate.
- Messages are applied sequentially, in array order.
- `path` is a pathname plus optional query string. Anything else (absolute URL,
  no leading `/`) is refused.
- A poll answered `401`/`403`/`404`/`409` means "I do not know you": caretaker
  drops to unregistered and registers again on the next cycle.

### Result statuses

`status` is the HTTP status of the applied request, and `body` its response
body (parsed JSON when the response is JSON, text otherwise). Statuses caretaker
produces itself, all with body `{ "error": "<reason>" }`:

| status | meaning |
|-------|---------|
| 403 | the user rejected the message (`approve` policy) |
| 404 | method + path is not a documented project/task route |
| 400 | malformed message (bad path, unknown method) |
| 413 | the response body exceeded the 1 MB cap and was dropped |
| 500 | caretaker restarted while applying it; outcome unknown, not retried |

A message without a usable `id` (missing, not a string, empty) cannot be
answered or de-duplicated: it is dropped, not ledgered, and reported as the
status' `lastError` so the user sees the orchestrator is misbehaving.

## Client behaviour

### Allowed routes

A message is allowed iff its method and pathname match an entry of the OpenAPI
`paths` object in `cli/web/openapi.ts` (path templates `{id}` match one
segment). The matcher is exported from that module so the allowlist and the
document cannot diverge. `GET /api/openapi.json` is allowed too, so an
orchestrator can discover the contract through the channel. Everything else
gets a `404` result without touching the app.

### Applying a message

In-process: `app.request(path, { method, headers, body })` on the web server's
Hono app. No network hop, no API port, no API token. The response is read
fully as text (this also covers the ndjson stream of
`POST /api/projects/{id}/sync`), capped at 1 MB.

### Policy

`policy: 'auto' | 'approve'`, default `approve`.

- `auto`: every allowed message is applied on arrival.
- `approve`: `GET` messages are applied on arrival. Every other method is stored
  as `pending` and shown in the panel's inbox with Approve and Reject. Approve
  applies it now (not at the next poll); Reject records a `403` result. Either
  result is delivered with the next poll.
- Switching `approve → auto` does not auto-apply what is already pending. The
  user clears the inbox by hand. (My call: a policy switch should not fire a
  backlog the user has not looked at.)

### Ledger (dedupe, inbox and audit in one)

One file under `CARETAKER_HOME`, written atomically like every other JSON
store. One record per message:

```
{ id, method, path, body?, receivedAt,
  state: 'pending' | 'applying' | 'done',
  result?: { status, body? }, resolvedAt?, delivered: boolean }
```

- Every message with an id gets a record, refused ones (`400`, `404`) included:
  they need delivery, dedupe and an Activity row.
- **Bodies are short-lived and encrypted at rest.** A request body can carry a
  secret (`repositoryToken` on `POST /api/projects`) and a result body can be
  1 MB. Both are stored as one `lib/encryption.ts` blob each. The request body
  is deleted from the record when the message reaches `done`; the result body
  is deleted when the result is delivered. A settled record is just
  `{ id, method, path, receivedAt, state, result: { status }, resolvedAt, delivered }`.
- **The ledger belongs to one orchestrator.** When a save changes the
  endpoint's host (`sameHost`), the whole ledger is purged: pending messages
  and undelivered results of the old orchestrator must not reach the new one,
  and its message ids mean nothing to it.

- A message whose `id` is already in the ledger is ignored.
- The record is written with `state: 'applying'` **before** the request runs
  and `done` after. On boot, any record still `applying` becomes `done` with a
  `500` result: the outcome is unknown and re-applying could create a duplicate.
- The ledger keeps the most recent 500 records; older `done` + `delivered`
  records are trimmed. `ponytail:` the dedupe window is therefore 500 messages;
  a message re-offered after its record was trimmed would be applied again. The
  orchestrator stops offering a message once it has the result, so this needs a
  misbehaving orchestrator. Upgrade path: keep a separate id-only set.
- The panel's activity list is this ledger, newest first.

### Loop

A self-rescheduling timer owned by a new module (`cli/web/orchestrator.ts`),
started in `cli/web/server.ts` next to `startBackgroundScheduler()` and
restarted whenever the configuration is saved. It is **not** a scheduler
strategy: the interval is its own, not the 15 s tick.

Each cycle: if not registered, register; if that worked, poll. Outbound
requests carry a 30 s timeout. A failure is recorded in the status and the loop
simply tries again after the interval (no backoff: the interval is already the
user's choice). One cycle at a time; a slow cycle delays the next, never
overlaps it.

Two caretaker web servers on the same `CARETAKER_HOME` (desktop app plus a
`caretaker-cli web`) would both poll. This is the same known limit the
scheduler has and is not solved here.

### Configuration and state on disk

A new file `orchestrator.json` under `CARETAKER_HOME`, not `caretaker.json`:
the settings form saves `caretaker.json` whole from a stale copy, and this file
holds a secret and a generated identity that must not travel to the view.

```
{ enabled: boolean, name: string, endpoint: string, token: <encrypted>,
  pollSeconds: number, policy: 'auto' | 'approve', instanceId: string }
```

- `token` is encrypted at rest with `lib/encryption.ts`, never returned to the
  view (the view gets `hasToken: boolean`). A blank token on save keeps the
  stored one.
- `pollSeconds`: default 15, clamped 5–3600.
- `endpoint`: must be `https`, or `http` only for a loopback host. The token
  must not cross the network in clear.
- If the endpoint's host changes on save and no new token is typed, the stored
  token is dropped (reuse `sameHost` from `voice_proxy.ts`): a token only goes
  to the host it was saved for.
- `instanceId` is generated and persisted the first time the file is loaded.

### Management routes (main port only)

Plain HTTP like `/api/access`, in the same module as the loop:

- `GET /api/orchestrator` → config without the token, plus status
  `{ state: 'off' | 'registering' | 'connected' | 'error', orchestratorName?, lastPollAt?, lastError? }`,
  the pending count, and the ledger as summaries: no result bodies ever; the
  request body only for `pending` records (the user must see what they
  approve), with `repositoryToken` replaced by a placeholder.
- `PUT /api/orchestrator` → save, restart the loop, return the same shape.
- `POST /api/orchestrator/test` → takes the **unsaved** endpoint and token,
  calls `health` and returns `{ ok, name?, protocol?, error? }`. Uses the typed
  token, else the stored one under the same-host rule. Registers nothing. A
  `protocol` other than 1 is reported as a failure naming both versions.
- `POST /api/orchestrator/messages/:id/approve` and `…/reject` → resolve a
  pending message; 404 on unknown id, 409 if it is not pending.

`/api/orchestrator` is added to the exclusion list in `isApiPath`
(`api_access.ts`): an API token must not reconfigure the orchestrator or
approve its messages. The remote allowlist excludes it by construction.

## Prerequisite fix: a settings save must not delete projects

The settings form saves `caretaker.json` whole from the copy it loaded
(`saveConfig` ws handler in `cli/web/server.ts`). A project created over REST
while the form is open is absent from that copy, so the next save of any tab
deletes it silently (or errors with "still has N task(s)" once it has tasks).
The API port already has this hazard; with remote orchestration, background
project creation becomes the normal case.

Fix, as its own commit before the orchestration work: in the **web server's**
`saveConfig` handler, a project present on disk and absent from the incoming
payload is **kept** (merged back into the saved config), never deleted. Project
deletion goes only through `DELETE /api/projects/:id`, which the settings
Projects tab already calls (`ProjectsTabSettings.tsx`); after it the project is
gone from disk, so nothing is merged back. The "still has N task(s)" guard
becomes unreachable and is removed. The builder checks that the tab's delete
flow does not rely on the follow-up save to remove the entry. The VSCode host's
own `saveConfig` handler is left alone: that surface has no REST routes and
does not show the Projects tab.

Out of scope: a stale save still overwrites *edits* made elsewhere to a project
both copies contain. Nothing in the remote surface edits an existing project.

## UI

### Settings navigation goes vertical (separate commit, first)

On `layout === 'sidebar'` (web GUI and desktop, the wide surfaces) the tab
strip becomes a vertical list on the **left** of the settings content, next to
the app's nav rail. `layout === 'compact'` (VSCode sidebar, narrow, shows only
four tabs) keeps the horizontal strip. The ten hand-written tab buttons become
one array rendered in a loop.

```
┌──────────────┬──────────────────────────────────────┐
│ Providers    │                                      │
│ Projects     │   <active tab content>               │
│ Agents       │                                      │
│ Plugins      │                                      │
│ MCP          │                                      │
│ Services     │                                      │
│ Voice        │                                      │
│ Memory       │                                      │
│ Desktop      │                                      │
│ API          │                                      │
│ Orchestration│                                      │
└──────────────┴──────────────────────────────────────┘
```

### Orchestration tab

`OrchestrationTab.tsx`, gated `layout === 'sidebar'`, plain HTTP against
`/api/orchestrator`, refreshed every few seconds while the tab is open.

```
Orchestration            ● Connected to "Acme Dev Orchestrator" · last poll 4s ago
[x] Enabled
Instance name   [ Daniele's workstation      ]
Endpoint        [ https://orchestrator.acme.io/v1 ]
Token           [ ••••••••  (leave blank to keep) ]
Poll every      [ 15 ] seconds
Policy          (•) Ask me before applying changes   ( ) Apply automatically
[ Test connection ]  [ Save ]
  ✓ Reached "Acme Dev Orchestrator" (protocol 1)        ← after Test connection

Waiting for approval (2)
  POST /api/projects/acme/tasks      "Add CSV export"     [Approve] [Reject]
  POST /api/tasks/acme-12/status     → active             [Approve] [Reject]

Activity
  12:04  GET  /api/projects/acme/tasks        200
  12:03  POST /api/projects/acme/tasks        403 rejected
```

A pending row shows method, path and an expandable JSON body. The pending
count is shown as a badge on the Orchestration nav entry; how the count reaches
the nav while the tab is closed is left to the builder.

## Demo orchestrator

`caretaker-cli orchestrator-demo --port <n> --token <t> [--name <display name>]`:
an in-memory Hono server, exported as a function so the tests start it
in-process. It implements `/health`, `/register` and `/poll` as specified (bearer check, at-least-once re-offering
until a result arrives) plus three admin routes for a human with `curl` or a
test:

- `GET /instances` → registered instances with last-seen time
- `POST /instances/:id/messages` → enqueue `{ method, path, body }`, returns the
  message id
- `GET /instances/:id/results` → results received so far

No persistence, no UI. It doubles as the reference implementation of the
protocol for anyone writing a real orchestrator.

## Testing

- Unit: route matcher; policy decision; ledger transitions including the
  `applying`-on-boot recovery and duplicate ids; endpoint validation; the
  same-host token rule.
- e2e (node test runner, in-process): demo orchestrator + the web server's real
  Hono app on an isolated `CARETAKER_HOME` (env set at file scope). Today the
  app is built inline in `startServer`, which also binds the port and boots the
  scheduler. First commit of this work: split it into a `createApp()` that
  registers the routes and returns the app, called by `startServer`. The routes
  stay in `server.ts` (the diff is the function boundary, and
  `openapi.test.ts`, which reads that file's source, is unaffected). If a route
  closes over something created after `serve()`, the builder threads it
  through rather than moving routes out. Cases:
  register then create a project and a task end to end; a re-offered message is
  applied once; `approve` holds a `POST` until approved and returns `403` on
  reject; a disallowed path returns `404` and never reaches the app; a wrong
  token leaves the status in `error` and the server healthy; Test connection
  returns the orchestrator's name and registers no instance.

## Docs and release

- `CLAUDE.md`: a new layer describing the feature; the `isApiPath` exclusion
  list; the new state file.
- `README.md`: user-facing section with the trust statement and the demo
  walkthrough.
- `docs/orchestration-protocol.md`: the protocol section of this document as a
  standalone reference for orchestrator implementers.
- One changeset, `minor`.

## Left to the builder

- File and function names beyond those given here.
- How the pending count reaches the nav badge.
- CSS of the vertical navigation.
- The exact wording of UI labels and error messages.
