# Orchestration early poll — implementation plan

> **For agentic workers:** use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** after a successful cycle that leaves undelivered results, or after a GUI
approve/reject, the next orchestration poll starts after a 250 ms floor instead of
`pollSeconds`.

**Spec:** `docs/superpowers/specs/2026-11-25-orchestration-early-poll-design.md` — read it first.

**Files:** `packages/cli/src/cli/web/orchestrator_core.ts` (+test),
`packages/cli/src/cli/web/orchestrator.ts` (+`orchestrator.test.ts`),
`packages/cli/src/cli/orchestrator_demo.ts`, `packages/cli/src/cli/web/orchestrator.e2e.test.ts`,
`docs/orchestration-protocol.md`, `README.md`, `CLAUDE.md`, `.changeset/`.

## Constraints

- English everywhere. No new dependencies. No wire-protocol change (`PROTOCOL_VERSION` stays 1).
- Tests: Node test runner via tsx; `CARETAKER_HOME` already set at file scope in both test files — keep it so.
- `pnpm test` does not type-check: run `pnpm -F @hyperwindmill/caretaker-cli typecheck` before each commit.
- One commit per task, never amend/rebase. Commit trailer: the executing model's `Co-Authored-By` line.
- Every loop test must `stopOrchestrator()` before it ends (the `beforeEach` does too), or a pending timer keeps the process alive.

## Task 1 — core predicate

- [ ] In `orchestrator_core.ts` export
  ```ts
  /** A result recorded and not yet acknowledged by a 2xx /poll. */
  export function isUndeliveredResult(r: LedgerRecord): boolean {
    return r.state === 'done' && !r.delivered && r.result !== undefined;
  }
  ```
  (import the `LedgerRecord` type from `../../store/orchestrator.js` if the file does not already).
- [ ] In `orchestrator.ts` `cycleOnce`, replace the inline filter
  `r.state === 'done' && !r.delivered && r.result` with `isUndeliveredResult(r)` (keep the `r.result!` accesses in the `map`).
- [ ] `orchestrator_core.test.ts`: one test — `done`+undelivered+result → true; `pending`, `applying`, `done`+delivered → false.

## Task 2 — cycle outcome + early poll + wake (`orchestrator.ts`)

- [ ] `export const EARLY_POLL_MS = 250;` next to `OUTBOUND_TIMEOUT_MS`, with a one-line comment: floor between two cycles while results wait; `pollSeconds` is the maximum.
- [ ] `runCycle(deps): Promise<boolean>` — resolves `true` only when the `/poll` round-trip succeeded. Change `cycleChain = run.catch(() => undefined)` to `cycleChain = run.then(() => undefined, () => undefined)` (typing).
- [ ] `cycleOnce(deps): Promise<boolean>`: every early `return` becomes `return false` (disabled, missing endpoint/token, register failures, poll rejected/failed/non-JSON/bad shape, every `stale()` return, the `catch`). The function ends with `return true` after the message loop. Update the JSDoc of `runCycle` ("Never throws; failures land in status. Resolves true when the poll round-trip succeeded.").
- [ ] Module state next to `loopTimer`:
  ```ts
  /** The running loop's tick, for pollSoon(); null when no loop runs. */
  let loopTick: (() => void) | null = null;
  /** A result was produced outside the loop (approve/reject) while a cycle ran. */
  let wakeRequested = false;
  ```
- [ ] Helper:
  ```ts
  async function hasUndeliveredResults(): Promise<boolean> {
    return withLedgerLock(async () => (await loadLedger()).some(isUndeliveredResult));
  }

  /** Brings the next poll forward to EARLY_POLL_MS. A cycle in flight reads the flag when it reschedules. */
  function pollSoon(): void {
    wakeRequested = true;
    if (loopTimer !== null && loopTick !== null) {
      clearTimeout(loopTimer);
      loopTimer = setTimeout(loopTick, EARLY_POLL_MS);
    }
  }
  ```
