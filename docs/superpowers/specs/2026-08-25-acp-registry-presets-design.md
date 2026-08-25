# ACP Registry Presets, Binary Installer, and acpMode — Design

Date: 2026-08-25
Status: approved (brainstorming complete)

## Goal

Replace hand-typed ACP provider commands with a census of known agents from
the official ACP Agent Registry, install binary-distributed agents on the
user's behalf, and let an agent be pinned to one of its own permission modes
(`session/set_mode`) so interactive chats can run "auto" without caretaker
rubber-stamping anything.

Builds on the ACP runner (`docs/superpowers/specs/2026-08-25-acp-runner-design.md`),
which deliberately left registry-derived presets and session modes out of v1.

## The registry (verified 2026-08-25)

`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
(source: github.com/agentclientprotocol/registry). Shape:

- Top level: `{ version, agents: AgentEntry[], extensions }`.
- `AgentEntry`: `{ id, name, version, description, repository, website,
  authors, license, distribution, icon }`.
- `distribution` has one or more of:
  - `npx: { package: "name@version", args?: string[], env?: Record }` (21/39 agents;
    claude-acp, codex-acp, gemini, …)
  - `binary: { [platform]: { archive: url, cmd: relativePath, args?: string[],
    env?: Record, sha256?: string } }` with platform keys like `linux-x86_64`,
    `darwin-aarch64`, `windows-x86_64` (18/39; Google Antigravity, Cursor,
    Devin, goose, Kimi, Junie, opencode, …). Archives are `.tar.gz`,
    `.tar.bz2`, `.zip`, or a raw executable.
  - `uvx: { package, args?, env? }` (2/39).

Antigravity is binary-only: a real census UX therefore includes an installer,
not just npx prefill.

## Components

### 1. Registry service — `packages/cli/src/acp/registry.ts`

- `fetchAcpRegistry(): Promise<AcpRegistryAgent[]>` — GET the CDN JSON,
  normalize per entry to
  `{ id, name, description, version, dist }` where `dist` is already resolved
  for the **current platform**:
  - `{ kind: 'npx' | 'uvx', command: 'npx' | 'uvx', args: [pkg, ...args], env? }`
  - `{ kind: 'binary', archive, cmd, args?, env?, sha256? }`
  - entries with no distribution usable on this platform are returned with
    `dist: null` (shown disabled in the UI, never hidden — the user learns the
    agent exists).
- Disk cache: `~/.caretaker/cache/acp-registry.json` (path via a `dataDir()`-style
  accessor), TTL 24h; on fetch failure serve the last good cache regardless of
  age; no cache and no network → typed error, the UI falls back to Custom
  (manual fields).
- A small hardcoded map supplies what the registry does not know:
  `selfLoadedContextFiles` for the majors (`claude-acp` → `['CLAUDE.MD']`
  spelled `['CLAUDE.md']`, `codex-acp` → `['AGENTS.md']`, `gemini` →
  `['GEMINI.md']`), default `[]`.

### 2. Presets in the provider forms

- Type label everywhere becomes **"External agent (ACP)"** (select option and
  provider-list rows, webview + TUI) — "ACP" alone is unclear to anyone not
  already steeped in the protocol.
- Choosing the type shows an **Agent** select fed by the registry (name +
  short description), plus a **Custom** entry that keeps today's manual
  command/args fields as the fallback (never removed).
- npx/uvx preset selected → the form prefills `command`/`args`/`env` and saves
  a plain `ProviderConfig` (no new persisted fields; the provider record stays
  self-contained and hand-editable).
- Fetch goes through the host (webviews cannot reach the CDN cross-origin):
  new bridge messages `fetchAcpRegistry` → `acpRegistryFetched` mirroring the
  `fetchModels` → `modelsFetched` pattern, implemented by the web server host
  and the VSCode sidebar host. The TUI calls the service directly.

### 3. Binary installer — `packages/cli/src/acp/install.ts`

- `installAcpAgent(entry, onProgress)`: download the platform archive to
  `~/.caretaker/acp/<id>/<version>/`, verify `sha256` when present, extract
  (`tar -xf` for tarballs everywhere; `.zip` via `unzip` on POSIX and `tar`
  (bsdtar) on Windows — documented external dependency, no new libraries; a
  raw-executable archive is just moved into place), `chmod +x` the `cmd`
  target, and return `{ command: <absolute path>, args, env }` for the form to
  save. Idempotent per `<id>/<version>` (already installed → return
  immediately). Updating = installing the new version the registry advertises;
  old version dirs are left in place (manual cleanup, out of scope).
- Progress and completion ride the bridge (`installAcpAgent` →
  `acpInstallProgress*` / terminal result), so the same flow works in the web
  GUI, desktop, and VSCode sidebar. The TUI does not offer the installer in
  v1 (npx presets + manual path remain available there).
- The saved provider is a plain record pointing at the installed absolute
  path — nothing else in caretaker knows or cares that the binary is
  "managed".

### 4. `acpMode` (agent-level session mode)

- `AgentConfig.acpMode?: string` — free-text mode id (e.g. `bypassPermissions`,
  `acceptEdits` for claude-agent-acp; adapters advertise their own).
- Runner: after `session/new` / `session/load`, when `acpMode` is set and the
  response's `modes.availableModes` contains it, send
  `session/set_mode { sessionId, modeId }`; when it is set but not advertised,
  warn and continue (never fail the turn). Autonomous-task runs ignore
  `acpMode` — the task policy (unattended/planner/deny-all + Docker deny)
  stays authoritative there.
- Forms: shown only for external-runner providers of type acp (same block
  where claude-code shows `permissionMode`), free-text with a hint listing the
  common claude values. No live mode picker in chat (out of scope).

## Error handling

- Registry unreachable + no cache → the Agent select shows an inline error and
  Custom remains fully usable.
- Install failures (download, checksum mismatch, extraction, missing `unzip`)
  surface verbatim in the form; nothing partial is saved (version dir is
  removed on failure).
- `session/set_mode` errors are logged and swallowed — a wrong mode id must
  not brick the chat.

## Testing

- `registry.ts`: normalization + platform resolution + cache TTL/last-good
  against fixture JSON (no network in tests).
- `install.ts`: happy path with a local fixture archive (tar), checksum
  mismatch, already-installed short-circuit; extraction shells out so tests
  use real `tar` on a tiny fixture.
- Runner: `set_mode` sent when advertised, skipped with a warning when not
  (in-process fake agent, existing pattern).
- Forms: existing test approach per package (webview tests, TUI typecheck).

## Out of scope (declared)

Auto-updating installed binaries, registry icons, a live mode picker in chat,
uninstall UI (delete the dir by hand), TUI installer.

## Docs

CLAUDE.md layer-2 ACP paragraph (presets, installer, acpMode) and README
(pick an agent from the census instead of typing commands; the three worked
examples become "select from the list"). Changeset: minor (new feature).
