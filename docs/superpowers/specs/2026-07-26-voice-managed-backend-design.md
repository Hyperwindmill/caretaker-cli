# Managed local speech backend — design

Date: 2026-07-26
Status: approved, ready for implementation

## Goal

Let caretaker detect, start and stop the local Speaches container itself, so voice
mode works on a machine with Docker without the user running anything in a terminal.
Optionally start it at web-server boot, opt-in.

Increment on `2026-07-25-voice-mode-design.md`. Nothing there changes.

## The rule that shapes everything

**The configured endpoint is the source of truth; the container is made to match it.**
Not the reverse.

caretaker parses the port out of `voice.endpoint` and binds the managed container to
it. It never rewrites `voice.endpoint`, never probes for a free port, and never
invents its own. So there is exactly one place the port lives, and "the backend is
managed" changes nothing about how the proxies resolve their target — they keep
reading `voice.endpoint` exactly as they do today.

Consequence: the affordance only appears when the endpoint is **loopback**
(`127.0.0.1`, `localhost`, `[::1]`). Managing a local container for a remote endpoint
is meaningless, so the whole block is hidden then.

Consequence: if that port is busy, `docker run` fails and we surface its error. That
is the correct outcome — the user chose the port.

## Configuration

One new optional field on `VoiceConfig`:

```ts
  /** Start the managed local speech container when the web server boots.
   *  Off by default; manual start/stop needs no flag, it is a button. */
  autoStartBackend?: boolean;
```

No flag for "manage the backend" at all. If Docker is present and the endpoint is
loopback, the Start/Stop control is offered. Persisting a decision is only needed for
the thing that happens without the user present.

## Server: `packages/cli/src/cli/web/voice_backend.ts`

Reuses `lib/docker.ts`, which is already explicitly task-agnostic ("the container NAME
is always a parameter … so a future agent-level isolation can reuse it with a different
naming scheme + mount"). `containerState`, `containerRunning` and `removeContainer` are
used as-is; the run argv is this module's own, since the task one mounts a worktree and
overrides the entrypoint with `sleep infinity`.

Container name: `caretaker-speaches`. Image: `ghcr.io/speaches-ai/speaches:latest-cpu`.
Volume: a named `caretaker-hf-hub-cache` at `/home/ubuntu/.cache/huggingface/hub`.
Published on `127.0.0.1:<port from endpoint>:8000`.

### `probeBackend(endpoint): Promise<BackendStatus>`

```ts
export type BackendStatus = {
  /** Why the affordance may be unavailable, distinguished because the fixes differ. */
  docker: 'ok' | 'absent' | 'denied' | 'down';
  container: 'running' | 'stopped' | 'absent';
  imagePresent: boolean;
  /** Port parsed out of the endpoint, or null when it is not loopback. */
  port: number | null;
  /** True when /v1/models answers — running is not the same as ready. */
  responding: boolean;
};
```

The three Docker failures are separated on purpose, because the remedy differs and a
generic "Docker unavailable" wastes the user's time:

| value | detected by | what the UI says |
| --- | --- | --- |
| `absent` | spawn fails `ENOENT` | Docker is not installed |
| `denied` | stderr matches permission denied on the socket | your user needs to be in the `docker` group |
| `down` | `docker info` fails but the binary ran | the Docker daemon is not running |

### `startBackend(voice): AsyncGenerator<StartProgress>`

Progress is streamed, because the first run pulls **2.08 GB** and a silent button reads
as a hung app.

1. **Image** — if absent, `docker pull`. Emit progress lines.
2. **Run** — `docker run -d` with the args above. If a stopped container of that name
   exists, `docker start` it instead. Already running ⇒ skip (idempotent, so two
   caretaker instances or a hand-started container are all fine).
3. **Readiness** — poll `GET <endpoint>/models` until it answers, capped at 60 s.
   Running is not ready.
4. **Models** — `POST <endpoint>/models/<id>` for `sttModel` and, when set, `ttsModel`.
   **This step is not optional**: Speaches does not fetch models on demand, so without
   it the backend reports healthy and then 404s on the first real request — exactly the
   confusing state the voice spec documents.

Each step reports its own failure verbatim. A failure leaves the container as it is
rather than rolling back: a pulled image and a running container are useful even if the
model download failed, and the user can retry.

### `stopBackend(): Promise<void>`

`docker stop caretaker-speaches`. **Never** `rm`, and never touch the volume — stopping
must not cost a multi-gigabyte re-download. Removing the container or the cache is not
offered in this iteration; `docker` in a terminal remains the way to do that, and the
README says so.

## Auto-start

At `server.ts`, next to `startBackgroundScheduler()` (line 678), after `serve()`:

- Runs only when `voice.enabled && voice.autoStartBackend` and the endpoint is loopback.
- **Fire-and-forget.** It must never block `serve()` — a first run would otherwise hang
  `caretaker-cli web` for minutes behind a 2 GB pull.
- **Never fatal.** Every failure is logged and reflected in the status the UI polls; the
  web server comes up regardless.
- Idempotent, so the desktop app (which forks this server) and a separately running
  `caretaker-cli web` cannot fight over it.

## API and bridge

- `GET /api/voice/backend` → `BackendStatus`.
- `POST /api/voice/backend/start` → streams progress as newline-delimited JSON, so the
  2 GB pull is visible. Terminal line carries the final `BackendStatus`.
- `POST /api/voice/backend/stop` → `BackendStatus`.

Plain HTTP rather than new WebSocket message types: this is request/response with
progress, the settings panel is the only consumer, and `fetch` streaming reads it
without touching the host↔view contract.

## UI

A block at the top of the Voice tab, rendered only when `docker !== 'absent'` and the
endpoint is loopback:

- One status line: `Local backend: running on :8969` / `stopped` / `Docker daemon is not
  running` / `add your user to the docker group`.
- **Start** / **Stop**. While starting, the streamed progress replaces the status line.
- A checkbox **Start automatically with caretaker**, bound to `autoStartBackend`, saved
  with the rest of the form.
- A note that the first start downloads about 2 GB.

## Out of scope

The CUDA image variant, removing the container or its volume, choosing models at start
time (the configured ones are used), free-port probing (the rule above removes the
need), auto-start on the TUI or VSCode surfaces (they boot no server and voice is
unavailable there anyway), and any attempt to install Docker.

## Testing

- `voice_backend.test.ts` for the pure parts: port extraction from an endpoint
  (loopback vs remote vs malformed), classification of the three Docker failures from
  representative stderr, and the readiness/model-pull sequencing against a fake
  endpoint. `lib/docker.ts` is stubbed — the tests must not need a Docker daemon.
- The real container path stays a manual check, documented in the README.

## Known ceilings

- The first start is a ~2 GB download with coarse progress; docker's own pull output is
  passed through rather than parsed into a percentage.
- Readiness is capped at 60 s. On a slow machine a legitimate boot could exceed it and
  report a timeout while the container is still coming up; the status then corrects
  itself on the next poll.
- caretaker now manages a third-party service's lifecycle, which is a new
  responsibility for the project. It is opt-in, labelled as managed, and never destroys
  data.
