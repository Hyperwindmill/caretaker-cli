# Remote Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A caretaker web server registers with a remote orchestrator over an outbound connection, polls it for REST-envelope messages, applies them to its own project/task API under a user-chosen policy, and reports the results.

**Architecture:** A self-rescheduling loop in the web server calls three orchestrator endpoints (`health`, `register`, `poll`). Each message is run in-process with `app.request()` on the server's own Hono app, restricted to the routes in the OpenAPI document. A ledger file gives dedupe, the approval inbox and the audit list. A demo orchestrator (in-memory Hono) ships as a CLI subcommand and drives the e2e tests in-process.

**Tech Stack:** TypeScript (ESM, strict), Hono, Node test runner via `tsx`, React (webview-ui, esbuild), `lib/encryption.ts` (AES-256-GCM). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-remote-orchestration-design.md` — read it before any task; this plan does not repeat its reasoning.

## Global Constraints

- All code, comments and docs in English. Generic names only in examples and defaults (no real company or product names; `Acme`, `example.com` are fine).
- No new npm dependencies.
- Web-server-only feature: nothing in the TUI, the VSCode host or headless `run`.
- No agent tool for this feature (no approve/reject tool, no config tool).
- Tests: co-located `*.test.ts`, Node test runner, `process.env.CARETAKER_HOME` set at **file scope** (top of the file, before imports that touch the store), never inside a `describe`/`test`.
- `pnpm test` does not type-check. Every task ends with `pnpm -F @hyperwindmill/caretaker-cli typecheck` (and `pnpm -F webview-ui build` when the webview changed) before its commit.
- Persisted state: tmp file + rename (`atomicWriteFile` from `cli/web/scheduler/telegram_window.ts`); paths come from accessor functions resolved at call time.
- Protocol values, verbatim: protocol version `1`; `pollSeconds` default `15`, clamped `5`–`3600`; outbound timeout `30` s; response-body cap `1 MB` (1 048 576 bytes); ledger size `500` records; default policy `approve`; endpoint `https`, or `http` only on `127.0.0.1` / `localhost` / `[::1]`.
- Git: one commit per task, never amend or rebase, work on the current branch, no worktrees. Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` (or the executing model's own line).
- Each task that changes behaviour adds its changeset file under `.changeset/` (frontmatter lists `@hyperwindmill/caretaker-cli` with the bump named in the task).
- Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and the upgrade path.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task named.

1. **Path tricks in a message** — `/api/projects/../orchestrator`, `//evil.example/api/projects`, `/api/projects/%2e%2e/access`: the route check and the request both use the **normalized** pathname; all end as a `404` result and never reach a non-documented route. (Task 4, Task 5)
2. **The orchestrator answers `200` with something that is not the protocol** — an HTML login page from a proxy, `messages` not an array, array items that are not objects: the cycle records a readable `lastError`, applies nothing, does not throw, and the next cycle runs. (Task 5)
3. **Approve clicked twice, or while a poll cycle is writing the ledger**: the message is applied exactly once; the second call answers `409`. (Task 5)
4. **Endpoint written with a trailing slash or a path prefix** (`https://host/v1/`): calls go to `https://host/v1/register`, never `//register` and never dropping `/v1`. (Task 4)
5. **Enabled but incomplete configuration** (no endpoint or no token): state is `error` with `lastError` "Endpoint and token are required.", and no outbound call is made. (Task 5)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/cli/src/cli/web/save_config.ts` (new) | pure merge that keeps on-disk projects missing from a settings save |
| `packages/cli/src/cli/web/server.ts` | `createApp()` split out of `startServer`; calls the merge; boots the orchestrator loop |
| `packages/cli/src/cli/web/openapi.ts` | exports `isDocumentedRoute` |
| `packages/cli/src/store/orchestrator.ts` (new) | `orchestrator.json` and `orchestrator-ledger.json` load/save |
| `packages/cli/src/cli/web/orchestrator_core.ts` (new) | pure protocol logic: validation, message parsing, policy, ledger transitions, view summaries |
| `packages/cli/src/cli/web/orchestrator.ts` (new) | stateful client: apply, cycle, loop, status, management routes |
| `packages/cli/src/cli/web/api_access.ts` | `/api/orchestrator` added to the `isApiPath` exclusions |
| `packages/cli/src/cli/orchestrator_demo.ts` (new) | demo orchestrator |
| `packages/cli/src/cli/index.ts` | `orchestrator-demo` subcommand |
| `packages/webview-ui/src/settings_tabs.ts` (new) | the tab list per layout |
| `packages/webview-ui/src/SettingsPanel.tsx`, `styles.css` | vertical nav, badge |
| `packages/webview-ui/src/OrchestrationTab.tsx` (new) | the panel |
| `packages/webview-ui/src/App.tsx` | pending-count poll for the nav badge |

---

### Task 1: A settings save never deletes a project

**Files:**
- Create: `packages/cli/src/cli/web/save_config.ts`, `packages/cli/src/cli/web/save_config.test.ts`
- Modify: `packages/cli/src/cli/web/server.ts` (the `case 'saveConfig'` block, around line 1256)
- Modify: `CLAUDE.md`, `.changeset/<new>.md` (patch)

**Interfaces:**
- Produces: `keepMissingProjects<T extends { id: string }>(onDisk: T[], incoming: T[]): T[]`

- [ ] **Step 1: Write the failing test** (`save_config.test.ts`)

```ts
test('projects on disk and absent from the save are kept, after the incoming ones', () => {
  const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' }, c = { id: 'c', name: 'C-edited' };
  assert.deepEqual(keepMissingProjects([a, b, { id: 'c', name: 'C' }], [c, a]), [c, a, b]);
});
test('an incoming edit wins over the on-disk copy', () => {
  assert.deepEqual(keepMissingProjects([{ id: 'a', name: 'old' }], [{ id: 'a', name: 'new' }]), [{ id: 'a', name: 'new' }]);
});
test('empty inputs', () => {
  assert.deepEqual(keepMissingProjects([], []), []);
  assert.deepEqual(keepMissingProjects([{ id: 'a' }], []), [{ id: 'a' }]);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/save_config.test.ts` (module not found).
- [ ] **Step 3: Implement `keepMissingProjects`** in `save_config.ts`.
- [ ] **Step 4: Wire it into the web `saveConfig` handler.** After `validateProjectIds`, set `msg.config.projects = keepMissingProjects(prev.projects || [], msg.config.projects || [])`. Delete the "still has N task(s)" loop (now unreachable) and its comment; replace with a comment saying deletion goes only through `DELETE /api/projects/:id` and why (a stale form copy must not delete a project created over REST). Keep the repository-URL validation as is. Do **not** touch `packages/vscode-extension/src/sidebar.ts`.
- [ ] **Step 5: Update the comment in `packages/webview-ui/src/ProjectsTabSettings.tsx` `deleteProject`** — it cites the referential guard that no longer exists; say instead that a config save cannot delete a project.
- [ ] **Step 6: `CLAUDE.md`** — in "State on disk" item 1, where it explains that the settings form saves `caretaker.json` whole from a stale copy, add one sentence: the web server's `saveConfig` keeps any project present on disk and absent from the payload; project deletion goes only through `DELETE /api/projects/:id`.
- [ ] **Step 7: Verify** — the test passes; `pnpm -F @hyperwindmill/caretaker-cli test` passes; typecheck clean.
- [ ] **Step 8: Commit** — `fix(web): a settings save no longer deletes projects missing from its copy`

---

### Task 2: `createApp()` split out of `startServer`

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts` (lines ~233–890)
- Create: `packages/cli/src/cli/web/server.test.ts`

**Interfaces:**
- Produces: `export function createApp(apiListener: ApiListenerOptions): Hono` — registers every HTTP route `startServer` registers today (everything from `new Hono()` down to the line before `const nodeServer = serve(`) and returns the app. `startServer` builds `apiListener`, calls `createApp(apiListener)`, then does what follows `serve(` unchanged.

- [ ] **Step 1: Write the failing test** (`server.test.ts`, `CARETAKER_HOME` = fresh `mkdtempSync` at file scope)

```ts
test('createApp serves the project routes without binding a port', async () => {
  const app = createApp({ webPort: 0, host: '127.0.0.1' });
  const res = await app.request('/api/projects');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Run it, expect FAIL** (`createApp` is not exported).
- [ ] **Step 3: Move the function boundary.** The routes stay in `server.ts`, textually unchanged (`openapi.test.ts` greps this file for `app.get('/api/…'`). If a route closes over a value created after `serve()`, pass it in rather than moving the route; if importing `server.ts` in the test triggers a side effect at module load (a listener, a timer), move that side effect into `startServer`.
- [ ] **Step 4: Verify** — new test passes and the process exits on its own (no open handle); `openapi.test.ts` passes; full CLI test suite and typecheck pass.
- [ ] **Step 5: Commit** — `refactor(web): build the Hono app in createApp so tests can drive the real routes` (no changeset: no behaviour change).

---

### Task 3: Vertical settings navigation on the wide layout

**Files:**
- Create: `packages/webview-ui/src/settings_tabs.ts`, `packages/webview-ui/src/settings_tabs.test.ts`
- Modify: `packages/webview-ui/src/SettingsPanel.tsx` (the `<nav>` block, lines ~196–276; `TabId`), `packages/webview-ui/src/styles.css` (near `.settings-panel__tabs`, line ~1672)
- Modify: `.changeset/<new>.md` (patch)

**Interfaces:**
- Produces: `type TabId` (moved here, re-exported from `SettingsPanel.tsx` so `App.tsx` keeps compiling) and `settingsTabs(layout: 'compact' | 'sidebar'): { id: TabId; label: string }[]`.

- [ ] **Step 1: Write the failing test**

```ts
test('compact shows the four surface-independent tabs', () => {
  assert.deepEqual(settingsTabs('compact').map((t) => t.id), ['providers', 'agents', 'plugins', 'mcp']);
});
test('sidebar shows every tab in order', () => {
  assert.deepEqual(settingsTabs('sidebar').map((t) => t.id),
    ['providers', 'projects', 'agents', 'plugins', 'mcp', 'services', 'voice', 'memory', 'desktop', 'api']);
});
```

- [ ] **Step 2: Run it, expect FAIL.** `pnpm -F webview-ui exec tsx --test packages/webview-ui/src/settings_tabs.test.ts`
- [ ] **Step 3: Implement `settings_tabs.ts`** — labels exactly as the buttons read today.
- [ ] **Step 4: Replace the ten hand-written buttons** with one `settingsTabs(layout).map(...)`. Keep the existing class names; add the modifier class `settings-panel--vertical` on the root when `layout === 'sidebar'`.
- [ ] **Step 5: CSS.** Under `.settings-panel--vertical`: the root becomes a two-column grid (header spanning both, nav on the **left**, content on the right); `.settings-panel__tabs` becomes a column (`flex-direction: column`, right border instead of bottom border, fixed width ~160px, own vertical scroll); `.settings-panel__tab-btn` is left-aligned, `flex: none`, padding `8px 12px`, font-size 12px. The compact layout's rules stay untouched. Check `.app--settings-centered .settings-panel` (line ~1574): if it caps the panel width, raise the cap so the content column keeps the width it had.
- [ ] **Step 6: Verify** — test passes; `pnpm -F webview-ui build` clean. Then look at it: `CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev web`, open Settings, click through all ten tabs (each renders, the active one is highlighted, long tab content scrolls without moving the nav). The VSCode sidebar layout cannot be checked from here: say so in the task report rather than claiming it.
- [ ] **Step 7: Commit** — `feat(web): vertical settings navigation on the wide layout`

---

### Task 4: Protocol core — route allowlist, stores, pure logic

**Files:**
- Modify: `packages/cli/src/cli/web/openapi.ts`, `packages/cli/src/cli/web/openapi.test.ts`
- Create: `packages/cli/src/store/orchestrator.ts`, `packages/cli/src/store/orchestrator.test.ts`
- Create: `packages/cli/src/cli/web/orchestrator_core.ts`, `packages/cli/src/cli/web/orchestrator_core.test.ts`

**Interfaces — produces:**

```ts
// openapi.ts
/** True when method + pathname is an operation of `paths` ({param} = exactly one
 *  non-empty segment), or GET /api/openapi.json. Pathname only: no query. */
export function isDocumentedRoute(method: string, pathname: string): boolean;

// store/orchestrator.ts
export type OrchestratorPolicy = 'auto' | 'approve';
export interface OrchestratorConfig {
  enabled: boolean; name: string; endpoint: string;
  token: string;            // encrypted blob, '' when none
  pollSeconds: number; policy: OrchestratorPolicy; instanceId: string;
}
export interface LedgerRecord {
  id: string; method: string; path: string;
  body?: string;            // encrypt(JSON.stringify(body)); removed when state becomes 'done'
  receivedAt: string;
  state: 'pending' | 'applying' | 'done';
  result?: { status: number; body?: string };  // body encrypted the same way; removed on delivery
  resolvedAt?: string; delivered: boolean;
}
export function orchestratorPath(): string;        // <dataDir>/orchestrator.json
export function orchestratorLedgerPath(): string;  // <dataDir>/orchestrator-ledger.json
/** Defaults: disabled, '', '', '', 15, 'approve'. Generates and persists instanceId
 *  (randomUUID) when missing. Always returns a fresh object. */
export async function loadOrchestrator(): Promise<OrchestratorConfig>;
/** Encrypts `token` when it is not already an encrypted blob. */
export async function saveOrchestrator(c: OrchestratorConfig): Promise<void>;
/** Unreadable or non-array file → []. Malformed records are dropped. */
export async function loadLedger(): Promise<LedgerRecord[]>;
export async function saveLedger(records: LedgerRecord[]): Promise<void>;

// orchestrator_core.ts
export const PROTOCOL_VERSION = 1;
export const MAX_BODY_BYTES = 1_048_576;
export const LEDGER_SIZE = 500;
export interface RemoteMessage { id: string; method: string; path: string; body?: unknown }
export function validateEndpoint(endpoint: string): string | null;  // error text, or null when valid
export function clampPollSeconds(value: unknown): number;
/** `${endpoint without trailing slashes}/${call}` */
export function endpointUrl(endpoint: string, call: 'health' | 'register' | 'poll'): string;
/** null: no usable id (drop, not ledgered). `{id, error}`: ledger a 400 result.
 *  Otherwise the message with `path` rewritten to its NORMALIZED pathname + query. */
export function parseMessage(raw: unknown): RemoteMessage | { id: string; error: string } | null;
export function needsApproval(policy: OrchestratorPolicy, method: string): boolean;
/** Boot recovery: every 'applying' record becomes 'done' with result
 *  { status: 500 } and body encrypt('{"error":"Interrupted by a restart; outcome unknown."}'),
 *  request body removed. */
export function recoverLedger(records: LedgerRecord[], now: Date): LedgerRecord[];
/** Keeps every record that is not (done && delivered); then the newest done+delivered
 *  ones until the total is LEDGER_SIZE. Order preserved (oldest first). */
export function trimLedger(records: LedgerRecord[]): LedgerRecord[];
export interface ConfigInput { enabled: boolean; name: string; endpoint: string; token?: string; pollSeconds: unknown; policy: unknown }
/** Applies the save rules. `token`: clear text; blank/absent = keep the stored one,
 *  unless the endpoint's host changed (sameHost from voice_proxy.ts), then it is dropped.
 *  `purgeLedger` is true exactly when the host changed. `error` set → nothing to save. */
export function mergeConfigSave(saved: OrchestratorConfig, input: ConfigInput):
  { config: OrchestratorConfig; purgeLedger: boolean } | { error: string };
export interface MessageSummary {
  id: string; method: string; path: string; receivedAt: string;
  state: LedgerRecord['state']; status?: number; resolvedAt?: string; delivered: boolean;
  body?: unknown;  // pending records only; any `repositoryToken` key (at any depth) replaced by '••••'
}
export function summarizeLedger(records: LedgerRecord[]): MessageSummary[];  // newest first
```

`mergeConfigSave` returns the token in **clear** inside `config.token` when a new one was typed (`saveOrchestrator` encrypts it) and the stored blob otherwise. `policy` not in the union → `'approve'`. `validateEndpoint` runs only on a non-empty endpoint; an empty endpoint is saved as is.

- [ ] **Step 1: Failing tests for `isDocumentedRoute`** (append to `openapi.test.ts`)

```ts
test('isDocumentedRoute matches documented operations only', () => {
  assert.equal(isDocumentedRoute('GET', '/api/projects'), true);
  assert.equal(isDocumentedRoute('post', '/api/projects/acme/tasks'), true);
  assert.equal(isDocumentedRoute('GET', '/api/openapi.json'), true);
  assert.equal(isDocumentedRoute('PUT', '/api/projects'), false);           // method not documented
  assert.equal(isDocumentedRoute('GET', '/api/projects/a/b/tasks'), false); // {id} is one segment
  assert.equal(isDocumentedRoute('GET', '/api/projects//tasks'), false);
  assert.equal(isDocumentedRoute('GET', '/api/fs/list'), false);
  assert.equal(isDocumentedRoute('GET', '/api/orchestrator'), false);
  assert.equal(isDocumentedRoute('POST', '/api/access/tokens'), false);
  assert.equal(isDocumentedRoute('GET', '/api/docs'), false);
});
```

- [ ] **Step 2: Failing tests for the core** (`orchestrator_core.test.ts`)

```ts
test('validateEndpoint: https anywhere, http only on loopback', () => {
  assert.equal(validateEndpoint('https://orch.example.com/v1'), null);
  for (const ok of ['http://127.0.0.1:4000', 'http://localhost:4000/x', 'http://[::1]:4000']) assert.equal(validateEndpoint(ok), null);
  for (const bad of ['http://orch.example.com', 'ftp://x', 'not a url', 'https://user:pw@orch.example.com'])
    assert.equal(typeof validateEndpoint(bad), 'string');
});
test('endpointUrl keeps a path prefix and survives trailing slashes', () => {      // Review Focus 4
  assert.equal(endpointUrl('https://h/v1/', 'register'), 'https://h/v1/register');
  assert.equal(endpointUrl('https://h', 'poll'), 'https://h/poll');
  assert.equal(endpointUrl('https://h/v1///', 'health'), 'https://h/v1/health');
});
test('clampPollSeconds', () => {
  assert.equal(clampPollSeconds(undefined), 15); assert.equal(clampPollSeconds('abc'), 15);
  assert.equal(clampPollSeconds(1), 5); assert.equal(clampPollSeconds(99999), 3600); assert.equal(clampPollSeconds('30'), 30);
});
test('parseMessage normalizes the path and refuses what it cannot answer', () => {  // Review Focus 1
  assert.deepEqual(parseMessage({ id: 'm1', method: 'get', path: '/api/projects?x=1' }), { id: 'm1', method: 'GET', path: '/api/projects?x=1' });
  assert.equal((parseMessage({ id: 'm2', method: 'GET', path: '/api/projects/../orchestrator' }) as any).path, '/api/orchestrator');
  assert.equal((parseMessage({ id: 'm3', method: 'GET', path: '/api/projects/%2e%2e/access' }) as any).path, '/api/access');
  for (const path of ['//evil.example/api/projects', 'https://evil.example/api/projects', 'api/projects', '', 42])
    assert.ok('error' in (parseMessage({ id: 'm4', method: 'GET', path }) as any));
  assert.ok('error' in (parseMessage({ id: 'm5', method: 'TRACE', path: '/api/projects' }) as any));
  for (const raw of [null, 'x', {}, { id: '' }, { id: 7, method: 'GET', path: '/api/projects' }]) assert.equal(parseMessage(raw), null);
});
test('needsApproval', () => {
  assert.equal(needsApproval('auto', 'POST'), false);
  assert.equal(needsApproval('approve', 'GET'), false);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(needsApproval('approve', m), true);
});
test('recoverLedger settles an interrupted apply as 500 and never as pending', () => { /* one applying record → done, status 500, no body, resolvedAt set; pending and done records untouched */ });
test('trimLedger never drops pending, applying or undelivered records', () => { /* 600 done+delivered + 3 pending + 2 done-undelivered → 500 total, the 5 all present, the kept delivered ones are the newest */ });
test('mergeConfigSave: blank token keeps the stored one on the same host', () => { /* saved https://h/v1 + blob; input https://h/v2, token '' → config.token === blob, purgeLedger false */ });
test('mergeConfigSave: a host change drops the stored token and purges the ledger', () => { /* input https://other/v1, token '' → token '', purgeLedger true */ });
test('mergeConfigSave: a typed token is taken as is; bad endpoint is an error; instanceId never changes', () => {});
test('summarizeLedger: newest first, body only for pending, repositoryToken masked at any depth', () => {});
```

The four commented tests are specified by their comment; write the assertions accordingly. Use `encrypt`/`decrypt` from `lib/encryption.ts` with `CARETAKER_HOME` set at file scope.

- [ ] **Step 3: Failing tests for the store** (`store/orchestrator.test.ts`, own temp `CARETAKER_HOME` at file scope): first `loadOrchestrator()` returns the defaults with a UUID `instanceId` and a second call returns the **same** id; two loads return different object references; `saveOrchestrator` with a clear token writes a file where the token is not present in clear and `decrypt(loaded.token)` gives it back; `loadLedger()` on a missing file and on a file containing `{"not":"an array"}` returns `[]`; a round-trip of two records.
- [ ] **Step 4: Run all three files, expect FAIL.**
- [ ] **Step 5: Implement** `isDocumentedRoute`, `store/orchestrator.ts`, `orchestrator_core.ts`. `parseMessage` normalizes with `new URL(path, 'http://x')` and requires the path to start with a single `/` and the resulting origin to be `http://x`. `validateEndpoint` also refuses userinfo in the URL.
- [ ] **Step 6: Verify** — the three test files pass; full CLI suite and typecheck pass.
- [ ] **Step 7: Commit** — `feat(orchestration): protocol core, route allowlist and state files` (no changeset yet: nothing user-visible; Task 5 carries it).

---

### Task 5: The client — apply, cycle, loop, management routes

**Files:**
- Create: `packages/cli/src/cli/web/orchestrator.ts`, `packages/cli/src/cli/web/orchestrator.test.ts`
- Modify: `packages/cli/src/cli/web/api_access.ts` (`isApiPath`), `packages/cli/src/cli/web/api_access.test.ts`
- Modify: `packages/cli/src/cli/web/server.ts` (`createApp` registers the routes; `startServer` starts the loop next to `startBackgroundScheduler()`)
- Modify: `.changeset/<new>.md` (minor: "Remote orchestration: …")

**Interfaces:**
- Consumes: everything Task 4 produces; `createApp` (Task 2); `sameHost` (`voice_proxy.ts`); `bearerToken` is not needed here.
- Produces:

```ts
type AppLike = { request(path: string, init?: RequestInit): Response | Promise<Response> };
export interface CycleDeps { app: AppLike; fetch: typeof fetch; now?: () => Date }
export interface OrchestratorStatus {
  state: 'off' | 'registering' | 'connected' | 'error';
  orchestratorName?: string; lastPollAt?: string; lastError?: string;
}
/** One request against the app. Never throws. Refuses (404) when the normalized
 *  pathname is not isDocumentedRoute. Body over MAX_BODY_BYTES → 413. */
export async function applyMessage(app: AppLike, msg: RemoteMessage): Promise<{ status: number; body: unknown }>;
/** One register-if-needed + poll. Never throws; failures land in the status. */
export async function runCycle(deps: CycleDeps): Promise<void>;
export async function resolvePending(app: AppLike, id: string, decision: 'approve' | 'reject'):
  Promise<'ok' | 'not_found' | 'not_pending'>;
export function orchestratorStatus(): OrchestratorStatus;
/** Test hook and config-save hook: forget registration and status. */
export function resetOrchestrator(): void;
/** (Re)starts the loop from the saved config; safe to call repeatedly. Runs
 *  recoverLedger once per process before the first cycle. */
export function startOrchestrator(app: AppLike, fetchImpl?: typeof fetch): void;
export function stopOrchestrator(): void;
export function registerOrchestrator(app: Hono): void;
```

**Behaviour the tests pin (all values from the spec):**

- Outbound calls: `Authorization: Bearer <decrypted token>`, `content-type: application/json`, `AbortSignal.timeout(30_000)`.
- Cycle: disabled → state `off`, no call. Enabled with blank endpoint or token → `error`, "Endpoint and token are required.", no call. Not registered → `register` (state `registering` until it answers `2xx` with JSON `{ ok: true }`; `orchestratorName` from `name`). Then `poll` with every `done && !delivered` result (bodies decrypted). Poll `2xx` with an object whose `messages` is an array → mark those results delivered and delete their bodies, process messages in order, state `connected`, `lastPollAt` set. Poll `401/403/404/409` → unregistered, state `error`. Any other failure (network, timeout, non-JSON, `messages` missing or not an array) → state `error` with a one-line `lastError`, registration kept, results stay undelivered.
- Per message: `parseMessage` null → dropped, `lastError` = "The orchestrator sent a message without an id." (state stays `connected`). Id already in the ledger → ignored. Parse error → `done` record with a `400` result. Not documented → `done` record with a `404` result, the app never called. `needsApproval` → `pending` record. Otherwise: write `applying`, `applyMessage`, write `done` (request body removed, result body encrypted).
- `resolvePending` approve → same apply path, immediately. Reject → `done`, `403`, `{ "error": "Rejected by the user." }`.
- All ledger read-modify-write sequences go through one in-module promise-chain mutex, and `trimLedger` runs on every save.
- Routes (shapes per the spec): `GET /api/orchestrator` → `{ config: { enabled, name, endpoint, hasToken, pollSeconds, policy, instanceId }, status, pending, messages: MessageSummary[] }`; `PUT /api/orchestrator` (`ConfigInput`) → `400 { error }` on a `mergeConfigSave` error, otherwise save, purge the ledger when told, `resetOrchestrator()`, `startOrchestrator(app)`, same body as GET; `POST /api/orchestrator/test` (`{ endpoint, token? }`) → always `200` with `{ ok, name?, protocol?, error? }`: validates the endpoint, picks the typed token or the stored one under the same-host rule, calls `health`, and reports a `protocol` other than `1` as `ok: false` naming both versions; `POST /api/orchestrator/messages/:id/approve|reject` → `{ ok: true }`, `404`, or `409`.

- [ ] **Step 1: Write the failing tests** (`orchestrator.test.ts`; `CARETAKER_HOME` at file scope; each test starts with `resetOrchestrator()`, a fresh `saveLedger([])` and a `saveOrchestrator` of the config it needs). Use a stub `app` that records calls and a scripted `fetch` that records requests and returns queued `Response`s — no sockets.

```ts
test('disabled: no outbound call, state off');
test('enabled without endpoint or token: state error, no outbound call');                 // Review Focus 5
test('registers once, then polls; the orchestrator name reaches the status');
test('auto policy: a POST is applied and its result rides the next poll, then is not resent');
test('a re-offered message id is applied once');
test('approve policy: GET applied at once, POST held as pending; approve applies it; reject yields 403');
test('switching approve → auto leaves what is already pending in the inbox; only new messages auto-apply');
test('approving twice concurrently applies once and the second answers not_pending');     // Review Focus 3
test('an undocumented or path-tricked message gets 404 and the app is never called');     // Review Focus 1
test('a message without id is dropped and reported in lastError');
test('poll 401 drops the registration; the next cycle registers again');
test('a 200 HTML body, and messages not being an array, set lastError and apply nothing; the next cycle still runs'); // Review Focus 2
test('fetch rejecting (network down) sets state error and keeps results undelivered');
test('applyMessage: over-cap response → 413; JSON parsed, non-JSON returned as text; an app that throws → 500');
test('recovery: a ledger left with an applying record yields a 500 result and no second apply');
```

Route tests in the same file, against a real `new Hono()` with `registerOrchestrator(app)`:

```ts
test('GET never returns the token; hasToken reflects it');
test('PUT rejects http on a non-loopback host with 400');
test('PUT with a changed host and no token clears the token and the ledger');
test('test connection: reports the orchestrator name; protocol 2 is a failure; never calls register');
test('approve/reject: 404 unknown id, 409 not pending');
```

For the route tests that make outbound calls, `registerOrchestrator` needs the fetch injected: give it a second optional parameter `fetchImpl: typeof fetch = fetch`.

And in `api_access.test.ts`:

```ts
test('the orchestrator management routes stay off the API port', () => {
  assert.equal(isApiPath('/api/orchestrator'), false);
  assert.equal(isApiPath('/api/orchestrator/messages/x/approve'), false);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `orchestrator.ts`**, add `'/api/orchestrator'` to the `isApiPath` list, call `registerOrchestrator(app)` in `createApp`, and `startOrchestrator(app)` in `startServer` right after `startBackgroundScheduler()`. The loop is a `setTimeout` re-armed after each cycle finishes with the current `pollSeconds` (re-read each cycle), so cycles never overlap. Loop errors are caught and logged with a `[orchestrator]` prefix; nothing in this module may throw into `startServer`.
- [ ] **Step 4: Verify** — both test files pass; full CLI suite and typecheck pass; the test process exits on its own (no timer left armed: `stopOrchestrator()` in an `after` hook where a test started the loop).
- [ ] **Step 5: Commit** — `feat(orchestration): client loop, approval policy and management routes`

---

### Task 6: Demo orchestrator and end-to-end tests

**Files:**
- Create: `packages/cli/src/cli/orchestrator_demo.ts`, `packages/cli/src/cli/web/orchestrator.e2e.test.ts`
- Modify: `packages/cli/src/cli/index.ts` (new subcommand, next to `web`)
- Modify: `.changeset/<new>.md` (patch, or extend Task 5's file)

**Interfaces:**
- Consumes: `createApp` (Task 2), `runCycle`, `resolvePending`, `orchestratorStatus`, `resetOrchestrator` (Task 5), `saveOrchestrator` (Task 4).
- Produces:

```ts
export interface DemoOrchestrator {
  app: Hono;
  enqueue(instanceId: string, msg: { method: string; path: string; body?: unknown }): string; // returns the message id
  results(instanceId: string): { id: string; status: number; body: unknown }[];
  instances(): { instanceId: string; name: string; version: string; lastSeenAt: string }[];
}
export function createDemoOrchestrator(opts: { token: string; name?: string }): DemoOrchestrator;
export function startDemoOrchestrator(opts: { port: number; host: string; token: string; name?: string }): void;
```

Demo behaviour: every route requires the bearer token (`401` otherwise). `GET /health` → `{ ok: true, protocol: 1, name }` (default name `Demo Orchestrator`). `POST /register` upserts by `instanceId`. `POST /poll`: unknown `instanceId` → `409`; stores each result once (by id) and stops offering that message; answers every message still without a result. Admin: `GET /instances`, `POST /instances/:id/messages` → `{ id }`, `GET /instances/:id/results`. All state in memory.

Subcommand: `caretaker-cli orchestrator-demo --token <t> [--port 4000] [--host 127.0.0.1] [--name <n>]`; `--token` is required; on start it prints the endpoint URL and one example `curl` for enqueueing a message.

- [ ] **Step 1: Write the failing e2e tests** (`CARETAKER_HOME` at file scope; `const app = createApp({ webPort: 0, host: '127.0.0.1' })`; `const demo = createDemoOrchestrator({ token: 't', name: 'Demo' })`; `const deps = { app, fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch }`; the saved endpoint is `http://127.0.0.1:4000`). Read the request shapes for creating a project and a task from `openapi.ts`.

```ts
test('register, then create a project and a task end to end', async () => {
  // policy auto. cycle → demo.instances() has our instanceId and name.
  // enqueue POST /api/projects, cycle, cycle → result 200.
  // enqueue POST /api/projects/<id>/tasks, cycle, cycle → result 200 with body.task.id.
  // GET /api/projects/<id>/tasks straight on `app` lists that task.
});
test('a message the orchestrator keeps offering is applied once', async () => {
  // approve policy keeps it pending: three cycles, then approve, then one task exists, not three.
});
test('approve policy: nothing is created before the click; reject comes back as 403', async () => {});
test('a disallowed path comes back 404 and leaves no trace', async () => {
  // enqueue GET /api/fs/list?path=/ and POST /api/projects/../access/tokens → both 404 in demo.results
});
test('a wrong token leaves the status in error and the app healthy', async () => {
  // saved token 'wrong' → state error; app.request('/api/projects') still 200
});
test('test connection returns the demo name and registers nothing', async () => {
  // fresh demo; POST /api/orchestrator/test → { ok: true, name: 'Demo', protocol: 1 }; demo.instances() is empty
});
```

The last test needs the app's management route to use the in-process fetch: build that app with `registerOrchestrator`'s `fetchImpl` — add an optional second parameter `fetchImpl?: typeof fetch` to `createApp` that it forwards, defaulting to the global.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the demo and the subcommand.**
- [ ] **Step 4: Verify** — e2e file passes; full suite and typecheck pass. Then by hand, two terminals: `pnpm -F @hyperwindmill/caretaker-cli dev orchestrator-demo --token t` and `CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev web`; `curl -X PUT localhost:3000/api/orchestrator` with the demo endpoint, policy `auto`; enqueue `GET /api/projects` with the printed `curl`; within two poll intervals `GET /instances/<id>/results` shows a `200`. Report the actual output.
- [ ] **Step 5: Commit** — `feat(orchestration): demo orchestrator and end-to-end tests`

---

### Task 7: Orchestration settings tab and pending badge

**Files:**
- Create: `packages/webview-ui/src/OrchestrationTab.tsx`
- Modify: `packages/webview-ui/src/settings_tabs.ts` + its test, `packages/webview-ui/src/SettingsPanel.tsx`, `packages/webview-ui/src/App.tsx`, `packages/webview-ui/src/styles.css`
- Modify: `.changeset/<new>.md` (patch, or extend Task 5's file)

**Interfaces:**
- Consumes: the `/api/orchestrator` routes (Task 5), `settingsTabs` (Task 3).
- Produces: tab id `'orchestration'`, label `Orchestration`, last in the `sidebar` list, absent from `compact`. `SettingsPanel` gains the optional prop `orchestrationPending?: number`.

- [ ] **Step 1: Update the tab-list test** — `sidebar` ends with `'orchestration'`; `compact` unchanged. Run, expect FAIL, then add the entry.
- [ ] **Step 2: Build `OrchestrationTab`** following `ApiAccessTab.tsx` (plain `fetch`, one `call` helper, local form state seeded from the first GET, an error line). Layout and copy per the spec's sketch:
  - status line: `Off` / `Registering…` / `Connected to "<orchestratorName>" · last poll <relative>` / `Error: <lastError>`;
  - fields: Enabled, Instance name, Endpoint, Token (password input, placeholder `Leave blank to keep the saved token` when `hasToken`), Poll every N seconds, Policy as two radios — `Ask me before applying changes` (`approve`) and `Apply automatically` (`auto`);
  - under the `auto` radio, a one-line warning: `The orchestrator can create projects and start tasks on this machine without asking.`;
  - `Test connection` posts the **unsaved** endpoint and token and shows `✓ Reached "<name>" (protocol <n>)` or the error; `Save` PUTs;
  - `Waiting for approval (n)`: one row per pending message — method, path, a `<details>` with the pretty-printed body, Approve, Reject;
  - `Activity`: the non-pending summaries, newest first — time, method, path, status (`403` shown as `403 rejected`).
  - Refresh the GET every 5 s while mounted (clear the interval on unmount); a refresh must not overwrite fields the user is editing (seed the form once, refresh only status and messages).
- [ ] **Step 3: Badge.** In `App.tsx`, when `layout === 'sidebar'`, poll `GET /api/orchestrator` every 15 s and keep `pending` in state (fetch failure → 0, silently). Show the count as a small badge on the nav rail's Settings item and pass it to `SettingsPanel` → badge on the Orchestration nav entry. `ponytail:` comment: polls the whole status for one number; move to a ws push if the payload grows. The count must not break `MessageList` memoization: do not thread it through props of the chat tree.
- [ ] **Step 4: Verify** — `pnpm -F webview-ui test` and `build` clean. Then by hand with the demo orchestrator from Task 6: Test connection shows the demo's name; save with policy `approve`; enqueue a `POST /api/projects`; the badge shows 1 on Settings and on Orchestration; Approve → the project appears in Projects and the row moves to Activity with `200`; enqueue another and Reject → `403 rejected`; stop the demo → status turns to `Error` within one interval and the rest of the GUI keeps working. Report what was actually observed.
- [ ] **Step 5: Commit** — `feat(web): Orchestration settings tab with approval inbox`

---

### Task 8: Documentation

**Files:**
- Create: `docs/orchestration-protocol.md`
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: `docs/orchestration-protocol.md`** — written for someone implementing an orchestrator who has never seen caretaker: the three calls with request/response examples, the at-least-once rule and what it obliges the orchestrator to do, the result-status table, which routes a message may target (point at `/api/openapi.json`, obtainable through the channel itself), and the demo orchestrator as reference implementation. Content comes from the spec's "Protocol v1" section; no caretaker internals.
- [ ] **Step 2: `CLAUDE.md`** — a new architecture layer "10. Remote orchestration" in the style of layer 9 (the rule the design hangs on, the files, the ledger invariants, the policy, the management routes, the demo, the web-server-only limit and the two-servers-one-home limit). Also: `orchestrator.json` and `orchestrator-ledger.json` in "State on disk" item 1; `/api/orchestrator` in layer 9's `isApiPath` exclusion sentence; `orchestrator-demo` in the subcommand list of layer 1; `createApp` where layer 1 describes `server.ts`; the vertical settings nav where the settings tabs' `layout === 'sidebar'` gate is described.
- [ ] **Step 3: `README.md`** — a user-facing section: what it is for, how to configure it, the two policies, the trust statement from the spec (in `auto` the orchestrator token means code execution on this machine), and a five-line walkthrough with `caretaker-cli orchestrator-demo`.
- [ ] **Step 4: Verify** — every file, function, route and flag named in the three documents exists (`grep` each); `pnpm -F @hyperwindmill/caretaker-cli test` still passes (`openapi.test.ts` reads sources).
- [ ] **Step 5: Commit** — `docs: remote orchestration protocol, architecture and user guide`
