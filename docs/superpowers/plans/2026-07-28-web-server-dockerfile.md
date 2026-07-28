# Web Server Dockerfile — Implementation Plan

> **For agentic workers:** execute task-by-task; steps use checkbox (`- [ ]`)
> syntax. This is a container-packaging task — **no source/code changes**. The
> executor has Docker available and MUST verify with a real build + run.

**Goal:** Add `Dockerfile.web` + `docker-compose.web.yml` that serve
`caretaker-cli web` on Node 24, documenting how to expose the host Docker daemon
and which volumes to mount (standardized caretaker-home + workspaces folder).

**Design:** `docs/superpowers/specs/2026-07-28-web-server-dockerfile-design.md`
(read it first — the identical-path bind-mount constraint is the crux).

**Tech Stack:** pnpm 11 workspaces monorepo, Node 24, Hono web server,
Changesets fixed group.

## Global constraints

- **Do NOT touch the existing root `./Dockerfile`** — it is the per-project
  task-isolation image, a different deliverable. Create `Dockerfile.web`.
- Conventional commits, **no** Co-Authored-By / AI attribution.
- Every change needs a changeset (`.changeset/*.md`, five-package fixed group).
- Keep `CLAUDE.md`/`README.md` in sync in the same unit of work.
- The existing shared `.dockerignore` already excludes `node_modules`/`dist`/
  `.git`; it is correct for this build too — do not alter it.

---

### Task 1: `Dockerfile.web`

**Files:** Create `Dockerfile.web` (repo root).

- [ ] **Step 1: Write the file**

```dockerfile
# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Image that SERVES `caretaker-cli web` (the local web GUI + scheduler).
#
# This is NOT the per-project task-isolation image — that is the sibling
# `./Dockerfile`, which a project's "Docker image" setting points at and which
# the scheduler builds per project. This image runs caretaker itself.
#
# ── Run it ───────────────────────────────────────────────────────────────────
#   docker compose -f docker-compose.web.yml up -d      # recommended
# or by hand (see the three mounts + the loopback publish + host bind):
#   docker run -d --name caretaker-web \
#     -p 127.0.0.1:3000:3000 \
#     -v /srv/caretaker:/srv/caretaker \
#     -v /srv/workspaces:/srv/workspaces \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     --group-add "$(getent group docker | cut -d: -f3)" \
#     -e CARETAKER_HOME=/srv/caretaker \
#     caretaker-web
#
# ── Expose the host Docker daemon (for caretaker's OWN task isolation) ─────────
# caretaker isolates each autonomous task in a *sibling* container it launches on
# the HOST daemon. Mount the host socket (`-v /var/run/docker.sock:...`) so it can
# build/pull/run/exec those containers ("Docker-out-of-Docker"). The container
# user needs the socket's group — pass `--group-add <host docker gid>` at run
# time (the gid is host-specific, so it is NOT baked in here). Omit the socket
# and task Docker isolation is simply off; everything else still works.
#
# ── Which volumes to mount (and WHY source == target) ─────────────────────────
# The sibling task containers are launched with identical-path bind mounts
# (`-v <path>:<path>`), resolved by the HOST daemon against the HOST filesystem.
# The paths are the task worktree ($CARETAKER_HOME/worktrees/...) and the git
# common dir (under the workspaces folder). So BOTH of caretaker's own mounts
# MUST be source == target — the same absolute path on host and in this
# container — or the sibling container bind-mounts an empty host dir:
#   1) Caretaker home  -v /srv/caretaker:/srv/caretaker  + CARETAKER_HOME=/srv/caretaker
#        all state: config, sessions, scheduler logs, plugins, MCP, encrypted
#        secrets, and the task worktrees.
#   2) Workspaces      -v /srv/workspaces:/srv/workspaces
#        where project repos live; every project's workingDir must be under it.
# `/srv/caretaker` and `/srv/workspaces` are defaults; the only hard rule is
# source == target for both.
#
# ── Security ──────────────────────────────────────────────────────────────────
# caretaker has NO built-in auth. The CMD binds 0.0.0.0 (127.0.0.1 would be
# unreachable from outside the container), so keep the HOST publish on loopback
# (`-p 127.0.0.1:3000:3000`) or put an authenticating reverse proxy in front.
# ─────────────────────────────────────────────────────────────────────────────

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:24-bookworm AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /build

# Manifests first, for a cache-friendly install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json        packages/types/package.json
COPY packages/webview-ui/package.json    packages/webview-ui/package.json
COPY packages/cli/package.json           packages/cli/package.json
COPY packages/vscode-extension/package.json packages/vscode-extension/package.json
COPY packages/desktop/package.json       packages/desktop/package.json

# Install only the web-server graph: `...` pulls in the workspace deps
# (webview-ui, caretaker-types) and skips vscode-extension/desktop — so Electron
# and the optional keytar native build are never fetched.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @hyperwindmill/caretaker-cli...

# Now the sources for the three packages we build.
COPY packages/types      packages/types
COPY packages/webview-ui packages/webview-ui
COPY packages/cli        packages/cli

# Build topologically (types -> webview-ui -> cli). The cli build's
# copy-webview.mjs folds the UI bundle into dist/webview.
RUN pnpm --filter @hyperwindmill/caretaker-cli... build

# Self-contained deploy: /app gets the package `files` (dist + assets) and a
# real (non-symlinked) node_modules of PROD deps only. Clean here because the
# cli's runtime deps contain no workspace packages.
RUN pnpm --filter @hyperwindmill/caretaker-cli deploy --prod --legacy /app

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# git: host-side worktree management shells out to the git binary.
# docker CLI: talks to the mounted host socket (the daemon is the host's).
# ca-certificates: TLS to model providers / registries. bash ships in -slim and
# is needed by the interactive-shell PATH probe.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ca-certificates gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc 2>/dev/null \
     || (apt-get install -y --no-install-recommends curl \
         && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc) \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app /app

# All caretaker state lives here; override to match the source==target mount.
ENV CARETAKER_HOME=/srv/caretaker
ENV NODE_ENV=production

EXPOSE 3000

# Bind 0.0.0.0 inside the container (127.0.0.1 would be unreachable from the
# host). Keep the HOST publish on loopback — see the header note on auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["web", "--host", "0.0.0.0", "--port", "3000"]
```

