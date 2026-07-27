# Voice Backend Delete Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Delete button for the managed Speaches container so a user can throw away a container with stale creation-time state (frozen DNS) and let Start recreate it.

**Architecture:** New injectable `removeContainer` dep (`docker rm -f`) + exported `deleteBackend()` in `voice_backend.ts`; new idempotent `POST /api/voice/backend/delete` route (200 + fresh `probeBackend` status, 409 while a start is in flight); two-step-confirm Delete button in the VoiceTab backend block. Volume and image are never touched.

**Tech Stack:** TypeScript ESM, Hono, React, Node built-in test runner via tsx, pnpm workspaces, Changesets.

**Spec:** `docs/superpowers/specs/2026-07-27-voice-backend-delete-design.md`

## Global Constraints

- Container name is always `caretaker-speaches` (`CONTAINER_NAME` const) — never parameterized.
- Never remove the volume `caretaker-hf-hub-cache` or the image.
- Conventional commits, **no** Co-Authored-By / AI attribution.
- Tests: Node built-in runner via tsx, co-located `*.test.ts`, run from repo root.
- Every feature needs a changeset (`.changeset/*.md`, fixed group, this one: `minor`).
- Docs (`CLAUDE.md`, `README.md`) must be updated in the same unit of work.

---

### Task 1: Server — `deleteBackend()` + `POST /api/voice/backend/delete`

**Files:**
- Modify: `packages/cli/src/cli/web/voice_backend.ts` (deps interface ~line 53, defaultDeps ~line 119, stopBackend comment ~line 347, registerVoiceBackend ~line 390)
- Test: `packages/cli/src/cli/web/voice_backend.test.ts` (append after the stop-route test, ~line 366)

**Interfaces:**
- Consumes: existing `deps` module state, `CONTAINER_NAME`, `backendStarting` guard, `probeBackend(endpoint)`, `loadConfig()`, test seams `setVoiceBackendDepsForTest` / `isBackendStartInFlightForTest`.
- Produces: `deleteBackend(): Promise<void>` (export), `removeContainer(name: string): Promise<void>` on `BackendDeps`, route `POST /api/voice/backend/delete` → 200 `BackendStatus` JSON | 409 text. Task 2's UI calls this route.

- [ ] **Step 1: Write the three failing tests**

Append to `packages/cli/src/cli/web/voice_backend.test.ts` (import `deleteBackend` is NOT needed — the tests drive the route):

```ts
// --- POST /api/voice/backend/delete ---------------------------------------

test('POST /api/voice/backend/delete removes the container and answers with the re-probed status', async () => {
  let removed: string | null = null;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => (removed ? 'absent' : 'running'),
    imagePresent: async () => true,
    removeContainer: async (name) => {
      removed = name;
    },
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/delete', { method: 'POST' });
  assert.equal(res.status, 200);
  const status = (await res.json()) as { container: string };
  assert.equal(removed, 'caretaker-speaches');
  assert.equal(status.container, 'absent');
});

test('POST /api/voice/backend/delete re-probes rather than throwing when there is no container', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'absent',
    imagePresent: async () => true,
    removeContainer: async () => {
      throw new Error('Error: No such container: caretaker-speaches');
    },
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/delete', { method: 'POST' });
  assert.equal(res.status, 200);
  const status = (await res.json()) as { container: string };
  assert.equal(status.container, 'absent');
});

test('POST /api/voice/backend/delete answers 409 while a start is in flight', async () => {
  const ready = await startReadyServer();
  try {
    let releasePull: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let removeCalls = 0;
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      containerState: async () => 'absent',
      imagePresent: async () => false, // force the pull path so the start stays in flight
      async *pullImage() {
        yield 'pulling';
        await gate;
      },
      runContainer: async () => {},
      removeContainer: async () => {
        removeCalls += 1;
      },
    });
    await saveConfig(
      baseConfig({ enabled: true, endpoint: `${ready.baseUrl}/v1`, sttModel: 'stt-x' }),
    );

    const app = new Hono();
    registerVoiceBackend(app);
    // Kick off the start and drain its stream in the background so the
    // generator actually runs (Hono streams execute as the body is consumed).
    const startDrained = app.request('/api/voice/backend/start', { method: 'POST' }).then((r) => r.text());
    await waitFor(() => isBackendStartInFlightForTest());

    const res = await app.request('/api/voice/backend/delete', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(removeCalls, 0);

    releasePull();
    await startDrained;
    await waitFor(() => !isBackendStartInFlightForTest());
  } finally {
    await ready.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root:
```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_backend.test.ts
```
Expected: the three new tests FAIL (route missing → 404 ≠ 200 for the first two; the third fails on the 409 assertion). `removeContainer` in the overrides is not yet in `BackendDeps` — tsx does not typecheck, so the tests still run.

- [ ] **Step 3: Implement dep + `deleteBackend()` + route**

In `packages/cli/src/cli/web/voice_backend.ts`:

1. Add to `BackendDeps` (after `stopContainer`, ~line 62):
```ts
  removeContainer: (name: string) => Promise<void>;
