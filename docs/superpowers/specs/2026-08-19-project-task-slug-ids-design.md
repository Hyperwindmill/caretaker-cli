# Project and task slug ids

Date: 2026-08-19
Status: approved, not yet implemented

## Problem

Project and task ids are numeric and derived from the surviving set, so they
are **reused after deletion**:

- `POST /api/projects` computes `Math.max(...ids) + 1`
  ([server.ts:314](../../../packages/cli/src/cli/web/server.ts#L314)).
- Task ids come from `@morphql/store`'s `$auto`, whose `nextId()` is the same
  `Math.max(...) + 1` over the records still on disk
  (`@morphql/store@0.1.45`, `dist/index.js:437`).

Both ids are embedded in durable, out-of-band artifacts:

| artifact | shape | source |
|---|---|---|
| managed clone | `~/.caretaker/repos/<projectId>` | [task_git.ts:120](../../../packages/cli/src/lib/task_git.ts#L120) |
| worktree | `~/.caretaker/worktrees/<projectId>-<taskId>` | [task_git.ts:262](../../../packages/cli/src/lib/task_git.ts#L262) |
| container | `caretaker-task-<projectId>-<taskId>` | [docker.ts:12](../../../packages/cli/src/lib/docker.ts#L12) |
| built image | `caretaker-project-<projectId>:latest` | [task_strategy.ts:251](../../../packages/cli/src/cli/web/scheduler/task_strategy.ts#L251) |
| task branch | `caretaker/task-<taskId>-<title-slug>` | [task_git.ts:295](../../../packages/cli/src/lib/task_git.ts#L295) |

A reused id inherits the previous holder's artifacts. The project case is known
and defended by hand — `DELETE /api/projects/:id` deletes the managed clone
precisely because of it, and says so in a comment
([server.ts:355](../../../packages/cli/src/cli/web/server.ts#L355)). Every
deletion path is a hand-placed defence against the same root cause, and none of
them fixes it.

The trigger for fixing it now is the planned memory subsystem, which needs a
project identity that survives deletion: keyed on a reusable id, a new project
would silently inherit a deleted project's memories, and the symptom would be
strange behaviour rather than an error.

## Decision

Replace both numeric ids with **one** opaque string id each. No second
identifier, no dual identity.

- **`Project.id` is a slug** — user-settable at creation, charset-validated,
  unique, immutable.
- **`Task.id` is `<projectSlug>-<seq>`** — a composite built at creation from a
  per-project monotonic sequence.

Opaque uuids were considered and rejected for the same reason in both cases:
these ids are what a human reads when debugging git and docker state, and what
they type into a URL or say out loud ("task 17"). `caretaker-task-caretaker-cli-17`
beats `caretaker-task-3-17`, which in turn beats
`caretaker-task-9f1c…-a3f9…`. Human readability at the embedding sites is the
whole point; uuids buy collision-freedom that a per-project counter does not
need.

Opaque uuids are nonetheless the established pattern for ids that are **not**
embedded in human-facing names — agents
([sync.ts:40](../../../packages/cli/src/agents/sync.ts#L40)), sessions, checklist
items, services. Projects and tasks are the outliers here, not the innovation.

### The id is opaque — never parse it

`Task.projectId` remains the single source of truth for the relation. The
composite id denormalises that fact, and the failure mode is specific: a slug
contains hyphens, so `id.split('-')[0]` yields `'caretaker'` for
`caretaker-cli-17`, not the project. A comment on the type states the rule.
Verified: nothing in the codebase parses an id today (the three `split('-')`
call sites are cron ranges and a BCP-47 tag).

A reserved separator (`_`, excluded from the slug charset) would make an
accidental parse correct instead of silently wrong. It is rejected because it
costs the zero-rename property below, which is worth more.

## Slug rules

```
^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$
```

(1–39 chars, starts **and ends** alphanumeric. The trailing-alnum requirement is
not cosmetic: the docker image reference grammar —
`[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*` — requires every name component to end
alphanumeric, so a slug like `foo-` would make
`caretaker-project-foo-:latest` an invalid reference and break the Dockerfile
build path.)

One regex serves five constraints at once, which is why a slug works where a
uuid was unpleasant: docker container names, git ref names, filesystem path
components, and the folder DB's quoted-string parsing (no quote, no backslash,
so interpolating user input into a query stays safe).

The filesystem constraint is a trust boundary, not a convenience: the slug
becomes a path component under `~/.caretaker/`, and the charset is what makes
`..` and `/` unrepresentable. It is not optional and must not be relaxed.

Three checks, all host-side:

1. **Charset** — the regex above.
2. **Uniqueness** — against every existing project id, including numeric ids
   inherited from the migration.
3. **Immutability** — an existing project's id may not change. Renaming would
   mean moving worktrees, renaming containers and the managed clone; that is a
   separate feature with its own cleanup, and a `ponytail:` comment names it as
   the upgrade path.

Enforcement follows the `validateRepositoryUrl` precedent exactly
([lib/repo_url.ts](../../../packages/cli/src/lib/repo_url.ts)): a
`lib/project_slug.ts` module is the authority, the webview may hold its own copy
for form feedback only, and **every** write path into `caretaker.json` calls the
authoritative one. There are **three** such paths — the same three
`validateRepositoryUrl` already guards, which is why it is re-exported from the
`./store` entry point:

- `POST /api/projects` ([server.ts:301](../../../packages/cli/src/cli/web/server.ts#L301)).
  Note: no UI calls this route today — it is external API surface. The real
  creation path is the settings form, which goes through `saveConfig`.
- The web server's settings websocket `saveConfig` handler
  ([server.ts:1146](../../../packages/cli/src/cli/web/server.ts#L1146)).
- The VSCode sidebar's own `saveConfig` handler
  ([sidebar.ts:376](../../../packages/vscode-extension/src/sidebar.ts#L376)) —
  the extension imports the store directly and never passes through the web
  server.

Both `saveConfig` handlers receive the **whole** config from the client —
project ids included — so they are the paths that can change an existing
project's id, and the immutability check has to live in both. They already
iterate the project array to validate repository URLs; the slug checks join
that loop.

## Task sequence

`Task` gains a persisted `seq: number` field — the sequence is **stored, never
derived from the id**. Deriving it would mean parsing the composite id, which
the opacity rule above forbids; the field is what keeps that rule free of
exceptions. The migration pass seeds `seq` from the old numeric task id.

```ts
const seq = Math.max(project.nextTaskSeq ?? 0, ...tasksInProject.map(t => t.seq)) + 1;
```

`nextTaskSeq` is a high-water mark persisted on the project record. The counter
makes the sequence monotonic (no reuse after deletion); the `max` over existing
tasks' `seq` fields makes it self-healing if the counter is lost or the record
is hand-edited; the `?? 0` seeds it on existing installs, so there is nothing to
migrate.

A second reason the self-heal earns its place: `nextTaskSeq` lives on the
project record in `caretaker.json`, and both `saveConfig` handlers overwrite
that file wholesale from a client-held snapshot — a settings form opened before
a task was created and saved after silently rolls the counter back. The `max`
term heals every such rollback except the case where the highest task was also
deleted in between; that residue is accepted (same class as the unlocked
counter ceiling below).

`createTask` stops using `$auto` and inserts an explicit id. That removes the
post-insert retrieval hack
([db.ts:141](../../../packages/cli/src/store/db.ts#L141)), which today re-reads
every task and matches on `projectId + title + objective` — and therefore
returns the **wrong** (older) task when a title and objective are reused inside
one project. The bug goes away as a side effect of knowing the id before the
insert; it is not a separate fix.

`TaskMessage.id` stays numeric and keeps `$auto`. It is never embedded in a name
and never read by a human.

**Ceiling, to be marked in code:** the read-modify-write on `nextTaskSeq` is not
locked, so two processes against the same `CARETAKER_HOME` (the web server and a
`caretaker-cli mcp` stdio server) could compute the same sequence. The `max` term
limits the damage to a genuine race (or the snapshot rollback above), and the exposure is no worse than today's
`max+1`. Upgrade path: move the counter into the folder DB behind the existing
query queue.

## Migration

**Nothing on disk or in docker moves for existing projects and tasks.** This is the property that makes the
change cheap, and it is not a coincidence — the separator `-` was chosen to
preserve it.

An existing project `id: 3` becomes `id: "3"`, which is a valid slug. An
existing task `17` in project `3` becomes `"3-17"`. Every derived name is then
byte-identical to what is already on disk:

| artifact | today | after migration |
|---|---|---|
| `repos/<projectId>` | `repos/3` | `repos/3` |
| `worktrees/<projectId>-<taskId>` | `worktrees/3-17` | `worktrees/<task.id>` = `worktrees/3-17` |
| `caretaker-task-<p>-<t>` | `caretaker-task-3-17` | `caretaker-task-<task.id>` = `caretaker-task-3-17` |
| `caretaker-project-<p>:latest` | `caretaker-project-3:latest` | unchanged |

New projects get real slugs; migrated ones keep an ugly-but-working numeric
slug. No rename affordance is offered (see immutability above).

Two coercion points:

1. `loadConfig()` — `id: String(p.id)` for each project.
2. One idempotent pass over the `tasks` and `task_messages` collections,
   guarded on `typeof projectId === 'number'`. `getDb()`
   ([db.ts:81](../../../packages/cli/src/store/db.ts#L81)) is synchronous, so
   the pass cannot literally live there: it runs as the **first operation on
   the `runQuery` queue** — the queue already serialises every store access, so
   every query from every surface (including `caretaker-cli mcp`, which skips
   the boot work in `index.ts`) waits behind it by construction. The pass
   rewrites `Task.id` and `Task.projectId`, seeds `Task.seq` from the old
   numeric id, and rewrites `TaskMessage.taskId`.

The rewrite pass is required rather than read-time coercion because tasks are
queried by `projectId` ([server.ts:412](../../../packages/cli/src/cli/web/server.ts#L412)):
`WHERE projectId = '3'` would not match a stored number.

### The one accepted risk

Branch names are **not** byte-identical: `caretaker/task-17-<title>` becomes
`caretaker/task-3-17-<title>` under the new derivation. This is harmless for
existing tasks because branch and worktree path are derived exactly once, in
`ensureWorktree` ([task_git.ts:288](../../../packages/cli/src/lib/task_git.ts#L288)),
persisted on the task, and read from the task everywhere after
(`task.branch`, `task.worktreePath`). Verified: `worktreePathFor` has exactly one
caller, and it is that function.

The narrow exception is the case the existing fallback comment already
anticipates — a task whose `worktreePath` was lost but whose branch still
exists. Re-derivation would then look for a branch name that does not exist,
the fallback `worktree add <path> <branch>` would fail, and the first
`worktree add -b` would create a fresh branch, orphaning the earlier commits.
The change therefore includes a targeted fix at that site:

```ts
const branch = task.branch ?? `caretaker/task-${taskId}-${slug(title)}`;
```

which makes the persisted branch authoritative and the fallback path actually
work as its comment claims.

## Blast radius (measured)

| | refs | files |
|---|---|---|
| `projectId` / `project.id` | 73 | 10 |
| `taskId` / `task.id` | 249 | 15 |

Most are type-level and `tsc` finds them. The edits that are not mechanical:

- **5** `Number(c.req.param('id'))` on project routes — server.ts
  [348](../../../packages/cli/src/cli/web/server.ts#L348),
  [374](../../../packages/cli/src/cli/web/server.ts#L374),
  [398](../../../packages/cli/src/cli/web/server.ts#L398),
  [409](../../../packages/cli/src/cli/web/server.ts#L409),
  [421](../../../packages/cli/src/cli/web/server.ts#L421) — plus the 11 task-id
  ones. The coercion goes away.
- **3** project-id query interpolations (server.ts
  [362-363](../../../packages/cli/src/cli/web/server.ts#L362),
  [412](../../../packages/cli/src/cli/web/server.ts#L412)) and **9** task-id ones
  (db.ts 120, 128, 161, 188, 189; server.ts 474; task_roles.ts 87;
  task_strategy.ts 397, 660) need quoting: `WHERE id = 'caretaker-cli-17'`.
  `parseValue` in the store handles quoted strings.
- **4 name derivations** already are template literals and need no change beyond
  types; two of them collapse to `worktrees/<task.id>` and
  `caretaker-task-<task.id>`, removing the pairing construction entirely.
- **`locks.ts`** — `runningTaskControllers` and `abortRunningTask` are typed
  `number`, `syncingProjects` too; all become `string`.
- **3 webview files** — types, plus a slug field in the project creation form.
  The form is also the **second id-assignment site**, and it is client-side:
  [ProjectsTabSettings.tsx:121](../../../packages/webview-ui/src/ProjectsTabSettings.tsx#L121)
  computes its own `Math.max(...ids) + 1` and creates the project through
  `saveConfig`. It stops computing ids and sends the user's slug instead; the
  host-side validation above is what actually enforces it.
- **19 MCP tool schemas** in `task_tools.ts` declare `task_id`/`project_id` as
  `{ type: 'number' }`, with 19 matching `Number(args.…)` coercions. The
  schemas become `{ type: 'string' }` and the coercions become `String(args.…)`
  — which also keeps external MCP clients that still pass migrated numeric ids
  (`3`, `17`-style) working, since `String()` accepts both.

### Where a mechanical refactor will silently go wrong

`ServiceConfig.id` is **already** `string`
([types/src/index.ts:20](../../../packages/types/src/index.ts#L20)), and in
`heartbeat.ts` / `telegram.ts` the variable named `task` is a **service**, not an
autonomous task. `runningTasks` in
[locks.ts](../../../packages/cli/src/cli/web/scheduler/locks.ts#L7) is already
`Set<string>` and holds service ids from those loops
([heartbeat.ts:84](../../../packages/cli/src/cli/web/scheduler/heartbeat.ts#L84)),
and `scheduler-logs/<id>.jsonl`
([logs.ts:18](../../../packages/cli/src/cli/web/scheduler/logs.ts#L18)) is keyed
by service id too.

`tsc` will not flag a wrong edit in any of those places. They must be left
alone. The same blindness applies in the opposite direction to the 19 MCP tool
schemas above: they are JSON literals, so `tsc` will not flag a **missed** edit
either — the checklist has to carry them explicitly. Note that the composite task id makes the pre-existing shared keyspace in
`runningTasks` *less* collision-prone than it is today, not more — a
`caretaker-cli-17` cannot look like a service uuid.

## Checked and sound (so the next review need not re-check)

- **No ordering anywhere depends on numeric ids.** Every sort in the affected
  surfaces is by `createdAt`, `updatedAt`, or `name`
  (task_tools.ts 39/404/549, server.ts 475). Lexicographic string ids break
  nothing.
- **Composite task ids are globally unique by construction.** The seq is the
  final segment and contains no hyphen, so `slugA-seqA = slugB-seqB` forces
  `seqA = seqB` and `slugA = slugB`. `worktrees/<task.id>` needs no project
  qualifier.

## Deliberately unchanged

- `TaskMessage.id` — numeric, `$auto`.
- Service ids, agent ids, session ids — already opaque strings.
- The managed-clone removal on project delete. Deleting a deleted project's
  repository is correct behaviour regardless of id reuse; only the comment that
  justifies it by reuse gets rewritten.
- Project rename. Out of scope, `ponytail:` comment names the upgrade path.

## Testing

Node's test runner via `tsx`, co-located `*.test.ts`.

- Migration: project `3` → `"3"`; task `17` in project `3` → `"3-17"`; the
  derived worktree path and container name are byte-identical to the pre-migration
  values. The pass is idempotent when run twice.
- Slug validation: charset rejections (uppercase, leading **and trailing** hyphen, `_`, `..`,
  `/`, over-length), duplicate rejection, and rejection of a changed id for an
  existing project through the `saveConfig` paths (web **and** VSCode sidebar — the validator is shared, but each handler must call it).
- Task sequence: create, delete the highest, create again — the new id is not
  the deleted one. Counter absent (`nextTaskSeq` unset) seeds from existing
  tasks.
- `createTask` with a title and objective duplicating an existing task in the
  same project returns the new task, not the old one.

`pnpm typecheck` carries most of the correctness burden here and is not
optional: `pnpm test` runs through `tsx` and does not type-check.

## Docs

- `CLAUDE.md` — the *State on disk* section documents numeric ids and the
  `max+1` reuse hazard, including the paragraph explaining why
  `DELETE /api/projects/:id` removes the managed clone. Both need rewriting.
- `README.md` — only if the project creation form's new slug field is
  user-visible there.
- Changeset: **minor** (`ProjectConfig.id` is a public type in
  `caretaker-types`, re-exported from the published CLI).

## Follow-up, out of scope here

The memory subsystem this unblocks was designed in the same session and is not
written down yet: four tiers (personality areas / core memories / long-term /
short-term) distinguished by read behaviour, an always-present index with bodies
on demand, extraction by an explicit fresh model call rather than by the active
agent, consolidation on the task heartbeat, and a Claude Code write path via a
`Stop` hook feeding a `caretaker-cli memory capture` subcommand. It gets its own
spec once this lands.