Notes for the executor:
- The `docker-ce-cli` install needs `curl`; the block installs it lazily. If the
  apt-repo approach is brittle in the build environment, an accepted substitute
  is the static Docker client binary from
  `https://download.docker.com/linux/static/stable/<arch>/docker-<ver>.tgz`
  (extract only `docker/docker` into `/usr/local/bin`). Either satisfies the
  requirement (a `docker` client on PATH). Keep whichever builds cleanly.
- If `pnpm deploy --prod --legacy /app` errors in this pnpm version, fall back to
  copying the built tree: in runtime `COPY --from=builder /build /build`, set
  `WORKDIR /build/packages/cli`, and `ENTRYPOINT ["node","/build/packages/cli/dist/index.js"]`.
  The acceptance test (serves UI on :3000) is the arbiter.

- [ ] **Step 2: Build the image**

```bash
docker build -f Dockerfile.web -t caretaker-web .
```
Expected: build succeeds; final image is the `-slim`-based runtime, not the
builder.

---

### Task 2: `docker-compose.web.yml`

**Files:** Create `docker-compose.web.yml` (repo root).

- [ ] **Step 1: Write the file**

```yaml
# Runs caretaker's web GUI (`caretaker-cli web`) in a container.
#
#   docker compose -f docker-compose.web.yml up -d --build
#   open http://127.0.0.1:3000
#
# See Dockerfile.web for the full rationale. The three things that make
# caretaker's own autonomous-task Docker isolation work from inside a container:
#
#  1. The host Docker socket is mounted (Docker-out-of-Docker) so caretaker can
#     run sibling task containers on the HOST daemon.
#  2. group_add gives the container user access to that socket. Set DOCKER_GID to
#     your host's docker group id:  export DOCKER_GID=$(getent group docker | cut -d: -f3)
#  3. The caretaker home and the workspaces folder are bind-mounted at IDENTICAL
#     absolute paths (source == target). caretaker launches task containers with
#     `-v <path>:<path>` resolved by the HOST daemon, so the worktree and git
#     common dir must live at the same absolute path on host and in this
#     container. Change /srv/caretaker and /srv/workspaces together with
#     CARETAKER_HOME if you like — but keep each source == target.
#
# Optional: align file ownership to the host user that owns /srv/workspaces so
# worktree/task files stay host-consistent (caretaker passes its own uid/gid to
# the task containers it spawns):
#   export CARETAKER_UID=$(id -u)  CARETAKER_GID=$(id -g)
#
# SECURITY: caretaker has no built-in auth. The port is published to loopback
# only. To reach it from elsewhere, front it with an authenticating proxy — do
# NOT change this to 0.0.0.0 on an untrusted network.

services:
  caretaker-web:
    build:
      context: .
      dockerfile: Dockerfile.web
    image: caretaker-web
    container_name: caretaker-web
    # Loopback publish on purpose — no auth. See note above.
    ports:
      - '127.0.0.1:3000:3000'
    environment:
      - CARETAKER_HOME=/srv/caretaker
    volumes:
      # Identical-path (source == target) — required, see header.
      - /srv/caretaker:/srv/caretaker
      - /srv/workspaces:/srv/workspaces
      # Host Docker daemon for task isolation (DooD).
      - /var/run/docker.sock:/var/run/docker.sock
    # Socket group + optional uid/gid alignment (export before `up`).
    group_add:
      - '${DOCKER_GID:-999}'
    user: '${CARETAKER_UID:-1000}:${CARETAKER_GID:-1000}'
    restart: unless-stopped
```

