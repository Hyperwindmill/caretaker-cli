---
"@hyperwindmill/caretaker-cli": patch
"caretaker-desktop": patch
---

fix(desktop): white screen on launch (0.14.1)

The `-v/--version` flag read `package.json` unconditionally for every
subcommand and let an unreadable file throw. The Electron desktop bundle
ships `packages/cli/dist` only (no `package.json`), so the forked
`caretaker-cli web` backend crashed at startup with ENOENT, the port never
opened, and the BrowserWindow loaded nothing — a white screen.

Guard the version read (fall back to a placeholder if unreadable) so a
missing `package.json` can never take the process down, and add
`packages/cli/package.json` to the desktop bundle so `-v` reports the real
version there too.