- [ ] `stopOrchestrator()`: also `loopTick = null; wakeRequested = false;`.
- [ ] `startOrchestrator` tick, rewritten:
  ```ts
  const tick = async () => {
    if (gen !== loopGen) return;
    loopTimer = null;        // a wake during this cycle must not start a second chain
    wakeRequested = false;   // this cycle delivers whatever already exists
    let ok = false;
    try {
      await ensureRecovered(new Date());
      ok = await runCycle({ app, fetch: fetchImpl });
    } catch (err) {
      console.error('[orchestrator]', err);
    }
    if (gen !== loopGen) return;

    let delayMs = 15_000;
    let waiting = false;
    try {
      const cfg = await loadOrchestrator();
      if (!cfg.enabled) return;
      delayMs = cfg.pollSeconds * 1000;
      if (ok) waiting = await hasUndeliveredResults();
    } catch (err) {
      console.error('[orchestrator]', err);
    }
    if (gen !== loopGen) return;
    // No await below this line: a wake landing during the checks above is read here.
    if (ok && (waiting || wakeRequested)) delayMs = EARLY_POLL_MS;
    loopTimer = setTimeout(() => void tick(), delayMs);
  };
  loopTick = () => void tick();
  void tick();
  ```
  Note the disabled branch (`if (!cfg.enabled) return;`) leaves `loopTimer` null, so a later wake is a no-op — correct, nothing is polling.
- [ ] `resolvePending`: call `pollSoon()` right before both `return { status: 'ok' }`-equivalent exits — after the reject `saveLedger` (inside the lock callback it is fine to call it after the lock returns: restructure as `if (step.status === 'ok') { pollSoon(); return 'ok'; }` after the first `withLedgerLock`), and after the final ledger write of the approve path, before `return 'ok'`.

## Task 3 — unit tests (`orchestrator.test.ts`)

Use `startOrchestrator(app, fetchImpl)` with `seedConfig({ pollSeconds: 3600 })`, so anything that is not an early poll never happens during the test. Helper: `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));`. Count `/poll` requests from the fetch stub. Each test calls `stopOrchestrator()` at the end.

- [ ] **early poll delivers at once:** policy `auto`; fetch stub: `/register` → `{ok:true}`; 1st `/poll` → one GET message (`/api/projects`); later polls → `{messages: []}`. After `sleep(EARLY_POLL_MS * 4)`: exactly 2 polls, the 2nd carries the result in `results`; after another `sleep(EARLY_POLL_MS * 4)` still 2 (nothing left to deliver → back to `pollSeconds`).
- [ ] **pending alone never triggers it:** policy `approve`; 1st poll → one POST message; after `sleep(EARLY_POLL_MS * 4)`: 1 poll, ledger record `pending`.
- [ ] **failed cycle falls back to the interval:** seed the ledger with one `done`, undelivered record carrying a result (`saveLedger([...])`, body encrypted like existing tests do — or reuse the shape already used in the "fetch rejecting" test); `/poll` throws `new Error('down')` (also try: returns 500). After `sleep(EARLY_POLL_MS * 4)`: 1 poll attempt, status `error`, record still undelivered.
- [ ] **approve/reject brings the poll forward:** policy `approve`; 1st poll → one POST message; `sleep(EARLY_POLL_MS * 2)` (1 poll, timer now 3600 s); `await resolvePending(app, id, 'approve')`; `sleep(EARLY_POLL_MS * 4)`: 2 polls, the 2nd carries the result. Same for `reject` (result status 403) — one test with two messages or a second test, executor's choice.
- [ ] **wake during a running cycle, no overlap:** policy `approve`; 1st poll → one POST message; 2nd poll (triggered by approving) is held on a gate promise; while held, track in-flight `/poll` count (`inFlight++` on entry, `--` on exit, record `maxInFlight`). Approve a second pending message (send two POSTs on the 1st poll; approve the first to trigger poll 2, approve the second while poll 2 is held) → only the flag is set. Release the gate; after `sleep(EARLY_POLL_MS * 4)`: a 3rd poll happened carrying the second result, and `maxInFlight === 1`.
- [ ] **stop retires the loop even with results waiting:** policy `auto`; every poll returns a fresh GET message (new id each time), so the loop would run at the floor forever. `sleep(EARLY_POLL_MS * 3)`, call `stopOrchestrator(); resetOrchestrator();` (what `PUT /api/orchestrator` does before saving), record the poll count, `sleep(EARLY_POLL_MS * 4)`: count unchanged. Then append one `pending` record to the ledger, `resolvePending(app, id, 'reject')`, `sleep(EARLY_POLL_MS * 4)`: count still unchanged (a wake after stop schedules nothing).
- [ ] **runCycle return value:** extend two existing tests (one success, one failure, e.g. "registers once, then polls" and "fetch rejecting") with `assert.equal(await runCycle(...), true/false)`.

