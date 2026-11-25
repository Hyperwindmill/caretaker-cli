# Orchestration: early poll while results wait — design

Date: 2026-11-25

## Problem

The orchestration client (`packages/cli/src/cli/web/orchestrator.ts`) polls every
`pollSeconds` (default 15 s). A result rides the `results` array of the *next* poll,
so every call an orchestrator makes costs one to two intervals: offered at poll N,
applied, delivered at poll N+1. Measured against a real orchestrator at 15 s, a chain
of three or four dependent calls took about two minutes, and a "pause this task"
command arrived after the task had finished.

## Decision

`pollSeconds` becomes the **longest** wait between two polls, not the only one.
When a cycle succeeds and the ledger still holds an undelivered result
(`state === 'done' && !delivered && result`), the next cycle starts after a fixed
floor `EARLY_POLL_MS` (250 ms) instead of `pollSeconds`. The orchestrator can answer
the poll that carries a result with the next message of the chain, so a chain runs
at the speed of the calls.

Rules:

- **Trigger = undelivered results only.** A `pending` record (approve policy) has no
  result and never triggers it; a cycle with nothing to deliver waits `pollSeconds`.
- **Success required.** `runCycle` now resolves to `true` only when the `/poll`
  round-trip succeeded (2xx and a valid `messages` array). Any failure (network,
  non-2xx, rejected registration, missing endpoint/token, an exception while
  applying) → normal interval, even with results waiting. No retry storm against a
  broken orchestrator.
- **No busy loop.** The floor is fixed; the loop is still one `setTimeout` chain.
  An orchestrator that keeps sending messages gets polled at the floor plus the
  time to apply them — that is the intended "speed of the calls".
- **Approve/reject wakes the loop.** `resolvePending` produces a result outside the
  loop; on `'ok'` it calls the internal `pollSoon()`:
  - sets `wakeRequested = true`;
  - if a timer is pending (`loopTimer !== null`), replaces it with one firing after
    `EARLY_POLL_MS`.
  If a cycle is running (no timer), only the flag is set and the tick reads it when
  it schedules the next cycle. `tick` clears `loopTimer` and `wakeRequested` when it
  starts, and reads `wakeRequested` **synchronously right before** `setTimeout`, after
  its last `await`, so a wake landing during the ledger check is never lost.
  Clearing `loopTimer` at tick start is what keeps a wake from starting a second
  tick chain while a cycle runs.
- **Unchanged guarantees.** Cycles stay serialized through `cycleChain`; a config save
  still retires the loop (`stopOrchestrator` bumps `loopGen` and now also clears the
  wake hook, so a wake after stop schedules nothing); boot recovery is untouched;
  delivery stays at-least-once with dedupe by id.
- **Wire protocol unchanged** (still version 1). An orchestrator already had to accept
  a poll at any time.

## Rejected

- Long polling / WebSocket: transport change, out of scope.
- Delivering the result in a dedicated call right after applying: a new endpoint,
  i.e. a protocol change.
- Polling again after every successful cycle: polls an idle orchestrator at the
  floor forever.

## Reference orchestrator

`createDemoOrchestrator` gains an optional `onResult(instanceId, result)` callback,
invoked inside `/poll` for each newly recorded result *before* the response's
`messages` are computed. It shows the intended orchestrator pattern (answer a result
with the next message in the same response) and drives the chain e2e test. No new
admin route.
