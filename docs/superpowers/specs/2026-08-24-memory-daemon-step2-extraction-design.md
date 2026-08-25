# Memory Daemon — Step 2 (memory extraction)

Date: 2026-08-24
Status: approved design
Prior work: `2026-08-24-memory-daemon-step1-design.md` (session digests — the
sweep this step extends) and `2026-08-23-memory-subsystem-design.md` on
`idea/memory` (the full-subsystem destination; its extraction concept is
implemented here on the pull model, with the scope and type revisions below).

## Goal

The sweep's per-chunk model call today produces only a rolling summary. This
step makes the same call also evaluate the chunk for durable memories — using
the summary as context, so the model understands what it reads — and persists
them as `Memory` records. **Write path only**: no read path, no prelude
injection, no `memory_read`, no consolidation. Those remain later steps.

## Two scope levels, no agent scope

A memory is either **project** (`projectId` set) or **global** (user/machine
level, `projectId = ''`). The model classifies only the *level*; the host
supplies and validates the id.

Revision against the 2026-08-23 spec, which had an agent scope: nothing binds
to an agent anymore. Three reasons, recorded because this reverses an approved
design:

1. The boundary is fuzzy exactly where misclassification is most expensive.
   Write-time misfiled memories are never re-filed. Almost every durable fact
   is about the user, the machine, or the project; what is truly "who the
   agent is" lives in the systemPrompt, which the user authors.
2. The original spec already betrayed the problem: it needed an
   `agent ∪ project` union at read time because the three task roles are
   three different agents on one task. A scope that needs a union to work is
   the signal that the useful level was the other one.
3. Nothing is lost for later: provenance records `sourceAgentId` host-side for
   free (it is the session directory, a fact — not a model classification).
   A future personality step can mine it and introduce a real agent scope
   with its own read design. Adding a level later is trivial; emptying a
   wrong category is not.

"Base"/personality memories are deferred to that future step.

## Classification: `kind` + `importance`

Revision against the 2026-08-23 spec's five-value `type`
(`decision | convention | preference | constraint | episode`): four of those
are the same normative content at different strengths, and the boundaries
between them are exactly the kind of fuzzy that misleads a write-time
classifier. The two axes are separated instead, both crisp:

```ts
kind: 'fact' | 'episode';          // timeless knowledge vs a dated event
importance: 'low' | 'normal' | 'high';
```

