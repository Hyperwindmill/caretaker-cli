---
"caretaker-cli": patch
---

fix(plugins): materialize tracked symlinks as plain files during git checkout on Windows

Plugin "sync now" failed on Windows for any source repo that tracks a symlink
(e.g. `CLAUDE.md -> AGENTS.md`): isomorphic-git's checkout calls `fs.symlink`,
which throws `EPERM` without the `SeCreateSymbolicLinkPrivilege` (admin /
Developer Mode). The git fetcher now wraps the `fs` handed to isomorphic-git so
`symlink` falls back to writing a plain file containing the link target on
`EPERM`/`EACCES` — mirroring git's own `core.symlinks=false` behavior (the
Windows default). Real symlinks are still used everywhere the OS permits them.
