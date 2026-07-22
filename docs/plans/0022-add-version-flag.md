# Plan: Add `-v` / `--version` flag to the CLI

## Task

- **ID:** 22
- **Title:** Add -v/--version flag to the CLI
- **Symptom:** `caretaker-cli --version` (and `-v`) errors with `error: unknown option`.
  The header comment in `packages/cli/src/cli/index.ts` claims `--version` "behaves
  normally" — that is false, because the commander `program` never calls `.version()`.
- **Root cause:** commander only registers the version option when you call
  `program.version(...)`. It is never called, so there is no version flag at all, and the
  claim in the comment is aspirational, not true.

## Scope & non-goals

**In scope**
- Register a version flag on the root commander `Command` using the flag spelling `-v, --version`.
- Source the version string from `packages/cli/package.json` at runtime (do **not** hardcode
  it — it must track the single Changesets-managed version, currently `0.14.0`).
- Correct the header comment so it describes reality.
- Add a patch changeset.

**Non-goals**
- No new subcommand, no new option on `run`/`web`/`mcp`/`config`.
- Do **not** add `-v` as a "verbose" flag anywhere — here `-v` means version (this is the
  task's explicit ask, and matches the objective's `-v, --version`).
- Do **not** restructure the TUI-vs-commander dispatch. The existing `argv.length <= 2`
  short-circuit is correct for the version flag (see Design decision 3).
- No unit test file (see Design decision 4).

## Design decisions

### 1. How to read the version — `readFileSync` + `new URL(..., import.meta.url)`

Read and parse `packages/cli/package.json` at runtime, resolving its path relative to the
module rather than the process CWD:

```ts
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
```

Why this path resolves correctly in **all three** layouts:

| Context | module location | `../../package.json` resolves to |
|---|---|---|
| dev (`tsx src/index.ts`) | `packages/cli/src/cli/index.ts` | `packages/cli/package.json` ✓ |
| built (`node dist/index.js`) | `packages/cli/dist/cli/index.js` | `packages/cli/package.json` ✓ |
| installed npm pkg | `node_modules/@hyperwindmill/caretaker-cli/dist/cli/index.js` | `.../caretaker-cli/package.json` ✓ |

`package.json` is always present at the package root: the published tarball includes it by
default, and `files` in `package.json` ships `dist`. So `../../` from `dist/cli/` always
lands on the package root next to `package.json`.

**Rejected alternative — `import pkg from '../../package.json' with { type: 'json' }`.**
`tsconfig.json` sets `rootDir: "./src"`; `package.json` lives outside `src`. A static JSON
import would pull a file outside `rootDir` into the program and break `tsc` emit
(`File is not under 'rootDir'`). The runtime `readFileSync` avoids the type-graph entirely
and needs no `resolveJsonModule` change. `createRequire(import.meta.url)('../../package.json')`
also works but is no cleaner; pick one and be consistent — this plan uses `readFileSync`.

### 2. Flag spelling — override commander's default `-V`

commander's default version flags are `-V, --version` (capital `V`). The task wants
lowercase `-v`, so pass the flags explicitly:

```ts
program.version(version, '-v, --version', 'output the CLI version and exit');
```

No other option on the root program uses `-v` (`run` uses `-a/-t/-o`, `web` uses `-p/-h`);
those are subcommand-scoped anyway, so there is no collision with the root version flag.

### 3. Placement — after the TUI short-circuit, read lazily

`caretaker-cli -v` and `caretaker-cli --version` both produce `process.argv.length === 3`,
so they fall through the `if (argv.length <= 2)` guard into the commander path — exactly
what we want. Put the `readFileSync` **after** that guard (right before/where the `program`
is constructed) so the common TUI launch (`argv.length <= 2`) does not pay for a file read
it never uses.

### 4. No unit test

