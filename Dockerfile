# Image for running caretaker-cli's own autonomous tasks in isolation.
#
# Point a project's "Docker image" setting at this file (value: `./Dockerfile`)
# and the scheduler builds it into `caretaker-project-<id>:latest` and runs each
# task's dev / planning / review cycle inside it. The task worktree is
# bind-mounted at run time, so nothing is COPYd in here — this image only
# provides the environment (runtime + package manager + native build deps).
#
# Debian-based node so `apt-get` is available for the system libraries the
# workspace's native modules need (keytar -> libsecret, node-gyp -> toolchain).
FROM node:24-bookworm

# System dependencies:
#  - git: the agent inspects its branch in-container (the git common dir is mounted)
#  - build-essential + python3: node-gyp / prebuild for native modules
#  - libsecret-1-dev: keytar's native build
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git \
       build-essential \
       python3 \
       libsecret-1-dev \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (bundled with node), on PATH for both bootstrapCommands
# (`pnpm install`) and the agent's own shell commands. The container runs as the
# host user, so the package manager must live in the image like this — a runtime
# `npm i -g` would fail as non-root.
RUN corepack enable pnpm

WORKDIR /workspace
