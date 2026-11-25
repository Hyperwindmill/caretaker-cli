# Update notice — design

## Intent

Caretaker is starting to have users, and they run different versions. The goal is that every user
*notices* a newer release exists. Installing it stays the user's job: a notice with a link is enough.

## Goals / non-goals

- Goal: web GUI (and therefore the desktop app, which frames the web server) shows a banner when a newer
  release is published; the TUI shows one line at startup.
- Goal: the notice appears only when a release is **published** on GitHub (drafts are invisible), so the
  existing manual "publish the draft" step stays the release gate.
- Non-goal: downloading or installing anything (no electron-updater — see Approaches).
- Non-goal: VSCode extension (sideloaded VSIX, own cycle), headless `run`, `mcp` (stdout is a data channel).
- Anti-goal: a check that slows boot, breaks offline use, or nags after the user dismissed a version.

## Approaches

- **A. Notice only, one shared check (picked).** Read GitHub's latest published release, compare with the
  running version, show a banner/line with a link. No CI, signing or new dependency.
- B. electron-updater for the desktop + notice for the CLI. Real install, but needs CI changes
  (`latest*.yml`, blockmaps, AppImage), root prompt for `.deb`, and an install path hard to test locally.
  Disproportionate to "users don't know a new version exists". Can be layered on later for the desktop
  only: the banner's link becomes an "Update now" button.

## Design

- **Source of truth**: `GET https://api.github.com/repos/Hyperwindmill/caretaker-cli/releases/latest`
  (excludes drafts and pre-releases). `tag_name` `vX.Y.Z` → version; `html_url` → link. The five packages
  share one version (Changesets fixed group), so one comparison covers desktop, web and CLI.
- **Current version**: the CLI's `package.json`, read at runtime. The reader that `cli/index.ts` already
  has for `--version` moves to a small shared helper so both use it (the desktop bundle ships
  `packages/cli/package.json`, so it resolves there too).
- **Check module** (`lib/update_check.ts`): `checkForUpdate()` → `{ current, latest, url } | null`.
  Numeric `X.Y.Z` comparison; `null` on any failure (network, timeout ~5 s, rate limit, malformed tag) —
  never throws, never logs noise. Result cached in-process for 6 h, so a long-running web server rechecks
  a few times a day and the 60 req/h unauthenticated GitHub limit is irrelevant.
- **Opt-out**: `updateCheck: false` in `caretaker.json` (`CaretakerConfig`, default on) disables every
  network call — for offline or corporate setups.
- **No install-kind detection.** Desktop, npm and Docker installs all get the same banner pointing at the
  GitHub release page; the user picks the right asset or method there.
- **Global CLI on PATH**: the server looks for `caretaker-cli` on `PATH` (the probed shell env from
  `shell-env.ts`, so version-manager bins are found under the desktop too) and runs
  `caretaker-cli --version` (5 s timeout). When that version is behind `latest`, the banner also shows
  the update command. This is what serves the desktop user who also has the TUI installed, and it is
  independent of the app's own version (an up-to-date desktop with a stale global CLI still gets the
  notice). Under `caretaker-cli web` from npm the running CLI *is* the one on PATH, so the command shows
  there too — correct. Docker has no global CLI on PATH, so no command. Not found / failed → no command.
- **Web**: `GET /api/update` → `{ current, latest, url, cliOutdated }`; `latest`/`url` absent when there
  is nothing newer or the check is disabled/failed. The webview fetches it on mount and hourly (cheap:
  server-side cache). Banner at the top of the app, above everything, not covering the chat:

  ```
  ⬆ Caretaker 0.38.0 is available — you have 0.37.0
    Terminal CLI: npm i -g @hyperwindmill/caretaker-cli@latest     ← only when cliOutdated
                          [ Download ]  [ Copy command ]  [ Dismiss ✕ ]
  ```

  "Download" opens the release `html_url` (desktop already routes `target=_blank` to
  `shell.openExternal`); "Copy command" and "Update CLI" only with the command line. The banner shows
  when the app or the global CLI is behind.
- **Update CLI (run it for the user)**: `POST /api/update/cli` runs the fixed command
  `npm i -g @hyperwindmill/caretaker-cli@latest` (no user input in the argv) with `commandEnv()`, so the
  npm of the user's version manager is found; 5 min timeout; one run at a time (409 while in flight).
  Answers `{ ok, output }` (tail of stdout+stderr) when it ends — no streaming, the button shows a
  spinner. Afterwards it re-runs `caretaker-cli --version`:
  - now current → banner line becomes "CLI updated — restart open caretaker-cli sessions to use it"
    (a running `caretaker-cli web` from npm keeps the old code in memory until restarted);
  - npm failed (typically `EACCES` with a system Node, where `-g` needs root) → the error tail is shown
    and "Copy command" stays, so the user runs it with the privileges it needs;
  - npm succeeded but the `caretaker-cli` on PATH is still old (installed with another package manager,
    or an earlier PATH entry) → say so plainly; no further guessing.
  No agent tool mirrors it: installing global packages on the host is maintenance, not an agent
  capability (an agent with `bash` can already do it if the user allows).
- **Dismiss**: per version, persisted as `dismissedUpdateVersion` in `ui-state.json` (not localStorage:
  the desktop's per-launch port gives each launch a fresh origin). A newer release shows the banner again.
- **TUI**: the check runs in the background at startup; when it resolves with a newer version, one line
  under the logo: "⬆ Caretaker vX.Y.Z available (you have vA.B.C) — npm i -g
  @hyperwindmill/caretaker-cli@latest". No dismiss (one line, per launch).
- **Docs**: CLAUDE.md (surface matrix + `updateCheck`) and README (the notice and the opt-out).

## Left to the builder

Exact banner styling (match existing notices), where the version helper lives, test layout
(the version comparison and the "null on failure" contract get unit tests).
