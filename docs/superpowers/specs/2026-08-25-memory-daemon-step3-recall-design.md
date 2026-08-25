# Memory Daemon — Step 3 (recall / read path)

Date: 2026-08-25
Status: approved design
Prior work: `2026-08-24-memory-daemon-step1-design.md` (session digests),
`2026-08-24-memory-daemon-step2-extraction-design.md` (the `memories`
collection this step reads), and `2026-08-23-memory-subsystem-design.md` on
`idea/memory` (the original full-subsystem read path — **deviated prior art**:
its tiers/areas/core-index do not exist in the implemented model; this step is
designed against the flat `Memory` record of step 2).

## Goal

Memories written by the sweep become readable by agents: a host-side lexical
match on the current user message injects the top-K memory *titles* into the
prelude, and a new `mcp__memory__memory_read` tool returns bodies on demand —
each read being a recall event that increments the memory's acquired strength.
**No model in the read loop**: matching is programmatic, synchronous, free.
The memory agent's role in reading (query analysis, candidate verification —
the "digestion" of the 2026-08-23 design) is deferred to a future opt-in step.

## Matching — lexical, host-side, inverted

New pure module `harness/memory_recall.ts`.

- **Candidates**: global memories (`projectId = ''`) + those of the resolved
  project. Project resolution reuses step 2's helper (path-aware prefix match
  of the agent's `workingDir` against `config.projects[].workingDir`) — read
  and write resolve scope symmetrically.
- **Match is inverted — no query tokenization.** For each stored keyword
  (lowercased, trimmed, length ≥ 3): does the lowercased user message
  `.includes(keyword)`? Multi-word keywords ("memory sweep") work for free;
  no stopwords, no stemming. O(memories × keywords) — negligible at this
  scale, and the storage/lookup shape stays trivially portable to sqlite
  later (explicitly non-blocking).
- **Score** (constants at the top of the module, tunable):

  ```
  score = matchedKeywords
        × importanceWeight   (low 0.5 / normal 1 / high 2)
        × (1 + log2(1 + recallCount))
  ```

  Acquired strength weighs in by design: a much-recalled memory surfaces more
  easily (the human-like dynamic from the 2026-08-23 design, kept). Ordering:
  score desc; tie-break `lastRecalledAt` desc, then `createdAt` desc.
- **Selection**: top-K = 5 (constant), only entries with score > 0. No match
  → no block.

## Prelude block

A `<memories>` block appended after the runtime-info block (before the voice
block when present) — per-turn content because it depends on the current user
message, fixed position in the stable order. Native loop: appended in `run()`
(`harness/loop.ts`, same pattern as the voice block); claude-code: joins the
`--append-system-prompt` parts (`claude_code_runner.ts`).

Content: one instruction line, then one line per candidate —
`- <id> — <title> (kind, importance)` — and the hint to call
`memory_read(ids)` for the bodies **if the tool is available**. Titles only,
never bodies: the explicit fetch *is* the recall event; a system that always
injects everything never learns what mattered.

## Tool: `mcp__memory__memory_read`

New builtin namespace `mcp__memory__`, served by `buildBuiltinMcpServer` —
one definition source, both producers (HTTP task bridge + `caretaker-cli mcp`
stdio server) pick it up through the existing prefix filter; no new
allowlists (the `mcp__<ns>__*` wildcard is already generic in
`resolveAgentTools` and all three pickers).

- **Input**: `ids: string[]` (explicit ids → context-free, valid on stdio).
- **Output**: per id — title, body, kind, importance, projectId, createdAt.
  Unknown ids are skipped and reported, not errors.
- **Recall accounting**: for each *delivered* id, `recallCount + 1` and
  `lastRecalledAt = now`. This counter is also the evidence base for the
  future consolidation of base memories — stored on the record, never
  recomputed.
- Read-only with respect to memory content → no planner deny needed
  (unlike `email_send`).

### Reachability matrix

| Run kind | How the tool arrives |
|---|---|
| Native agent, any surface | opt-in from the tool picker (`allowedTools`) |
| claude-code task run | HTTP bridge, injected automatically |
| claude-code ordinary chat | the user's own `caretaker-cli mcp` stdio server in `~/.claude` (one-time `caretaker-cli config claude`), merged when `strictMcp` is off (default) — same path `mcp__task__*` already takes |

An agent that can't reach the tool still gets the titles — signal without
expansion. That is a setup gap, not a design gap: no body-inline fallback (it
would break recall accounting and is undetectable on the claude-code side).

The stdio path bumps `recallCount` from a separate process against the same
folder DB — the same pattern already accepted for the task tools over stdio;
no new constraint.

## Schema

On `Memory` (`store/db.ts`): `recallCount?: number`, `lastRecalledAt?: string`
— optional, absent on existing records (= 0 / never), no migration. New
accessor `bumpMemoryRecall(id)` (delete + insert, `saveSessionDigest`
pattern; id through `safeId`).

## Gating and surfaces

No new flag: `MemoryConfig` present = read path on (the user who configured
memory already accepted its behaviour). Unlike the sweep (web-server-only),
recall works on **every** surface — the folder DB is local and no scheduler
is needed. Unset config, or zero candidates: zero cost, no block.

## Testing

Co-located `*.test.ts`, Node runner via tsx, `CARETAKER_HOME` mutated at file
scope. Pure functions first:

- Matcher: inverted match (multi-word keywords, min length, case), scoring
  (importance weights, recallCount factor), ordering and tie-breaks, top-K
  cut, score-0 exclusion.
- Block assembly: content shape, empty-match → no block, position.
- Tool: bodies returned, unknown ids skipped, recall bump round-trip.
- `bumpMemoryRecall`: increments, sets `lastRecalledAt`, absent fields treated
  as 0, invalid id no-op.

## Out of scope (later steps)

The memory agent in the read path (digestion / candidate verification), a
`memory_search` on-demand tool, consolidation/decay, pin/veto, the Memory
tab's memory browser UI, embeddings/sqlite migration.

## Documentation and versioning

- `CLAUDE.md`: layer 2 (third served namespace `mcp__memory__`), layer 3
  (prelude order gains the `<memories>` block), layer 5 memory bullet
  (read path), folder-DB section (recall fields) — same unit of work.
- Changeset: **minor** (new user-facing behaviour; no `caretaker-types`
  changes).