`program.version()` is commander framework behavior: it prints to stdout and calls
`process.exit(0)` via commander's internal exit handling. Unit-testing that means trapping
`process.exit` and capturing stdout to assert on a string commander formats — testing the
framework, not our logic. Our only logic is "read the version from package.json", which is
verified end-to-end by the manual check below. Adding a bespoke test here is churn with no
real coverage gain; skip it (consistent with "touch only what you must"). Verification is
the build-and-run check in the Verification section.

## Implementation steps

### Step 1 — Wire the version flag in `packages/cli/src/cli/index.ts`

1. Add the fs import at the top of the file:

   ```ts
   import { readFileSync } from 'node:fs';
   ```

2. Update the header comment so the `--version` claim is true. The current block says
   `--help`, `--version` "behave normally" while no version was ever wired; keep the intent
   but make it accurate, e.g.:

   ```ts
   //   `caretaker --version|-v`       → prints the CLI version (from package.json)
   ```

   (Add this line to the dispatch summary, and leave the existing note that flags flow
   through commander — that part is correct.)

3. After the `if (argv.length <= 2) { … }` block and before/at the `const program = new Command();`
   construction, read the version and register it:

   ```ts
   const { version } = JSON.parse(
     readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
   ) as { version: string };

   const program = new Command();
   program
     .name('caretaker-cli')
     .description('Caretaker — TUI agent harness with subcommands for scripting.')
     .version(version, '-v, --version', 'output the CLI version and exit');
   ```

   Everything else in `runCli` (the `run`/`web`/`mcp`/`config` commands and
   `await program.parseAsync(argv)`) stays unchanged.

### Step 2 — Changeset

Create `.changeset/add-version-flag.md`:

```markdown
---
"@hyperwindmill/caretaker-cli": patch
---

feat(cli): add `-v` / `--version` flag

`caretaker-cli --version` and `caretaker-cli -v` now print the CLI version (read from
`package.json`) and exit cleanly, instead of erroring with "unknown option". The commander
program never registered a version flag; it now does, with lowercase `-v` (overriding
commander's default `-V`).
```

Prefer `pnpm -F @hyperwindmill/caretaker-cli exec changeset` (or `pnpm run changeset` from
root) to generate it interactively; the markdown above is the intended content if written
by hand. `patch` is correct — it's a small additive fix to a broken flag, no breaking change.

## Files touched

| File | Change |
|---|---|
| `packages/cli/src/cli/index.ts` | Import `readFileSync`; read version from `package.json`; `.version(version, '-v, --version', …)` on the program; fix the header comment |
| `.changeset/add-version-flag.md` | New changeset (patch) |

## Verification

Run from the repo root:

1. `pnpm -F @hyperwindmill/caretaker-cli typecheck` — no type errors from the new import /
   the `as { version: string }` cast.
2. `pnpm -F @hyperwindmill/caretaker-cli build` — compiles cleanly.
3. Dev path: `pnpm -F @hyperwindmill/caretaker-cli exec tsx src/index.ts --version` →
   prints `0.14.0` (the current `packages/cli/package.json` version) and exits `0`.
4. Same for the short flag: `… tsx src/index.ts -v` → prints `0.14.0`, exit `0`.
5. Built path: `node packages/cli/dist/index.js --version` → prints the same version,
   exit `0` (confirms the `../../package.json` URL resolves from `dist/cli/` too).
6. `pnpm -F @hyperwindmill/caretaker-cli test` — existing suite stays green (no test added,
   nothing should regress).
7. Confirm the plain TUI launch still works: `pnpm -F @hyperwindmill/caretaker-cli exec tsx src/index.ts`
   (no args) still renders the TUI — the version read is after the `argv.length <= 2` guard
   so this path is unaffected.

Exit code check for steps 3–5: append `; echo "exit=$?"` and confirm `exit=0`.

## Risk & rollback

- **Risk:** Very low. Additive change to one file plus a changeset; no schema, no on-disk
  state, no public export touched.
- **Failure mode to watch:** the `../../package.json` relative URL — the verification steps
  exercise both the `tsx` (src) and `node dist` (built) layouts precisely to catch a wrong
  path before release.
- **Rollback:** revert the single commit.
