# Docker Task-Isolation Verification Report — Test 4

Environment probe of the autonomous-task Docker isolation. No application code was
modified; the only changes are this report, a one-line `.gitignore` addition, and
untracking the accidentally-committed `.pnpm-store/` (see Check 5). Each check
records the exact command or tool, its raw output, and a PASS / FAIL / N/A verdict.

## Summary

| # | Check | Result |
|---|-------|--------|
| 1 | Shell runs inside the container | PASS |
| 2 | In-container git | PASS |
| 3 | File-tool confinement | PASS |
| 4 | Toolchain identity | PASS |
| 5 | Branch hygiene (bootstrap pollution) | FAIL — remediated |

---

## 1. Shell runs inside the container — PASS

Tool: **shell**.

```
$ ls -la /.dockerenv
-rwxr-xr-x 1 root root 0 Jul 19 23:02 /.dockerenv

$ cat /etc/os-release
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"
```

Reasoning: `/.dockerenv` exists only inside a container — present, so the shell
runs inside the container. `/etc/os-release` reports **Debian 12 (bookworm)**,
which matches the project image (built from the `node:24` base, itself Debian
bookworm), **not** the host (kernel `7.0.0-27-generic`, a non-Debian host).
Container-vs-host distinction confirmed. **PASS.**

## 2. In-container git — PASS

Tool: **shell**.

```
$ git rev-parse --abbrev-ref HEAD
caretaker/task-20-test-4

$ git status --porcelain
(no output — working tree clean)

$ git log --oneline -5
3b3915ae chore(auto): Test 4
5bd45633 chore(docker): add project Dockerfile for dogfooding task isolation
e4707495 feat(docker): accept a Dockerfile path as dockerImage (build per-project image)
46a72944 fix(docker): use // absolute prefix in claude-code confinement allowlist
8f0097e6 chore(auto): Test 2
```

Reasoning: `git` resolved inside the container and reports the expected task
branch `caretaker/task-20-test-4`. The git common dir mount is working (a linked
worktree's gitdir resolves in-container). The git tooling itself works as
intended — **PASS.**

⚠️ **Caveat (see Check 5):** the empty `git status --porcelain` output above does
**not** mean the branch is pristine. Porcelain reports only untracked/uncommitted
changes; it was empty because the per-cycle WIP commit had already **committed**
32,559 `.pnpm-store/` files into the branch. The original version of this report
read that empty output as a "clean tree" — that framing was wrong and is corrected
below.

## 3. File-tool confinement — PASS

Tools: **file-READ** and **file-WRITE** (NOT the shell). Workspace root is
`/home/daniele/.caretaker/worktrees/1-20`.

| Attempt | Tool | Target | Outcome |
|---------|------|--------|---------|
| Read outside workspace | file-READ | `/etc/os-release` | **DENIED** |
| Read parent directory | file-READ | `/home/daniele/.caretaker/worktrees` | **DENIED** |
| Write one level above workspace | file-WRITE | `/home/daniele/.caretaker/worktrees/confinement-probe.txt` | **DENIED** |

Raw tool errors:

```
Read /etc/os-release
→ Claude requested permissions to read from /etc/os-release, but you haven't granted it yet.

Read /home/daniele/.caretaker/worktrees
→ Claude requested permissions to read from /home/daniele/.caretaker/worktrees, but you haven't granted it yet.

Write /home/daniele/.caretaker/worktrees/confinement-probe.txt
→ Claude requested permissions to write to /home/daniele/.caretaker/worktrees/confinement-probe.txt, but you haven't granted it yet.
```

Reasoning: all three escape attempts outside the workspace were denied. Note the
contrast with check 1, where the **shell** tool freely read `/etc/os-release` —
the file tools are confined to the workspace independent of the shell. Confinement
holds only if every attempt is denied; all three were. **PASS.**

## 4. Toolchain identity — PASS

Tool: **shell**.

```
$ which node && node --version
/usr/local/bin/node
v24.18.0
```

Reasoning: node resolves to the image's `/usr/local/bin/node` (the `node:24`
base), version v24.18.0 — the container toolchain, not a host install. **PASS.**

## 5. Branch hygiene: bootstrap pollution — FAIL (remediated)

Tool: **shell** (git). This finding was surfaced by the code reviewer and is an
in-scope environment/isolation observation.

The task's own WIP auto-commit `3b3915ae` ("chore(auto): Test 4") swept the entire
project-local pnpm store into the branch:

```
$ git ls-files '.pnpm-store/*' | wc -l
32559

$ git log --oneline --diff-filter=A -- '.pnpm-store/*' | tail -1
3b3915ae chore(auto): Test 4
```

Root cause: the container `bootstrapCommands` run `pnpm install`, which under the
bind-mounted worktree lands a project-local `.pnpm-store/` at the repo root.
`.gitignore` excluded `node_modules` but **not** `.pnpm-store`, so the per-cycle
WIP commit tracked all 32,559 store files. Because a `PASS` review keeps the
branch, that junk would ship with it. This is a real isolation-hygiene defect, not
a nit — and it is exactly why the git check must not read an empty
`git status --porcelain` as a clean branch (Check 2 caveat).

**Remediation applied in this cycle** (a `.gitignore` line is configuration, not
application code — in scope for this task):

```
$ # add `.pnpm-store` to .gitignore (next to node_modules)
$ git rm -r --cached .pnpm-store      # untrack all 32,559 files
$ git ls-files '.pnpm-store/*' | wc -l
0
```

The store is now untracked and gitignored; the next WIP commit removes the 32,559
files from the branch tip. **FAIL** as originally committed, **remediated** in this
cycle.

---

**Overall: checks 1–4 PASS; check 5 (branch hygiene) was a FAIL, now remediated.**
The shell executes inside a Debian-bookworm container matching the configured
image, git and the node toolchain are available in-container, and the file tools
are confined to the workspace while the shell is not — exactly the intended
isolation model. The one defect — the bootstrap `pnpm install` polluting the
branch with 32,559 untracked-then-committed `.pnpm-store/` files — has been
recorded honestly and fixed (`.pnpm-store` gitignored and untracked).
