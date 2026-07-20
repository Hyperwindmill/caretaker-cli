---
"@hyperwindmill/caretaker-cli": patch
---

Fix autonomous claude-code task runs failing with `option '--permission-mode'
argument 'manual' is invalid` on Claude Code CLIs older than v2.1.200. The
planner, docker dev, and reviewer confinement paths passed
`--permission-mode manual`, but `manual` is only a **v2.1.200+ alias for
`default`** — older CLIs reject it outright, and even where accepted it resolves
to `default`, which in headless `-p` mode aborts the run on the first off-allowlist
prompt rather than denying it. These paths now use `--permission-mode dontAsk`,
which is valid on every current CLI and auto-denies (without hanging or aborting)
any tool call outside the explicit allowlist — the intended "confine to the
allowlist, deny the rest, never wait for a human" behavior for unattended runs.
