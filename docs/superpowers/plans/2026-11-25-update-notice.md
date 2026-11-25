# Update Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell users a newer Caretaker release is published (web/desktop banner, TUI line), with a link to the release page and, when a global `caretaker-cli` on PATH is behind, a button that runs the npm update.

**Architecture:** One CLI-side module (`lib/update_check.ts`) reads GitHub's latest published release (cached), locates the PATH CLI's version on disk, and runs the npm update. A small Hono route file exposes it to the shared webview, which renders a banner in the sidebar layout. The TUI calls the same module directly.

**Tech Stack:** TypeScript ESM, Hono, React (webview-ui), Ink (TUI), `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-11-25-update-notice-design.md`

## Global Constraints

- Release source: `GET https://api.github.com/repos/Hyperwindmill/caretaker-cli/releases/latest`; `tag_name` `vX.Y.Z` → version, `html_url` → link. Headers `Accept: application/vnd.github+json`, `User-Agent: caretaker-cli` (generic, no user data).
- Fetch timeout 5 s. Cache: success 6 h, failure 15 min. Never throws, never logs on failure.
- Opt-out: `updateCheck: false` in `caretaker.json` → no network call, no PATH scan.
- Update command, verbatim: `npm i -g @hyperwindmill/caretaker-cli@latest` (argv `['i', '-g', '@hyperwindmill/caretaker-cli@latest']`), env `commandEnv()`, timeout 5 min, `shell: process.platform === 'win32'`, one run at a time (409).
- The PATH CLI is never executed — its version is read from its `package.json` (spec explains why).
- No agent tool mirrors any of this. No new dependency.
- Out of scope: VSCode sidebar (`layout !== 'sidebar'`), headless `run`, `mcp`.
- Every change ships a changeset (`.changeset/*.md`); CLAUDE.md and README updated in the last task.

## Review Focus

- Offline / GitHub 5xx / 403 rate limit / slow DNS → no banner, no error UI, TUI start not delayed. (Task 1 test `fetch failure → null`, Task 5 renders before the check resolves.)
- Pre-release or odd tags (`v0.38.0-beta.1`, `nightly`, missing `tag_name`) → treated as "no release", no banner. (Task 1 `isNewer` cases.)
- Local dev build ahead of the published release (current `0.38.0`, latest `0.37.0`) → no banner. (Task 1.)
- Dismiss `0.38.0`, then `0.39.0` is published → banner returns; dismissing never clears `lastProjectId` in `ui-state.json`. (Task 3 test.)
- npm missing (`ENOENT`) or `EACCES` → `{ ok: false, output }` with readable text, HTTP 200, never 500; a second click while running → 409. (Task 2 + Task 3 tests.)

---

### Task 1: Current version + latest release check

**Files:**
- Create: `packages/cli/src/lib/version.ts`
- Create: `packages/cli/src/lib/update_check.ts`
- Test: `packages/cli/src/lib/update_check.test.ts`
- Modify: `packages/cli/src/cli/index.ts:30-45` (use `cliVersion()` instead of the inline reader)
- Modify: `packages/types/src/index.ts` (`CaretakerConfig`: add `updateCheck?: boolean` with a one-line doc comment: "false disables the release check (no network call). Default on.")

**Interfaces:**
- Produces:
  - `cliVersion(): string` — `version.ts`; reads `new URL('../../package.json', import.meta.url)`, `'0.0.0'` on failure (move the existing comment + ponytail note from `cli/index.ts`).
  - `parseVersion(v: string): [number, number, number] | null` — accepts `X.Y.Z` with optional leading `v`, rejects anything else (pre-release suffix included).
  - `isNewer(latest: string, current: string): boolean` — false when either fails to parse.
  - `interface LatestRelease { version: string; url: string }` (version without `v`).
  - `getLatestRelease(opts?: { fetchImpl?: typeof fetch; now?: () => number }): Promise<LatestRelease | null>` — cached per Global Constraints.
  - `__resetUpdateCacheForTests(): void`.

- [ ] **Step 1: Write the failing tests** in `update_check.test.ts`:
  - `isNewer('0.38.0','0.37.0') === true`, `isNewer('v0.38.0','0.37.0') === true`, `isNewer('0.37.0','0.38.0') === false`, `isNewer('0.37.0','0.37.0') === false`, `isNewer('0.10.0','0.9.0') === true`, `isNewer('0.38.0-beta.1','0.37.0') === false`, `isNewer('nightly','0.37.0') === false`.
  - `getLatestRelease` with a stub fetch returning `{ tag_name: 'v0.38.0', html_url: 'https://github.com/x/releases/tag/v0.38.0' }` → `{ version: '0.38.0', url: … }`; the request URL equals the Global Constraints URL.
  - fetch that rejects → `null`; fetch answering 403 → `null`; body without `tag_name` → `null`.
  - caching: two calls within 6 h → stub called once; at `now + 6h + 1` → called again; after a failure, a call at `now + 15min + 1` refetches.
