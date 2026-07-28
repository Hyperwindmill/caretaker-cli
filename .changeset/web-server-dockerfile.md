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