## Task 4 — demo hook + chain e2e

- [ ] `orchestrator_demo.ts`: `createDemoOrchestrator(opts: { token: string; name?: string; onResult?: (instanceId: string, result: DemoResult) => void })`. In `/poll`, when a result is newly recorded (`!instResults.has(r.id)` branch), call `opts.onResult?.(instanceId, recorded)` after `set`, before `pending` is computed — so a message enqueued by the callback rides this very response.
- [ ] `orchestrator.e2e.test.ts`: new test **"a chain of dependent calls runs without waiting pollSeconds"**: `setupConfig('auto')` then set `pollSeconds = 3600` on the saved config; `const demo = createDemoOrchestrator({ token: 't', onResult: (inst) => { if (chain.length < 4) chain.push(demo.enqueue(inst, { method: 'GET', path: '/api/projects' })); } })` (declare `const chain: string[] = []` and the `demo` binding before use — the callback only runs later). Enqueue the first message, push its id, `startOrchestrator(app, deps.fetch)`; poll `demo.results(instanceId).length` every 50 ms up to a 5 s deadline until it is 4; `stopOrchestrator()`; assert 4 results, all status 200, ids equal to `chain`. With the old fixed interval this test fails by deadline. Import `startOrchestrator` in the e2e file.
- [ ] Run the full orchestrator suites: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/orchestrator*.test.ts`, then `typecheck`. Commit Tasks 1–4 together or separately (code + tests).

## Task 5 — docs + changeset

- [ ] `docs/orchestration-protocol.md`, in **3. Poll** after the bullet list, add a **Cadence** paragraph: the configured interval is the *longest* gap between two polls; after a successful poll that leaves Caretaker holding undelivered results (it applied messages, or a person approved/rejected one), Caretaker polls again after a short floor (~250 ms); a failed poll falls back to the interval. An orchestrator can therefore answer a poll that carried a result with the next message of a chain, and a chain proceeds at the speed of the calls. Orchestrators must accept a poll at any time (already true). Also mention it in the "Reference Implementation" section if the demo's `onResult` fits there (one line: the demo exposes `onResult` for in-process tests).
- [ ] `README.md` "Remote orchestration": after "a poll interval (5–3600 s, default 15 s)" add that it is the maximum wait — while Caretaker holds results not yet delivered it polls again at once, so a chain of commands does not wait an interval per step.
- [ ] `CLAUDE.md` layer 10: add a **Cadence** bullet: `runCycle` resolves `true` on a successful poll round-trip; the loop reschedules at `EARLY_POLL_MS` (250 ms) instead of `pollSeconds` when the cycle succeeded and the ledger holds an undelivered result (`isUndeliveredResult`) or `resolvePending` requested a wake (`pollSoon`: replaces a pending timer, else sets `wakeRequested`, read synchronously right before `setTimeout`); `pending` records never trigger it; a failed cycle always waits `pollSeconds`; `tick` nulls `loopTimer` on entry so a wake cannot start a second chain. Mention the demo's `onResult` hook in the "Demo & UI" bullet.
- [ ] `.changeset/orchestration-early-poll.md`:
  ```md
  ---
  "@hyperwindmill/caretaker-cli": minor
  ---

  Remote orchestration polls again at once while results are waiting to be delivered, and right after a message is approved or rejected, so a chain of dependent commands runs at the speed of the calls instead of one poll interval per step. The poll interval is now the longest wait between polls; the wire protocol is unchanged.
  ```
- [ ] Commit.

## Verification

- `pnpm -F @hyperwindmill/caretaker-cli test` and `typecheck` green.
- Manual (optional): `caretaker-cli orchestrator-demo --token t --port 4000` + `caretaker-cli web`, enqueue a GET; the result shows up in `GET /instances/<id>/results` within ~1 s of being applied instead of one interval later.