- [ ] **Step 2: Run** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/update_check.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `version.ts` and the functions above in `update_check.ts`; `AbortSignal.timeout(5000)` for the fetch. Swap `cli/index.ts` to `program.version(cliVersion(), …)`. Add `updateCheck` to the type; run `pnpm -F caretaker-types build`.
- [ ] **Step 4: Run** the test file → PASS; `pnpm -F @hyperwindmill/caretaker-cli typecheck` → clean; `pnpm -F @hyperwindmill/caretaker-cli dev --version` prints the package version.
- [ ] **Step 5: Commit** `feat(update): latest release check and shared version reader`.

### Task 2: PATH CLI version + npm update runner

**Files:**
- Modify: `packages/cli/src/lib/update_check.ts`
- Test: `packages/cli/src/lib/update_check.test.ts`

**Interfaces:**
- Consumes: `isNewer` (Task 1).
- Produces:
  - `findPathCliVersion(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<string | null>`
  - `runCliUpdate(opts?: { exec?: ExecLike }): Promise<{ ok: boolean; output: string }>` where `type ExecLike = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; timeout: number; shell: boolean; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>` (default: `promisify(execFile)`).
  - `UPDATE_COMMAND = 'npm i -g @hyperwindmill/caretaker-cli@latest'` (exported for UI/TUI copy text).