```

2. Add to `defaultDeps` (after `stopContainer`, ~line 150):
```ts
  async removeContainer(name) {
    await dockerExec(['rm', '-f', name]);
  },
```

3. Replace the `stopBackend` doc comment (~line 347-349) — its "removing the container … is not offered" claim becomes stale:
```ts
/** `docker stop` only — never `rm`, never touches the volume. Stopping must
 *  not cost a multi-gigabyte re-download. Removing the container (and only
 *  the container — the model-cache volume and the image survive) is its own
 *  affordance, `deleteBackend`, so a container that froze stale state at
 *  creation (e.g. the network's DNS) can be recreated by the next Start. */
export async function stopBackend(): Promise<void> {
  await deps.stopContainer(CONTAINER_NAME);
}

/** `docker rm -f` on the managed container. Handles running and stopped
 *  alike; never touches the `caretaker-hf-hub-cache` volume or the image. */
export async function deleteBackend(): Promise<void> {
  await deps.removeContainer(CONTAINER_NAME);
}
```

4. Add the route in `registerVoiceBackend`, after the stop route (~line 420):
```ts
  app.post('/api/voice/backend/delete', async (c) => {
    // Never tear the container down mid-pull/mid-install: the start flow
    // assumes the container it just created is still there.
    if (backendStarting) {
      return c.text('A start is in progress; wait for it to finish before deleting.', 409);
    }
    const config = await loadConfig();
    try {
      await deleteBackend();
    } catch {
      // No such container, daemon unreachable, etc. — the truth is in the
      // re-probe below, not in a 500 for an action that is already done.
    }
    const status = await probeBackend(config.voice?.endpoint ?? '');
    return c.json(status);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_backend.test.ts
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: all tests in the file PASS (new and pre-existing), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/voice_backend.ts packages/cli/src/cli/web/voice_backend.test.ts
git commit -m "feat(cli): add delete endpoint for the managed voice backend container"
```

---

### Task 2: UI — two-step Delete button in the VoiceTab backend block

**Files:**
- Modify: `packages/webview-ui/src/VoiceTab.tsx` (state ~line 77, handlers after `stopBackend` ~line 177, render block ~line 276-307)

**Interfaces:**
- Consumes: `POST /api/voice/backend/delete` from Task 1 (200 → `BackendStatus` JSON body; non-200 → plain-text reason). Existing component locals: `backendBusy`, `setBackendBusy`, `setBackendError`, `adoptBackendStatus`, `fetchBackendStatus`, `backendStatus`.
- Produces: nothing consumed by later tasks.

No component unit tests: the existing pattern tests pure logic in `voice_backend_utils.ts` only, and this change adds none worth extracting (trivial confirm state). Verification is build + typecheck + the manual check in Task 3.

- [ ] **Step 1: Add confirm state and the delete handler**

In `packages/webview-ui/src/VoiceTab.tsx`, after the `backendError` state (~line 77):

```tsx
  /** Two-step confirm for Delete: first click arms, second click executes.
   *  Auto-disarms after a few seconds so a stale "Really delete?" never
   *  lingers. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmDelete = () => {
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    confirmDeleteTimer.current = null;
    setConfirmingDelete(false);
  };
  const armDelete = () => {
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    setConfirmingDelete(true);
    confirmDeleteTimer.current = setTimeout(() => setConfirmingDelete(false), CONFIRM_DELETE_MS);
  };
  // Unmount cleanup clears only the timer — no setState on an unmounted component.
  useEffect(
    () => () => {
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    },
    [],
  );
```

Next to `BACKEND_POLL_MS` (module scope, top of file) add:

```tsx
const CONFIRM_DELETE_MS = 4000;
```

After the `stopBackend` handler (~line 177), add:

```tsx
  const deleteBackend = async () => {
    disarmDelete();
    setBackendBusy(true);
    setBackendError(null);
    try {
      const res = await fetch('/api/voice/backend/delete', { method: 'POST' });
      if (res.ok) adoptBackendStatus((await res.json()) as BackendStatus);
      else setBackendError((await res.text().catch(() => '')) || 'Delete failed.');
    } catch {
      // Best-effort — the poll below re-syncs regardless.
    } finally {
      setBackendBusy(false);
      fetchBackendStatus();
    }
  };
```

- [ ] **Step 2: Render the button and the help line**

In the backend block (~line 276), after the Start/Stop ternary's closing `)}` and before `</div>` of `voice-backend-status`:

```tsx
              {backendStatus.container !== 'absent' && (
                <button
                  type="button"
                  onClick={confirmingDelete ? deleteBackend : armDelete}
                  disabled={backendBusy}
                >
                  {confirmingDelete ? 'Really delete?' : 'Delete'}
                </button>
              )}
```

Extend the trailing `<small>` help block (~line 302-306) by appending one sentence, so it reads:

```tsx
            <small>
              The first start downloads about 2 GB. The container publishes on the
              port in your endpoint — if that port is taken, change it there and
              save; caretaker never picks a port for you. Delete removes the
              container but keeps the downloaded models — try it when the backend
              misbehaves after switching networks.
            </small>
```

- [ ] **Step 3: Build + typecheck the workspace**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: build clean, existing webview tests PASS, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/webview-ui/src/VoiceTab.tsx
git commit -m "feat(webview): add two-step delete button for the managed voice backend"
```

---

### Task 3: Docs, changeset, end-to-end check

**Files:**
- Modify: `CLAUDE.md` (§6 Voice Mode, "Managed local backend" bullet)
- Modify: `README.md` (voice / managed backend section)
- Create: `.changeset/voice-backend-delete-button.md`

**Interfaces:**
- Consumes: the feature as shipped by Tasks 1-2.
- Produces: nothing.

- [ ] **Step 1: Update `CLAUDE.md`**

In the "Managed local backend" bullet of §6, the sentence about `stopBackend()` currently ends: `«stopBackend() is docker stop only — never rm, never the volume, because stopping must not cost a 2 GB re-download.»` Extend it:

```
`stopBackend()` is `docker stop` only — never `rm`, never the volume, because stopping must not cost a 2 GB re-download. Deleting the container is its own affordance: `deleteBackend()` (`docker rm -f`, volume and image untouched) behind `POST /api/voice/backend/delete` — idempotent (no container → still 200 with the re-probed status, same contract as stop) and refused with 409 while a start is in flight. The webview offers it as a two-step-confirm Delete button in the backend block; the recreate path is the ordinary Start. The point is throwing away creation-time container state — Docker bakes the host's DNS into the container at `docker run`, so a laptop that switches networks can keep a container whose nameserver no longer exists.
```

- [ ] **Step 2: Update `README.md`**

The **Stop** paragraph (~line 153) currently reads:

```
**Stop** stops the container and nothing else: the model cache is a named Docker volume that survives, so starting again is quick. To remove the container or reclaim the cache, use `docker` yourself — `docker rm caretaker-speaches` and `docker volume rm caretaker-hf-hub-cache`.
```

Replace it with (the "remove the container … use docker yourself" claim is now stale):

```
**Stop** stops the container and nothing else: the model cache is a named Docker volume that survives, so starting again is quick. **Delete** (two-step confirm) removes the container itself but keeps the downloaded models — reach for it when the backend misbehaves after you switch networks, since the container keeps the DNS of the network it was created on; press **Start** afterwards to recreate it. To reclaim the model cache too, use `docker` yourself: `docker volume rm caretaker-hf-hub-cache`.
```

- [ ] **Step 3: Create the changeset**

Create `.changeset/voice-backend-delete-button.md`:

```md
---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'caretaker-types': minor
---

Add a Delete button for the managed Speaches voice backend: `POST /api/voice/backend/delete` removes the container (`docker rm -f`) while keeping the model-cache volume and image, so a container with stale creation-time state (e.g. frozen DNS after switching networks) can be recreated with Start. Idempotent when the container is already gone; refused with 409 while a start is in flight. The Voice settings tab gains a two-step-confirm Delete button.
```

- [ ] **Step 4: Full test pass + manual end-to-end**

```bash
pnpm test
```
Expected: all packages PASS.

Manual check (requires Docker):
```bash
pnpm -F @hyperwindmill/caretaker-cli dev web
```
In Settings → Voice: with the `caretaker-speaches` container present, the Delete button shows; first click flips to "Really delete?" (reverts after ~4 s if ignored); second click removes the container (`docker ps -a` no longer lists it), status flips to "not created" wording and Start reappears. Press Start to recreate and confirm voice still works.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/voice-backend-delete-button.md
git commit -m "docs: document the managed voice backend delete affordance"
```
