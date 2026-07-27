# Voice managed backend: Delete container button

**Date:** 2026-07-27
**Status:** Approved

## Problem

The managed Speaches container keeps the DNS configuration Docker baked into it
at creation time (default bridge networking copies the host's `/etc/resolv.conf`
once, at `docker run`). Caretaker's deliberate stop-not-rm policy (`stopBackend`
is `docker stop` only) means a laptop that changes networks keeps a container
whose nameserver is unreachable — DNS inside the container dies entirely.

Observed failure chain (2026-07-27): container created on the office LAN
(`nameserver 10.4.1.254`) → moved to another network → model download left
partial (`voices.bin` only, no `model.onnx`) → Speaches still lists the model as
installed (`installModel` treats 409 as success, so caretaker never heals it) →
every `/audio/speech` request crashes with `StopIteration` → bare 500
"Internal Server Error" forwarded verbatim to the chat banner, with nothing in
caretaker's own logs.

The user needs a first-class way to throw the container away and let Start
recreate it — today that requires hand-run `docker rm -f`.

## Decision

Add a **Delete** button to the managed-backend block in the Voice settings tab.
Plain delete only (no composite "Recreate"): the state returns to `absent` and
the existing Start button is the recreation path (including model re-install).

Deleting is cheap by construction: the named volume `caretaker-hf-hub-cache`
(model cache) and the pulled image survive `docker rm`; the only thing lost is
the container itself — including its frozen network config, which is the point.

## Server — `voice_backend.ts` + route

- New injectable dep `removeContainer(name)` in `BackendDeps`, implemented as
  `docker rm -f <name>` (handles running and stopped alike).
- New exported `deleteBackend()` beside `stopBackend()`, targeting
  `CONTAINER_NAME` only. Never touches the volume or the image.
- New route `POST /api/voice/backend/delete` in `registerVoiceBackend`:
  - If a start is in flight (`backendStarting` guard), respond **409** with a
    short text — never tear the container down mid-pull/mid-install.
  - Otherwise run `deleteBackend()`, swallow "already gone" errors, and respond
    **200** with a fresh `probeBackend()` status — same idempotent contract as
    the stop route ("the truth is in the re-probe, not in a 500 for an action
    that is already done").

## UI — `VoiceTab.tsx`

- Delete button in the backend block next to Start/Stop, visible when
  `backendStatus.container !== 'absent'` (running **or** stopped), disabled
  while `backendBusy`.
- Two-step inline confirm: first click flips the label to "Really delete?";
  auto-reset after ~4 s if not confirmed; second click POSTs, updates
  `backendStatus` from the response body, routes errors into the existing
  `backendError`.
- Help line under the block encoding the lesson:
  "Removes the container; downloaded models are kept. Try this when the backend
  misbehaves after switching networks."
- After a successful delete the status is `absent`, so the block naturally
  shows Start again (`showBackendBlock` keys off `docker !== 'absent'`, not the
  container).

## Tests

In `voice_backend.test.ts`, against fake deps (no real daemon):

1. Delete with a running container → `removeContainer` called, returned status
   reflects the re-probe.
2. Delete with no container → still resolves (idempotent), no throw surfaces.
3. Delete while a start is in flight → route answers 409 and
   `removeContainer` is **not** called.

If any two-step confirm logic is worth extracting as a pure function, it goes
in `voice_backend_utils.ts` with tests (existing pattern: UI components are not
unit-tested, their pure logic is).

## Docs + versioning

- `CLAUDE.md` voice managed-backend section: policy becomes "stop never rms —
  and the explicit Delete affordance is how a container gets recreated".
- `README.md`: user-facing mention in the voice section.
- Changeset: `minor` (new feature), covering the fixed group.

## Out of scope (YAGNI)

- Composite "Recreate" button (delete + start in one action).
- Deleting the model-cache volume.
- Managing containers other than `caretaker-speaches`.
