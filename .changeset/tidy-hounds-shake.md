---
'@hyperwindmill/caretaker-cli': minor
'caretaker-types': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
---

Voice mode: let caretaker manage the local Speaches container

Settings → Voice grows a **Local backend** block that detects, starts and stops the
Docker container behind your speech endpoint, so voice works on a machine with
Docker without touching a terminal. Start pulls the image (about 2 GB the first
time, with progress), launches the container, waits for it to answer, and installs
the transcription and synthesis models you configured — Speaches does not fetch
models on demand, so skipping that would leave the backend healthy and 404-ing on
the first request. Stop stops the container and nothing else: the model cache is a
named volume that survives, so the next start is quick.

The endpoint you configure is the source of truth and the container is bound to
match it — caretaker parses the port out of `voice.endpoint`, never rewrites it and
never probes for a free one. So the block appears only for a loopback endpoint, and
a busy port surfaces Docker's own error rather than being silently worked around.
The three Docker failure modes are reported apart, because the fixes differ: not
installed, daemon not running, and your user not being in the `docker` group.

New optional `voice.autoStartBackend` starts the container when the web server
boots (off by default, and available in the Electron desktop app too, since it
forks that server). It is fire-and-forget and never fatal — the server comes up
whether or not the backend does.
