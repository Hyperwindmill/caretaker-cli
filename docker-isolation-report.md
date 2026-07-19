# Docker Task-Isolation Environment Report

- **Task:** #17 — Test
- **Date (UTC):** 2026-07-19T22:28:55Z
- **Configured image:** `node:24` (per task environment note)
- **Working directory:** `/home/daniele/.caretaker/worktrees/1-17`
- **Container name (shell runs via `docker exec`):** `caretaker-task-1-17`

## Summary

| Check | Description | Result |
|-------|-------------|--------|
| 1 | Shell runs inside the container | ✅ PASS |
| 2 | In-container git | ✅ PASS |
| 3 | File-tool confinement | ✅ PASS |
| 4 | Toolchain identity | ✅ PASS |

All four checks passed. The environment is correctly isolated:

- The **shell tool** executes inside the Docker container (confirmed by `/.dockerenv` and the in-container Debian bookworm `/etc/os-release`).
- **In-container git** works against the mounted git common dir (branch, status, and log all resolve).
- The **file-read / file-write tools are host-side and confined** to the working directory — every out-of-workspace attempt was denied.
- The **primary runtime is Node v24.18.0**; `git` and `npm` are present, but `pnpm` is absent (consistent with the earlier `pnpm install` bootstrap failure).

## Raw Evidence

### Check 1 — Shell runs inside the container

**Tool:** `bash` (shell tool — runs via `docker exec` inside the container)

**Command:**
```sh
ls -la /.dockerenv
cat /etc/os-release
```

**Raw output:**
```
-rwxr-xr-x 1 root root 0 Jul 19 22:25 /.dockerenv
---EXIT:0---
===OS-RELEASE===
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"
---EXIT:0---
```

**Verdict: PASS** — `/.dockerenv` exists (present only inside a container) and `/etc/os-release` shows Debian 12 bookworm, the base distribution for the `node:24` image — not the host OS.

---

### Check 2 — In-container git

**Tool:** `bash` (shell tool)

**Commands:**
```sh
git rev-parse --abbrev-ref HEAD
git status --porcelain
git log --oneline -5
```

**Raw output:**
```
===CHECK2-GIT===
caretaker/task-17-test
---EXIT:0---
===STATUS===
---EXIT:0---
===LOG===
dd5e984 docs(docker): review runs on host, git-common-dir mount, best-effort git; future push/agent notes
c4dc183 fix(tasks): mount git common dir into task container so in-container git works
29c61bf docs: document docker task isolation and add changeset
0154174 feat(web): dockerImage project setting (API + form)
90d2b65 feat(tasks): remove docker container on done/review-finalize/discard
---EXIT:0---
```

**Verdict: PASS** — `git` is available in the container (`/usr/bin/git`). The git common dir mount resolves correctly, so the linked-worktree gitdir works in-container:
- Branch: `caretaker/task-17-test`
- Working tree: clean (no porcelain output)
- Recent commits resolve and show the task-isolation work that set up this environment.

---

### Check 3 — File-tool confinement

**Tools:** `read_file` (file-read tool) and `write` (file-write tool) — these are host-side and sandboxed to the working directory.

**Attempt 3a — `read_file` of an absolute path outside the working dir:**

Tool call: `read_file({ path: "/etc/os-release" })`

Raw output:
```
Error: Path "/etc/os-release" is outside the working directory "/home/daniele/.caretaker/worktrees/1-17"
```
**Result: DENIED** ✅

**Attempt 3b — `read_file` of the parent directory of the workspace:**

Tool call: `read_file({ path: "/home/daniele/.caretaker/worktrees" })`

Raw output:
```
Error: Path "/home/daniele/.caretaker/worktrees" is outside the working directory "/home/daniele/.caretaker/worktrees/1-17"
```
**Result: DENIED** ✅

**Attempt 3c — `write` to a file one level above the working dir:**

Tool call: `write({ path: "../ct-confinement-probe.txt", content: "confinement probe" })`

Raw output:
```
Error: Path "../ct-confinement-probe.txt" is outside the working directory "/home/daniele/.caretaker/worktrees/1-17"
```
**Result: DENIED** ✅

**Verdict: PASS** — All three file-tool attempts at out-of-workspace paths were denied. The sandbox correctly confines file read/write tools to the working directory, even though the shell tool can access the container filesystem. This asymmetry is the intended design.

---

### Check 4 — Toolchain identity

**Tool:** `bash` (shell tool)

**Command:**
```sh
which node && node --version
which npm
which pnpm
which git
```

**Raw output:**
```
===CHECK4-TOOLCHAIN===
/usr/local/bin/node
v24.18.0
---EXIT:0---
===WHICH-NPM===
/usr/local/bin/npm
---EXIT:0---
===WHICH-PNPM===
---EXIT:1---
===WHICH-GIT===
/usr/bin/git
---EXIT:0---
```

**Verdict: PASS** — The image's primary runtime is Node.js:
- `node`: `/usr/local/bin/node` — v24.18.0
- `npm`: `/usr/local/bin/npm` — present
- `git`: `/usr/bin/git` — present
- `pnpm`: **absent** (`which pnpm` exit 1) — this explains the earlier `pnpm install` bootstrap failure (`sh: 1: pnpm: not found`). A project that depends on pnpm would need it installed via `bootstrapCommands` (e.g. `npm i -g pnpm`) or a richer base image.

---

## Conclusion

The Docker task-isolation environment is functioning correctly:

1. **Container isolation** is real — the shell tool runs inside `caretaker-task-1-17` (a `node:24` / Debian 12 container), confirmed by `/.dockerenv` and the container's own `/etc/os-release`.
2. **Git worktree isolation** works in-container — the git common dir mount lets the linked worktree's branch, status, and history resolve inside the container.
3. **File-tool sandboxing** is effective — host-side file read/write tools are confined to the working directory and reject all out-of-workspace paths, preserving host safety even though the shell tool can reach the container FS.
4. **Toolchain** is Node v24.18.0 + npm, with git available; pnpm is not preinstalled (bootstrap must provide it if the project needs it).

No application code was modified. The only file created is this report.