- [ ] **Step 2: Prepare host dirs and bring it up**

```bash
sudo mkdir -p /srv/caretaker /srv/workspaces
sudo chown "$(id -u):$(id -g)" /srv/caretaker /srv/workspaces
export DOCKER_GID=$(getent group docker | cut -d: -f3)
export CARETAKER_UID=$(id -u) CARETAKER_GID=$(id -g)
docker compose -f docker-compose.web.yml up -d --build
```

---

### Task 3: Verify (real build + run)

- [ ] **Step 1: Container serves the UI**

```bash
docker compose -f docker-compose.web.yml up -d --build
sleep 5
curl -fsS http://127.0.0.1:3000/ | head -c 200      # expect the web UI HTML
docker inspect --format '{{.State.Health.Status}}' caretaker-web  # -> healthy
docker logs caretaker-web | tail -n 20               # expect the "🚀 Caretaker Server running" line
```

- [ ] **Step 2: DooD sanity — caretaker can see the host daemon**

```bash
docker exec caretaker-web docker version --format '{{.Server.Version}}'
```
Expected: prints the HOST daemon version (proves the socket + client + group are
wired). If it prints a permission error, `DOCKER_GID` is wrong — re-export and
`up -d` again.

- [ ] **Step 3 (optional, end-to-end): a git-project task isolates correctly**

Only if a provider/agent/project are configured under `/srv/caretaker` with a
project `workingDir` under `/srv/workspaces` and a `dockerImage` set: activate an
autonomous task and confirm a `caretaker-task-*` sibling container appears on the
host (`docker ps`) and its cycle runs against the real worktree (task thread
shows progress, not an empty-dir error). This is the acceptance for the
identical-path design.

- [ ] **Step 4: Tear down**

```bash
docker compose -f docker-compose.web.yml down
```

---

### Task 4: Docs + changeset

**Files:** Modify `README.md`; create `.changeset/web-server-dockerfile.md`.
(`CLAUDE.md` optionally — a one-line pointer under the deployment/surfaces
notes; the architecture itself is unchanged, so this is not mandatory.)

- [ ] **Step 1: README — add a "Run the web GUI in Docker" subsection**

Add after the "From source (development)" section (~line 218), before
"Built-in tools":

````markdown
## Run the web GUI in Docker

`Dockerfile.web` serves `caretaker-cli web` on Node 24; `docker-compose.web.yml`
is the runnable reference (this is separate from the root `./Dockerfile`, which
is the per-project *task-isolation* image).

```bash
sudo mkdir -p /srv/caretaker /srv/workspaces
sudo chown "$(id -u):$(id -g)" /srv/caretaker /srv/workspaces
export DOCKER_GID=$(getent group docker | cut -d: -f3)
export CARETAKER_UID=$(id -u) CARETAKER_GID=$(id -g)
docker compose -f docker-compose.web.yml up -d --build
# open http://127.0.0.1:3000
```

Three things make caretaker's own autonomous-task Docker isolation work from
inside the container:

- **Host Docker socket** (`-v /var/run/docker.sock:...` + `group_add` with your
  host `docker` gid): caretaker runs each task in a *sibling* container on the
  host daemon. Omit it and task Docker isolation is off; everything else works.
- **Two identical-path volumes** (`source == target`): the caretaker home
  (`/srv/caretaker`, also `CARETAKER_HOME`) holds all state including task
  worktrees, and the workspaces folder (`/srv/workspaces`) holds your project
  repos (put every project's working dir under it). caretaker mounts the worktree
  and git common dir into sibling containers with `-v <path>:<path>`, resolved by
  the host daemon — so both must be the *same absolute path* on host and in the
  container.
- **Loopback publish**: caretaker has no built-in auth, so the port is bound to
  `127.0.0.1`. Front it with an authenticating reverse proxy to expose it.
````

- [ ] **Step 2: Create the changeset**

`.changeset/web-server-dockerfile.md`:

```md
---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'caretaker-types': minor
---

Add `Dockerfile.web` and `docker-compose.web.yml` to run the caretaker web GUI
(`caretaker-cli web`) in a container on Node 24. Multi-stage build (pnpm
filtered install + `pnpm deploy --prod` onto a `node:24-bookworm-slim` runtime
with the git and Docker CLIs). Documents Docker-out-of-Docker (host socket
mount) and the two identical-path volumes (caretaker home + workspaces folder)
that autonomous-task Docker isolation requires from inside a container.
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.web docker-compose.web.yml README.md \
        docs/superpowers/plans/2026-07-28-web-server-dockerfile.md \
        docs/superpowers/specs/2026-07-28-web-server-dockerfile-design.md \
        .changeset/web-server-dockerfile.md
git commit -m "feat: add Dockerfile.web and compose to serve caretaker-cli web"
```