- `kind` is the classic semantic/episodic distinction: a durable fact ("this
  repo uses pnpm", "never rewrite a commit") vs a thing that happened ("we
  debugged X on the 24th; the cause was Y").
- `importance` is **explicitly derived from the tone of the conversation**,
  captured at write time because the tone lives in the transcript and is
  unrecoverable later (consolidation will only ever see the extracted body).
  Anchored semantics in the instruction, never left to model taste:
  - `high` — the user marked it explicitly ("remember this", "never again"),
    emphatic/frustrated tone, or a correction of a mistake that was made;
  - `normal` — ordinary facts and decisions (the default);
  - `low` — incidental, contextual, plausibly ephemeral.
- Ordinal enum, deliberately not numeric: models calibrate 1–10 scales
  poorly (everything lands 7–8).

For the future dynamics: `importance` is the *initial* strength (the prior
for decay/promotion), while recall accounting will be the *acquired*
strength. Both sources were in the original design; each now has a clean
home. Promotion-by-type loses nothing: the consolidation model reads the body
anyway and can judge normative force there.

## Data model

New collection `memories` in the folder DB (`store/db.ts`, SessionDigest
pattern). Unlike the digests this is **not a regenerable cache** — it is the
first durable store of the memory subsystem. (Deleting the digests collection
remains safe; memories survive it.)

```ts
interface Memory {
  id: string;            // crypto.randomUUID() — passes safeId
  projectId: string;     // '' = global
  kind: 'fact' | 'episode';
  importance: 'low' | 'normal' | 'high';
  title: string;
  body: string;          // markdown
  keywords: string[];    // associative base for the future read path,
                         // emitted at write time (2026-08-23 rationale)
  // ─── provenance — host-side facts, never model output ───────────────
  sourceSessionId: string;
  sourceAgentId: string; // the session's agent directory
  model: string;         // extraction model
  createdAt: string;
}
```

Accessors: `saveMemory`, `listMemories` (optionally by projectId),
`deleteMemory` — same interpolation-safety rules as the digest accessors
(ids through `safeId`, records through `JSON.stringify`).

## The combined call

The existing per-chunk call (`memory_sweep.ts`) changes shape; the call count,
cursor mechanics, and budget (`MAX_CALLS_PER_SWEEP`) are untouched.

- **Input**: previous summary, new messages (formatted as today), plus a
  **dedup block**: titles + keywords of the existing memories in scope
  (global + the resolved project), most recent first, under a char cap
  (`MAX_DEDUP_CHARS`, ~4000). Instruction: emit only new or changed facts.
- **Output**: JSON — `{"summary": "...", "memories": [...]}` with each entry
  `{level, kind, importance, title, body, keywords}` where
  `level: 'project' | 'global'`. When no project is resolved for the session,
  the prompt offers only `global`.
- **Defensive parsing**: strip code fences, extract the outermost JSON
  object. **Unparsable output = failed chunk** — cursor stays, next sweep
  retries, same contract as a network failure today. Deliberately no
  "treat the raw text as the summary" fallback: it would poison the digest
  with JSON fragments. A model that cannot produce JSON is unfit for the
  memory-agent role, and the warn log makes that visible.
- **Entry validation, host-side**: entries missing `title` or `body` are
  dropped; invalid `kind`/`importance` coerce to `fact`/`normal`; `level:
  'project'` without a resolved project degrades to global. Caps: at most
  `MAX_MEMORIES_PER_CALL` (5) entries per call, title/body/keywords
  truncated (`MAX_MEMORY_TITLE_CHARS` ~200, `MAX_MEMORY_BODY_CHARS` ~2000,
  10 keywords).
- **Persistence order**: memories first, digest record after. A crash
  between the two re-extracts the chunk next sweep, but the just-saved
  titles are then in the dedup block, so the model omits them — duplicates
  with a dedup guard beat silent loss.

Append-only: extraction never updates or supersedes an existing memory.
Merge/supersede/decay are consolidation's job (later step).

## Project resolution

Host-side, from run context (2026-08-23 rule: scope ids are never chosen by
a model): the session's agent `workingDir` is prefix-matched (path-aware)
against `config.projects[].workingDir`. Empty agent `workingDir` or no match
→ no project in scope, global-only extraction for that session. Resolved once
per session per sweep.

## Config

No new flag. `MemoryConfig` present = sweep **and** extraction on. The user
who wants memory has already chosen the agent and accepted the calls; a
separate extraction toggle is speculative.

## Testing

Co-located `*.test.ts`, Node runner via tsx, `CARETAKER_HOME` mutated at file
scope. Pure functions first:

- Prompt assembly: dedup block content, char cap, global-only variant.
- Response parsing: fenced/unfenced JSON, unparsable → null, entry
  validation (drops, coercions, caps, project→global degradation).
- Project resolution: prefix match, empty workingDir, no match.
- Sweep integration with a fake combined call: memories persisted before the
  digest record, failed parse leaves the cursor, budget interaction
  unchanged.
- DB accessors round-trip.

## Out of scope (later steps)

The read path (prelude block, lexical association, digestion),
`memory_read` + recall accounting, consolidation/decay, pin/veto, the Memory
tab's memory browser UI, the Claude Code Stop-hook capture, agent-scoped
personality memories.

## Documentation and versioning

- `CLAUDE.md`: extend the memory-sweep bullet (layer 5) and the folder-DB
  section (Memories collection) in the same unit of work.
- Changeset: **minor** (new user-facing behaviour; no new public types in
  `caretaker-types` — `MemoryConfig` is unchanged).
