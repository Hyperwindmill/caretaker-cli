# Memory Daemon — Step 1 (session digests)

Date: 2026-08-24
Status: approved design
Prior work: `2026-08-23-memory-subsystem-design.md` on the `idea/memory` branch.
This step **revises** that spec's trigger model: extraction there was post-turn
fire-and-forget (push); here the write path becomes a periodic pull — a daemon
that sweeps conversations against a per-session cursor. The rest of that
design (tiers, association, digestion, consolidation) is unchanged as a
destination but out of scope for this step.

## Goal

The smallest self-contained piece of the memory subsystem: a daemon in the
primary process that periodically walks all chat sessions and maintains, per
session, (a) a cursor identifying the last message it has processed and (b) a
rolling summary it produces itself — each pass integrating the new material
into the previous summary or rewriting it. No `Memory` records, no extraction,
no read path yet: the digest is groundwork the later steps consume.

Why pull instead of the previous spec's push: the sweep reads shared on-disk
state, so sessions written by any surface (TUI, VSCode, web, desktop) are
picked up by whichever process runs the daemon — no per-surface trigger
wiring, no behaviour difference between surfaces.

## Placement

The sweep is a fourth loop in the existing background scheduler
(`cli/web/scheduler.ts`), so it runs where the other three run: the web server
and, transitively, the desktop app. TUI/VSCode-only setups get no sweeps until
a web-server process is up — consistent with the house rule that scheduled
work needs one. A future `caretaker-cli daemon` subcommand (systemd/winsvc
install) would just be a new caller of `startBackgroundScheduler()`; nothing
in this design changes for it. It would inherit the scheduler's existing
single-process constraint: the anti-overlap guard is in-process, so two
scheduler processes would double-sweep (a problem for that future step, not
this one).

## Config

`memory?: MemoryConfig` in `caretaker.json`, new type in `caretaker-types`
(voice-config pattern):

```ts
interface MemoryConfig {
  providerId: string;     // references a configured provider by id
  model: string;
  sweepMinutes?: number;  // default 5 — min interval between sweeps
  minNewMessages?: number;// default 4 — per-session debounce threshold
}
```

- Unset (or missing `providerId`/`model`) = subsystem off, zero cost, the
  sweep tick returns immediately.
- A `claude-code`-type provider is rejected (logged once, treated as off):
  there is no HTTP endpoint for a fresh call — same constraint as titling
  (`harness/title.ts`).
- No settings UI in this step; the config is hand-edited. The UI arrives with
  the Memory tab increment.

## Data model

New collection in the folder DB (`store/db.ts`, same pattern as
Project/Task), deliberately on `@morphql/store` to keep it SQL-like from day
one; migration to SQLite happens when measured friction demands it (see
Testing — the benchmark exists to measure exactly that).

```ts
interface SessionDigest {
  id: string;            // = sessionId
  agentId: string;
  lastMessageId: string; // cursor: last processed MessageRecord.id
  messageCount: number;  // messages processed so far (O(1) "how many new?")
  summary: string;       // rolling summary, standalone text
  model: string;         // model that produced the current summary
  updatedAt: string;
}
```

The whole collection is a **regenerable cache**, never a source of truth:
deleting it costs one full re-scan, nothing else. That is also the SQLite
migration story — drop and re-scan, no data migration code.

`messageCount` is redundant with the cursor id on purpose: it makes the
new-message check a length comparison without locating the id, and it
survives an id that is no longer found (see Sweep).

## Sweep loop

`runMemorySweepTick(now)` in `cli/web/scheduler/memory_sweep.ts` (strategies
depend on sibling modules, never on the parent `scheduler.ts`), called from
`runSchedulerTick` alongside the three existing loops. Internally gated:

- **Interval gate**: does work at most once per `sweepMinutes`; other ticks
  return immediately.
- **Overlap gate**: an in-flight flag — a sweep that outlives the 15 s tick is
  never joined by a second one.

Per sweep:

1. Enumerate sessions from disk: `sessions/<agentId>/*.jsonl` for every agent
   directory. This covers sessions written by every surface.
2. For each session, replay the JSONL (`readSession`) and locate the cursor:
   the index of `lastMessageId` in the message list (append-only file → the
   scan is safe). Cursor id not found (or no digest record) = start from
   message zero.
3. Sessions with `newMessages >= minNewMessages` are candidates; the rest are
   skipped until they accumulate enough.
4. **Chunking**: new messages go to the model in chunks under a per-call
   character budget. Each call is `(previous summary, chunk) → new summary`,
   and the digest record — cursor included — is persisted after **each**
   successful call. Crash-safe by construction: a crash mid-backlog loses at
   most one chunk's work, and a huge pre-existing session converges over
   several sweeps.
5. **Global budget**: at most N model calls per sweep (constant, ~10). When
   the budget runs out, remaining sessions wait for the next sweep and the
   skip is logged — bounded cost per sweep, no silent truncation.

A session being written mid-sweep is a non-issue: the JSONL is append-only,
so a partial read is a consistent prefix and the cursor simply lags one
sweep.

## Summarize call

One-shot, non-streaming, on the OpenAI-compatible client (`title.ts`
pattern) with the configured memory provider/model:

- **Input**: the previous summary (or "none") plus the new messages,
  role-labelled. Thinking parts dropped; tool results hard-truncated (they
  are the largest strings in a session and carry the least durable meaning).
- **Instruction**: integrate the new material into the previous summary and
  rewrite it as a standalone text — the model decides whether that is an
  incremental edit or a replacement. Target length instructed; a host-side
  hard truncation backstops it.
- **Output**: plain text. No JSON envelope in this step — there is exactly
  one field.
- **Failure**: log, skip the session, leave the cursor where it was; the next
  sweep retries. Memory is best-effort and never blocks anything, same
  contract as titling.

## Testing

Co-located `*.test.ts`, Node runner via tsx, `CARETAKER_HOME` mutated at
**file scope** (never per-describe):

- Cursor logic as pure functions: locate-by-id, id-not-found restart,
  threshold gating.
- Chunking: character-budget partitioning, cursor advance per chunk.
- Sweep behaviour with a fake summarize call: interval gate, overlap gate,
  global call budget, per-session failure isolation.
- Prompt assembly: role labelling, thinking dropped, tool-result truncation.
- **morphql benchmark**: a test that writes/reads/updates a few hundred
  `SessionDigest` records against a temp store and logs timings — the
  measured baseline that decides when the SQLite switch is worth it.

## Out of scope (later steps)

Everything else in the 2026-08-23 spec: `Memory` records and extraction,
lexical association, digestion into the prelude, `memory_read`,
consolidation/tiers/areas, the Memory tab UI, the Claude Code Stop-hook
capture, and the `caretaker-cli daemon` service installer.

## Documentation and versioning

- `CLAUDE.md`: document the fourth scheduler loop and the config key in the
  same unit of work.
- Changeset: **minor** (new public type `MemoryConfig` in `caretaker-types`).
