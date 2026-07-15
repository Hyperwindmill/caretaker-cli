# Contributing to caretaker-cli

Thanks for taking the time to contribute. This document covers everything you
need to get a working environment, run the dev loop, and land a change that
passes review.

## Prerequisites

- **pnpm >= 10.** This is a [pnpm workspaces](https://pnpm.io/workspaces)
  monorepo. `npm` and `yarn` are **not** supported — there is no `package-lock.json`
  or `yarn.lock`, and installing with anything other than pnpm will corrupt the
  workspace symlinks. Install pnpm with `corepack enable` or from
  [pnpm.io/installation](https://pnpm.io/installation).
- **Node.js** — a current LTS (the workspace is developed against `@types/node`
  25.x; anything 20+ should work). If you use `nvm`/`fnm`, pick the latest LTS.
- **Git** with a POSIX shell available for the pre-commit hook (Git Bash on
  Windows is fine).

Bootstrap the workspace once after cloning:

```bash
pnpm install
```

This installs every package, links the internal workspace dependencies, and
wires up the Husky git hooks via the `prepare` script.

## Repository layout

Five packages, versioned together as one fixed group (see
[Changesets](#changesets-are-mandatory)):

- `packages/cli/` — the Caretaker CLI/TUI, harness, store, plugins, MCP,
  scheduler, and the Hono web server. Authoritative source for runtime behaviour.
- `packages/webview-ui/` — shared React UI, consumed by both the web server and
  the VSCode extension.
- `packages/vscode-extension/` — the VSCode chat sidebar, which embeds the CLI as
  an ESM library.
- `packages/desktop/` — the Electron desktop shell (`caretaker-desktop`).
- `packages/types/` — shared type definitions (`caretaker-types`).

`CLAUDE.md` at the repo root is the deepest reference for architecture and
conventions — read it before touching the harness, tools, prompt assembly,
plugins, or scheduler.

## Dev loop

All commands run from the repo root unless noted. The `-F caretaker-cli` flag
scopes a command to the CLI package.

```bash
pnpm -F caretaker-cli dev            # launch the TUI (Ink)
pnpm -F caretaker-cli dev web        # launch the web GUI on http://127.0.0.1:3000
pnpm -F caretaker-cli build          # tsc → packages/cli/dist/
pnpm -F caretaker-cli start          # node dist/index.js (after build)
pnpm -F caretaker-cli typecheck      # tsc --noEmit
pnpm -F caretaker-cli test           # tsx --test "packages/cli/src/**/*.test.ts"
```

Across every package:

```bash
pnpm build        # build all packages (pnpm -r build)
pnpm test         # test all packages (pnpm -r test)
pnpm typecheck    # typecheck all packages
```

Run a single test file or a single test by name:

```bash
pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/loop.test.ts
pnpm -F caretaker-cli exec tsx --test --test-name-pattern='resolves @refs once' \
  packages/cli/src/harness/prelude.test.ts
```

### Isolated state

All on-disk state (providers, agents, sessions, plugins, MCP, scheduler logs)
lives under `CARETAKER_HOME` (default `~/.caretaker/`). Point it somewhere
disposable to work without touching your real config:

```bash
CARETAKER_HOME=/tmp/ct pnpm -F caretaker-cli dev
```

## Changesets are mandatory

This monorepo uses [`@changesets/cli`](https://github.com/changesets/changesets)
for versioning and changelogs. **Every feature, fix, or package edit must ship
with a changeset.** A `.husky/pre-commit` hook enforces this: on any feature
branch (anything other than `main`/`master`) a commit is rejected unless a
staged `.changeset/*.md` file is present.

Create one with:

```bash
pnpm changeset
```

Then stage it (`git add .changeset/`) before committing. Pick the semver bump
that matches your change:

- **patch** — bug fixes and internal changes with no API impact.
- **minor** — new, backward-compatible functionality.
- **major** — breaking changes to a public surface.

The five packages (`caretaker-cli`, `caretaker-desktop`, `caretaker-vscode`,
`webview-ui`, `caretaker-types`) are a **fixed group** in `.changeset/config.json`:
they always version and release together, so a bump to one bumps all of them to
the same version. Write the changeset summary as a user-facing changelog entry,
not a commit message.

## Code style

- **TypeScript**, `strict` mode (with `noImplicitAny: false`). Match the types
  and patterns of the surrounding code.
- **ESM only** (`"type": "module"`, `moduleResolution: "bundler"`). No CommonJS.
- **Tests** are co-located with source as `*.test.ts` and run on Node's built-in
  test runner through `tsx` — **no Jest, no vitest.** Add tests next to the code
  they cover.
- **Persisted state** must use the atomic write pattern (tmp file + rename +
  Windows-safe retry) — never fall back to a direct `writeFile` on the
  destination path. See `packages/cli/src/store/json.ts`.
- ESLint and Prettier are configured (`pnpm -F caretaker-cli lint` / `lint:fix` /
  `format` / `format:check`), but there is no CI gate enforcing them. Match the
  surrounding style and keep diffs clean.

## Pull request flow

1. **Branch from `main`.** Don't commit feature work directly to `main` — the
   changeset hook only runs on feature branches, and it's where releases are cut.
2. **Keep diffs surgical.** Change what the task needs and no more. Avoid
   drive-by reformatting or unrelated refactors.
3. **Add a changeset** (see above). Commits on a feature branch will be blocked
   without one.
4. **Verify before you push:**

   ```bash
   pnpm build
   pnpm typecheck
   pnpm test
   ```

5. Open the PR against `main` with a clear description of what changed and why.

## License

By contributing, you agree that your contributions are licensed under the
project's **FSL-1.1-MIT** license (Functional Source License 1.1, with an MIT
future grant). Make sure you have the right to submit any code you contribute.