`findPathCliVersion` algorithm (the tests don't pin the order, so it is spelled out):
```
for dir of (env.PATH ?? '').split(path.delimiter) (skip empty):
  names = platform === 'win32' ? ['caretaker-cli.cmd', 'caretaker-cli'] : ['caretaker-cli']
  for name of names:
    bin = join(dir, name); if not exists → continue
    candidates = []
    try candidates.push(join(dirname(await realpath(bin)), '..', 'package.json'))   // npm/pnpm/nvm symlink → <pkg>/dist/index.js
    candidates.push(join(dir, 'node_modules', '@hyperwindmill', 'caretaker-cli', 'package.json')) // Windows npm shim layout
    for c of candidates: parse JSON; if name === '@hyperwindmill/caretaker-cli' → return version
    return null   // first PATH hit wins, like the shell
return null
```
Add `// ponytail: binary shims (volta) don't resolve to the package; no command shown for them.`

- [ ] **Step 1: Write the failing tests** (temp dirs under `os.tmpdir()`, created at file scope):
  - symlink layout: `bin/caretaker-cli` → `lib/node_modules/@hyperwindmill/caretaker-cli/dist/index.js`, package.json `{ name: '@hyperwindmill/caretaker-cli', version: '0.36.0' }` → `'0.36.0'`.
  - Windows layout with `platform: 'win32'`: `npm/caretaker-cli.cmd` (plain file) + `npm/node_modules/@hyperwindmill/caretaker-cli/package.json` → version.
  - first PATH hit wins: two dirs, first has 0.36.0, second 0.37.0 → `'0.36.0'`.
  - foreign package (`name: 'other'`) → `null`; empty PATH → `null`.
  - `runCliUpdate` with a stub exec resolving `{ stdout: 'added 1 package', stderr: '' }` → `{ ok: true, output }` containing `added 1 package`; stub called with `'npm'` and the exact argv from Global Constraints and `timeout: 300_000`.
  - stub exec rejecting with an error carrying `code: 'EACCES'`, `stderr: 'permission denied'` → `{ ok: false }`, output contains `permission denied`; rejecting with `code: 'ENOENT'` (no stderr) → `{ ok: false }`, output contains `npm not found`.
  - output longer than 4000 chars is cut to its last 4000.
- [ ] **Step 2: Run** the test file → new tests FAIL.
- [ ] **Step 3: Implement** both functions. `runCliUpdate` passes `env: commandEnv()`; output = tail 4000 of `stdout + stderr` (on failure use the error's `stdout`/`stderr`, else `err.message`; ENOENT → `'npm not found on PATH'`).
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(update): locate PATH CLI version and run npm update`.

### Task 3: Web routes

**Files:**
- Create: `packages/cli/src/cli/web/update_routes.ts`
- Test: `packages/cli/src/cli/web/update_routes.test.ts`
- Modify: `packages/cli/src/cli/web/server.ts:246-256` (`registerUpdate(app)` in `createApp`)
- Modify: `packages/cli/src/store/json.ts:136-138` (`UiState.dismissedUpdateVersion?: string`)

**Interfaces:**
- Consumes: `cliVersion`, `isNewer`, `getLatestRelease`, `findPathCliVersion`, `runCliUpdate` (Tasks 1–2); `loadConfig`, `loadUiState`, `saveUiState`; `commandEnv`.
- Produces (consumed by Task 4):
  ```ts
  export interface UpdateStatus {
    current: string;
    latest?: string; url?: string;          // absent when disabled or the check failed
    appOutdated: boolean;                   // latest newer than current
    cliVersion?: string;                    // PATH CLI, when found
    cliOutdated: boolean;                   // PATH CLI behind latest
    dismissedVersion?: string;
  }
  export interface CliUpdateResult { ok: boolean; output: string; cliVersion?: string; cliOutdated: boolean }
  export function registerUpdate(app: Hono, deps?: Partial<UpdateDeps>): void
  // UpdateDeps = { getLatest, findCli: () => Promise<string|null>, runUpdate, current: () => string }
  ```
  Routes: `GET /api/update` → `UpdateStatus`; `POST /api/update/dismiss` body `{ version: string }` → 204 (400 when not a non-empty string), sets `dismissedUpdateVersion`, keeps every other `ui-state.json` key; `POST /api/update/cli` → `CliUpdateResult` (200 even when `ok: false`), 409 `{ error: 'update already running' }` while one is in flight.
  `updateCheck === false` → `{ current, appOutdated: false, cliOutdated: false, dismissedVersion }` without calling `getLatest`/`findCli`.

- [ ] **Step 1: Write the failing tests** (file-scope `CARETAKER_HOME` temp dir, `new Hono()` + `registerUpdate(app, stubs)`, like `voice_builtin.test.ts`):
  - latest 0.38.0, current 0.37.0, CLI 0.36.0 → `appOutdated: true, cliOutdated: true, cliVersion: '0.36.0'`.
  - latest null → no `latest`, both flags false.
  - CLI not found → no `cliVersion`, `cliOutdated: false`.
  - config `{ updateCheck: false }` written to `caretaker.json` → stubs `getLatest`/`findCli` never called.
  - dismiss: pre-seed `ui-state.json` with `{ lastProjectId: 'p1' }`, POST `{ version: '0.38.0' }` → file has both keys; GET returns `dismissedVersion: '0.38.0'`; body `{}` → 400.
  - `POST /api/update/cli` with `runUpdate` stub `{ ok: false, output: 'EACCES' }` → 200 + same body; with a stub that awaits a gate, a second POST before release → 409.
- [ ] **Step 2: Run** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/update_routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** `update_routes.ts`; default deps use `findPathCliVersion(commandEnv())`. Register in `createApp`. After `runUpdate`, re-read `findCli()` for `cliVersion`/`cliOutdated` (latest from `getLatest()`).
- [ ] **Step 4: Run** the file → PASS; `pnpm -F @hyperwindmill/caretaker-cli test` → all green (openapi drift test must still pass: these routes are deliberately undocumented); typecheck clean.
- [ ] **Step 5: Commit** `feat(update): /api/update status, dismiss and CLI update routes`.

### Task 4: Webview banner

**Files:**
- Create: `packages/webview-ui/src/update_banner_utils.ts`
- Test: `packages/webview-ui/src/update_banner_utils.test.ts`
- Create: `packages/webview-ui/src/UpdateBanner.tsx`
- Modify: `packages/webview-ui/src/App.tsx:550-552` (render `<UpdateBanner />` as the first child of the `app--with-sidebar` root — sidebar layout only)
- Modify: `packages/webview-ui/src/styles.css` (banner styles, existing tokens; must not overlap the chat — it takes its own row)

**Interfaces:**
- Consumes: `UpdateStatus`, `CliUpdateResult` shapes (Task 3) — redeclare them locally in `update_banner_utils.ts` (webview-ui does not import cli internals), `UPDATE_COMMAND` text duplicated as a constant.
- Produces:
  - `shouldShowBanner(s: UpdateStatus | null): boolean` — `!!s?.latest && (s.appOutdated || s.cliOutdated) && s.dismissedVersion !== s.latest`.
  - `cliUpdateMessage(r: CliUpdateResult): { kind: 'done' | 'failed' | 'stale'; text: string }` — exact copy:
    - `ok && !cliOutdated` → `done`, `"CLI updated — restart open caretaker-cli sessions to use it."`
    - `!ok` → `failed`, `"Update failed. Run the command yourself (it may need admin rights):"` (UI shows `output` below in a `<pre>` and keeps Copy command)
    - `ok && cliOutdated` → `stale`, `` `npm finished, but the caretaker-cli on your PATH is still ${cliVersion ?? 'unknown'} (installed another way?).` ``

Banner copy (fixed): line 1 `⬆ Caretaker {latest} is available — you have {current}` (when only the CLI is behind: `you have {current}` stays, the CLI line explains); line 2, only when `cliOutdated`: `Terminal CLI {cliVersion}: npm i -g @hyperwindmill/caretaker-cli@latest`. Buttons: **Download** (`<a href={url} target="_blank" rel="noreferrer">`), **Update CLI** + **Copy command** (only when `cliOutdated`; Update shows a spinner/disabled while running; Copy uses `navigator.clipboard.writeText`, the command text is selectable anyway), **Dismiss** (POST `/api/update/dismiss` with `latest`, hide immediately). Fetch `/api/update` on mount and every hour; any fetch error → hidden.

- [ ] **Step 1: Write the failing tests** for both pure functions: not shown for `null`, for no `latest`, for both flags false, for `dismissedVersion === latest`; shown when dismissed is an older version; the three `cliUpdateMessage` kinds with their exact text.
- [ ] **Step 2: Run** `pnpm -F webview-ui exec tsx --test packages/webview-ui/src/update_banner_utils.test.ts` → FAIL.
- [ ] **Step 3: Implement** utils, component, App wiring, CSS.
- [ ] **Step 4: Run** `pnpm -F webview-ui test` → PASS; `pnpm -F webview-ui build` → OK. Manual check: make the default `getLatest` in `update_routes.ts` return `{ version: '99.0.0', url: 'https://github.com/Hyperwindmill/caretaker-cli/releases' }` as a throwaway edit, run `CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev web`, verify Download opens the page, Dismiss hides it and survives a reload, Copy fills the clipboard; then revert the edit (`git diff` must show no change in `update_routes.ts` before committing).
- [ ] **Step 5: Commit** `feat(webview): update banner`.

### Task 5: TUI line

**Files:**
- Modify: `packages/cli/src/tui/app.tsx` (state + effect + one `<Text>` under `<Logo />`)

**Interfaces:**
- Consumes: `cliVersion`, `isNewer`, `getLatestRelease`, `UPDATE_COMMAND` (Tasks 1–2), `loadConfig`.

- [ ] **Step 1: Implement**: a `useEffect` that, unless `config.updateCheck === false`, awaits `getLatestRelease()` and, when `isNewer(latest.version, cliVersion())`, sets the line `⬆ Caretaker {latest} available (you have {current}) — npm i -g @hyperwindmill/caretaker-cli@latest`, rendered `<Text color="yellow" dimColor>`. The menu renders immediately; the line appears when the promise resolves; errors are swallowed. (No unit test: the logic is Task 1's, the component is a conditional render.)
- [ ] **Step 2: Verify**: `pnpm -F @hyperwindmill/caretaker-cli typecheck` clean; `CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev` → menu appears at once, no line (current == latest or newer); with networking off → menu appears at once, no error.
- [ ] **Step 3: Commit** `feat(tui): update available line`.

### Task 6: Docs + changeset

**Files:**
- Modify: `CLAUDE.md` (layer 1 "Surfaces": one paragraph on the update notice — source, cache, `updateCheck`, the three routes, the on-disk PATH CLI lookup and why the binary is never executed, VSCode/run/mcp excluded; State on disk: `ui-state.json` also holds `dismissedUpdateVersion`)
- Modify: `README.md` (user-facing: what the banner/TUI line do, Update CLI may need admin rights with a system Node, `"updateCheck": false` to opt out)
- Create: `.changeset/update-notice.md` — `minor` for `@hyperwindmill/caretaker-cli`, `webview-ui`, `caretaker-types`: "Show a notice when a newer Caretaker release is published, with a download link and a one-click update for the terminal CLI."

- [ ] **Step 1:** Write the three files.
- [ ] **Step 2:** `pnpm build && pnpm test` → all green.
- [ ] **Step 3: Commit** `docs: update notice`.
