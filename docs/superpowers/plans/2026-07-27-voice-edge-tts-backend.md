# openai-edge-tts as an Alternative Managed TTS Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let voice mode synthesize through [openai-edge-tts](https://github.com/travisvn/openai-edge-tts) (Microsoft Neural voices, e.g. `it-IT-ElsaNeural`) while keeping Speaches for transcription — a separate optional synthesis endpoint, plus a second managed Docker container caretaker can start/stop/delete.

**Architecture:** `VoiceConfig.ttsEndpoint` + `ttsApiKey` (optional; unset ⇒ today's single-endpoint behaviour). `voice_proxy.ts` routes `/audio/speech` to the resolved TTS target, `/audio/transcriptions` unchanged. `voice_backend.ts` becomes parameterized over `Target = 'stt' | 'tts'` with a two-entry `BackendSpec` table (Speaches / edge-tts), a per-target in-flight guard, and a per-target model-install step; `GET /api/voice/backend` returns `{ stt, tts }`, the mutating routes take `?target=`. The Voice settings tab gains the two fields, a prefill button, and renders one extracted `VoiceBackendBlock` per managed container.

**Tech Stack:** TypeScript ESM, Hono, React, Node built-in test runner via tsx, pnpm workspaces, Changesets.

**Spec:** `docs/superpowers/specs/2026-07-27-voice-edge-tts-backend-design.md`

## Global Constraints

- The configured endpoint is the **source of truth**: parse its port, never invent or rewrite one; the managed affordance exists only for loopback endpoints.
- Start is idempotent (adopt an existing container of that name). `stop` = `docker stop` only. `delete` = `docker rm -f`, never a volume, never an image.
- Never send `voice.apiKey` to `ttsEndpoint` — a separate `ttsApiKey` or no header at all.
- Keep today's behaviour byte-identical when `ttsEndpoint` is unset. Every existing voice test must keep passing untouched.
- Tests: Node built-in runner via tsx, co-located `*.test.ts`, run from repo root. `pnpm test` does **not** typecheck — run `pnpm -F @hyperwindmill/caretaker-cli typecheck` too.
- Conventional commits, **no** Co-Authored-By / AI attribution. Commit at the end of every task.
- Every feature needs a changeset (`.changeset/*.md`, fixed group of 5, this one: `minor`).
- `CLAUDE.md` / `README.md` updated in the same unit of work (Task 6).

---

### Task 1: Verify the edge-tts container against the real image (no code yet)

Do **not** trust remembered documentation for this image; the constants in Task 3 and the parser in Task 4 come from what the container actually answers. (Project convention: verify formats from real artifacts.)

**Files:** none modified.

- [ ] **Step 1: Run it and read its API**

```bash
docker run -d --name ct-edge-probe -p 127.0.0.1:5050:5050 travisvn/openai-edge-tts:latest
docker image inspect travisvn/openai-edge-tts:latest --format '{{json .Config.ExposedPorts}} {{json .Config.Env}}'
sleep 5
curl -sS -i http://127.0.0.1:5050/v1/models | head -40
curl -sS -i http://127.0.0.1:5050/v1/voices | head -60
curl -sS -i http://127.0.0.1:5050/v1/voices/all | head -20
curl -sS -o /tmp/edge.mp3 -w '%{http_code} %{content_type}\n' -X POST http://127.0.0.1:5050/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"tts-1","input":"Prova di sintesi vocale in italiano.","voice":"it-IT-ElsaNeural","speed":1}'
ls -l /tmp/edge.mp3
```

If the requests come back `401`, the image requires an API key by default: find the env switch and confirm it, e.g.

```bash
docker rm -f ct-edge-probe
docker run -d --name ct-edge-probe -p 127.0.0.1:5050:5050 -e REQUIRE_API_KEY=False travisvn/openai-edge-tts:latest
```
(then repeat the curls; if that variable is not the one, `docker exec ct-edge-probe env` and the image's own README inside the container are the sources.)

- [ ] **Step 2: Record the findings in the task thread**

Call `task_add_message` (or, outside the autonomous runner, write them into this file under a "Verified" heading) with: internal port, whether `/v1/models` exists and its body, the exact `/v1/voices` JSON shape (array of strings? objects with which keys?), the readiness path chosen, the env var + value that disables auth, the `content-type` of a successful `/audio/speech`, and which Italian voice ids exist. **Every later task quotes these instead of guessing.**

- [ ] **Step 3: Clean up**

```bash
docker rm -f ct-edge-probe
```

---

### Task 2: Config + proxy routing for a separate synthesis endpoint

**Files:**
- Modify: `packages/types/src/index.ts` (`VoiceConfig`, ~line 66-88)
- Modify: `packages/cli/src/store/json.ts` (~line 96, encrypt-on-save)
- Modify: `packages/cli/src/cli/web/voice_proxy.ts` (`voiceAuthHeaders` ~line 43, speak route ~line 92)
- Test: `packages/cli/src/cli/web/voice_proxy.test.ts` (append)

**Interfaces:**
- Produces: `VoiceConfig.ttsEndpoint?: string`, `VoiceConfig.ttsApiKey?: string`, `ttsTarget(voice): { endpoint: string; apiKey?: string }` (exported — Task 3 and Task 4 both consume it), and `/api/voice/speak` routing to it.

- [ ] **Step 1: Write the failing tests**

Append to `voice_proxy.test.ts`, following the file's existing fake-provider pattern (a second recording server stands in for the TTS host):

1. `speak posts to ttsEndpoint when one is configured` — config has `endpoint: <sttUrl>/v1`, `ttsEndpoint: <ttsUrl>/v1`, `ttsModel`; assert the **tts** server received `/v1/audio/speech` and the stt server received nothing.
2. `transcribe still posts to endpoint when a ttsEndpoint is configured` — mirror assertion.
3. `speak sends ttsApiKey, never the stt apiKey` — config has both `apiKey: 'stt-secret'` and `ttsApiKey: 'tts-secret'`; assert the received `authorization` header is `Bearer tts-secret`.
4. `speak sends no authorization when ttsEndpoint has no key` — `apiKey` set, `ttsApiKey` unset ⇒ no `authorization` header on the tts server.
5. `speak still uses endpoint when no ttsEndpoint is configured` — regression guard for the default path.

- [ ] **Step 2: Verify they fail**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_proxy.test.ts
```
Expected: the 5 new tests fail (synthesis still goes to `endpoint`); the pre-existing ones pass.

- [ ] **Step 3: Implement**

1. `packages/types/src/index.ts` — add to `VoiceConfig`, after `ttsModel`:

```ts
  /** Synthesis endpoint. Unset ⇒ synthesis uses `endpoint` (one server does
   *  both — the Speaches case). Set ⇒ /audio/speech goes here instead, e.g. a
   *  local openai-edge-tts container for Microsoft Neural voices. */
  ttsEndpoint?: string;
  /** Encrypted at rest, like `apiKey`. Only read when `ttsEndpoint` is set —
   *  the transcription key is never sent to a third-party synthesis host. */
  ttsApiKey?: string;
```
Also refresh the type's leading doc comment (it currently asserts one base URL serves both) and point it at the new design doc.

2. `packages/cli/src/store/json.ts` — next to the existing `c.voice?.apiKey` block:

```ts
  if (c.voice?.ttsApiKey && !isEncrypted(c.voice.ttsApiKey)) {
    c.voice.ttsApiKey = encrypt(c.voice.ttsApiKey);
  }
```

3. `voice_proxy.ts` — split the header helper so a key can be passed explicitly, and add the resolver:

```ts
export function authHeaders(apiKey: string | undefined | null): Record<string, string> {
  const key = plainKey(apiKey);
  return key ? { authorization: `Bearer ${key}` } : {};
}

export function voiceAuthHeaders(voice: VoiceConfig): Record<string, string> {
  return authHeaders(voice.apiKey);
}

/** Where synthesis goes. A configured `ttsEndpoint` takes its own key — or
 *  none at all: the transcription key belongs to a different host. */
export function ttsTarget(voice: VoiceConfig): { endpoint: string; apiKey?: string } {
  const tts = voice.ttsEndpoint?.trim();
  if (!tts) return { endpoint: voice.endpoint, apiKey: voice.apiKey };
  return { endpoint: tts, ...(voice.ttsApiKey ? { apiKey: voice.ttsApiKey } : {}) };
}
```
In the speak route, replace `voice.endpoint` with `ttsTarget(voice).endpoint` and `voiceAuthHeaders(voice)` with `authHeaders(target.apiKey)`.

- [ ] **Step 4: Verify**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_proxy.test.ts
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: all tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/index.ts packages/cli/src/store/json.ts packages/cli/src/cli/web/voice_proxy.ts packages/cli/src/cli/web/voice_proxy.test.ts
git commit -m "feat(cli): route voice synthesis to an optional separate TTS endpoint"
```

---

### Task 3: Managed backends — two containers, one target-parameterized module

**Files:**
- Modify: `packages/cli/src/cli/web/voice_backend.ts` (whole module)
- Modify: `packages/cli/src/cli/web/voice_backend.test.ts` (existing tests keep passing; append new ones)
- Modify: `packages/webview-ui/src/voice_backend_utils.ts` (mirror the status type + add the statuses envelope; it is a hand-kept mirror, see its header comment)

**Interfaces:**
- Consumes: `ttsTarget` (Task 2), `loopbackPort`, `containerState`, the injected `BackendDeps`.
- Produces: `type Target = 'stt' | 'tts'`; `probeBackends(voice): Promise<{ stt: BackendStatus; tts: BackendStatus | null }>`; `startBackend(voice, target)`, `stopBackend(target)`, `deleteBackend(target)`; routes `GET /api/voice/backend` (envelope) and `POST /api/voice/backend/{start,stop,delete}?target=`. Task 5's UI consumes all of it.

- [ ] **Step 1: Write the failing tests**

Append to `voice_backend.test.ts`, reusing its `setVoiceBackendDepsForTest` / fake-ready-server helpers:

1. `GET /api/voice/backend reports both targets` — config with `ttsEndpoint` on a different loopback port ⇒ body has `stt.port` and `tts.port` distinct, and the fake `containerState` is asked for **both** `caretaker-speaches` and `caretaker-edge-tts`.
2. `GET /api/voice/backend reports tts: null with no ttsEndpoint` — regression guard for the single-endpoint setup.
3. `start?target=tts runs the edge-tts image and skips the model install` — record `runContainer` argv: contains `caretaker-edge-tts`, the edge image, `-p 127.0.0.1:<ttsPort>:<internalPort>`, no HF volume; and no `POST /models/...` reached the fake server.
4. `start?target=tts is not blocked by an in-flight stt start` — gate the stt pull as the existing 409 test does, then start tts and assert it proceeds (per-target guard).
5. `stop?target=tts / delete?target=tts act on caretaker-edge-tts` and the same routes without `?target` still act on `caretaker-speaches` (default = stt).
6. `delete?target=tts answers 409 only while the tts start is in flight`.

- [ ] **Step 2: Verify they fail**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_backend.test.ts
```

- [ ] **Step 3: Implement**

In `voice_backend.ts`:

1. Replace the `CONTAINER_NAME` / `IMAGE` / `VOLUME` constants with the spec table (fill `internalPort`, `extraRunArgs`, `readyPath` from **Task 1's findings**):

```ts
export type Target = 'stt' | 'tts';

type BackendSpec = {
  container: string;
  image: string;
  internalPort: number;
  extraRunArgs: string[];
  /** Appended to the endpoint for the readiness probe. */
  readyPath: string;
  /** Speaches must be told to fetch models; edge-tts ships its voices. */
  installsModels: boolean;
  pullNote: string;
};

// ponytail: the TTS target's backend is inferred, not configured — there is
// exactly one alternative synthesis backend, so `ttsEndpoint` being set is the
// same fact as "run edge-tts there". Persist a kind on VoiceConfig when a
// second alternative appears.
const SPECS: Record<Target, BackendSpec> = {
  stt: { container: 'caretaker-speaches', image: 'ghcr.io/speaches-ai/speaches:latest-cpu', internalPort: 8000, extraRunArgs: ['-v', 'caretaker-hf-hub-cache:/home/ubuntu/.cache/huggingface/hub'], readyPath: '/models', installsModels: true, pullNote: 'first run downloads about 2 GB' },
  tts: { container: 'caretaker-edge-tts', image: 'travisvn/openai-edge-tts:latest', internalPort: /* Task 1 */ 5050, extraRunArgs: [/* Task 1: the auth-off env switch */], readyPath: /* Task 1 */ '/voices', installsModels: false, pullNote: 'a small image, a few hundred MB' },
};
```
Keep the module header comment accurate: it currently says "Speaches container"; it now manages two, one per target, and still never rewrites an endpoint.

2. Add `function targetEndpoint(voice, target)` returning `voice.endpoint` for `'stt'` and `ttsTarget(voice).endpoint` for `'tts'`, plus a `targetAuth(voice, target)` for the headers. Thread `(voice, target)` through `probeBackend`, `runArgs`, `pollReady`, `startBackend`, `stopBackend`, `deleteBackend` — every place that reads `CONTAINER_NAME`/`IMAGE`/`'/models'` reads `SPECS[target]` instead.

3. `probeBackends(voice)`: `{ stt: await probeBackend(voice, 'stt'), tts: voice.ttsEndpoint?.trim() ? await probeBackend(voice, 'tts') : null }`.

4. Model install: wrap the existing loop in `if (spec.installsModels)`. It stays exactly as documented (`POST /models/<id>` unencoded, 409 = success) for Speaches.

5. Replace `let backendStarting = false` with `const starting = new Set<Target>()`; `isBackendStartInFlightForTest(target: Target = 'stt')` reads it. The check-and-add stay adjacent with no `await` between them, as today's comment requires.

6. Routes: parse the target once —

```ts
function reqTarget(c: Context): Target {
  return c.req.query('target') === 'tts' ? 'tts' : 'stt';
}
```
`GET /api/voice/backend` answers `probeBackends(config.voice ?? emptyVoice)`; the mutating routes keep their present contracts (200 + re-probed **single-target** `BackendStatus`, 409 while that target's start is in flight, never a 500 for an already-done action), and `start` refuses `target=tts` with the existing non-loopback error wording when `ttsEndpoint` is unset or not loopback.

7. `runAutoStart`: loop `for (const target of ['stt', 'tts'])`, skipping a target whose endpoint is missing or non-loopback; prefix each log line with the target so the two containers are distinguishable in the server log.

8. Mirror `BackendStatus` unchanged and add `export type BackendStatuses = { stt: BackendStatus; tts: BackendStatus | null }` in `packages/webview-ui/src/voice_backend_utils.ts` (hand-kept mirror — keep the header comment's promise true).

- [ ] **Step 4: Verify**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_backend.test.ts
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: new and pre-existing tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/voice_backend.ts packages/cli/src/cli/web/voice_backend.test.ts packages/webview-ui/src/voice_backend_utils.ts
git commit -m "feat(cli): manage a second voice container for the TTS endpoint"
```

---

### Task 4: Catalogue — `/voices` fallback and a per-target fetch

**Files:**
- Modify: `packages/cli/src/cli/web/voice_proxy.ts` (`fetchVoiceCatalog` ~line 138)
- Modify: `packages/webview-ui/src/bridge.ts` (`fetchVoiceModels`, `voiceModelsFetched`, `parseViewToHost`)
- Modify: `packages/cli/src/cli/web/server.ts` (~line 1185 `fetchVoiceModels` case)
- Test: `packages/cli/src/cli/web/voice_proxy.test.ts` (append)

**Interfaces:**
- Produces: `VoiceCatalog` filled from `/voices` when `/models` yields no per-model voices; `ViewToHost.fetchVoiceModels.target?: 'stt' | 'tts'` echoed on `HostToView.voiceModelsFetched.target`.

- [ ] **Step 1: Write the failing tests**

Add fake endpoints to the existing catalogue servers in `voice_proxy.test.ts` and assert:

1. `fetchVoiceCatalog fills voices from /voices when /models reports none` — using the **exact** body shape recorded in Task 1; assert every `tts[].voices` contains the italian id.
2. `fetchVoiceCatalog keeps per-model voices when /models already has them` — the Speaches path must not call `/voices` at all (assert the fake never received it).
3. `fetchVoiceCatalog ignores a failing or unparseable /voices` — 404 / `{}` / HTML ⇒ same result as today (free-text degradation), no throw.

- [ ] **Step 2: Verify they fail**, same command as Task 2 Step 2.

- [ ] **Step 3: Implement**

In `fetchVoiceCatalog`, after the existing task-splitting loop and before the return, when `tts.every((m) => m.voices.length === 0)`:

```ts
  // openai-edge-tts publishes its voices here rather than per model. Best
  // effort by design: an endpoint without the route degrades to the free-text
  // voice field, which already works.
  const extra = await fetchVoiceList(endpoint, key);   // returns [] on any failure
  if (extra.length > 0) for (const m of tts) m.voices = extra;
```
`fetchVoiceList` is a small local helper: GET `<endpoint>/voices`, `try/catch` everything, accept both a bare array and a `{ voices: [...] }` envelope, accept both strings and objects (`id`/`name`/`ShortName` per Task 1's finding, plus `language`/`Locale` and `gender`/`Gender` when present), and drop anything without an id.

Bridge + server: add the optional `target` to the request and response messages (strict parse: only `'tts'` sets it, anything else is `undefined`), and pass it through in the `fetchVoiceModels` case unchanged otherwise.

- [ ] **Step 4: Verify**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/voice_proxy.test.ts
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/voice_proxy.ts packages/cli/src/cli/web/voice_proxy.test.ts packages/webview-ui/src/bridge.ts packages/cli/src/cli/web/server.ts
git commit -m "feat(cli): read a TTS endpoint's /voices catalogue when models carry none"
```

---

### Task 5: Voice settings tab — synthesis endpoint fields, prefill, two backend blocks

**Files:**
- Create: `packages/webview-ui/src/VoiceBackendBlock.tsx`
- Modify: `packages/webview-ui/src/VoiceTab.tsx`

**Interfaces:**
- Consumes: `GET /api/voice/backend` envelope + `?target=` routes (Task 3), `voiceModelsFetched.target` (Task 4).
- Produces: nothing consumed later.

No component unit tests — the file's established pattern is to test pure logic in `voice_backend_utils.ts` only; verification is build + typecheck + the manual check in Task 6.

- [ ] **Step 1: Extract `VoiceBackendBlock`**

Move the existing block verbatim into `VoiceBackendBlock.tsx` with props
`{ target: 'stt' | 'tts'; label: string; status: BackendStatus; onStatus: (s: BackendStatus) => void; onRefresh: () => void; hint: string }`.
Everything currently local to the block moves with it (`backendBusy`, `backendProgress`, `backendError`, `confirmingDelete` + its timer, `lastContainer`, the NDJSON drain loop, the "clear the error only on a stopped→running transition" rule and its comment). Its fetches append `?target=${target}`. Keep the `showBackendBlock` predicate (`docker !== 'absent' && port !== null`) in the parent, per status.

- [ ] **Step 2: Parent wiring in `VoiceTab.tsx`**

- One poll of `/api/voice/backend` → `BackendStatuses | null`; render `<VoiceBackendBlock target="stt" label="Speech backend (Speaches)" …/>` and, when `statuses.tts` passes the predicate, `target="tts" label="Synthesis backend (edge-tts)"`. `null` statuses ⇒ nothing rendered, which is still what hides the whole thing in the VSCode sidebar.
- Keep the single `autoStartBackend` checkbox in the parent (it covers both containers) and move its help text there.
- New state `ttsEndpoint` / `ttsApiKey`, saved in `save()` with the same trim-and-omit-if-empty rule as the other optional fields.
- Second prefill button, shown when `!ttsEndpoint.trim()`: sets `ttsEndpoint` `http://127.0.0.1:5050/v1` (use Task 1's verified port), `ttsModel` `tts-1`, `ttsVoice` `it-IT-ElsaNeural`. Copy the existing button's "nothing is saved yet, press Save" wording.
- Two `<small>` help lines to write: the synthesis endpoint ("leave empty when one server does both; a local openai-edge-tts container gives you Microsoft Neural voices such as it-IT-ElsaNeural, but cannot transcribe — transcription always uses the endpoint above") and the synthesis key ("stored encrypted; the transcription key is never sent here").
- Fetch models: pass `target: 'tts'` when fetching against the synthesis endpoint, and keep the two catalogues in separate state so the transcription list is not overwritten by the TTS host's. The synthesis model/voice `<select>`s read the TTS catalogue, the transcription `<select>` the STT one.

- [ ] **Step 3: Verify**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/webview-ui/src/VoiceBackendBlock.tsx packages/webview-ui/src/VoiceTab.tsx
git commit -m "feat(webview): configure and manage a separate synthesis backend"
```

---

### Task 6: Docs, compose file, changeset, end-to-end check

**Files:**
- Modify: `CLAUDE.md` (§6 Voice Mode: "Config & security", "Server proxies", "Catalogue discovery", "Managed local backend", "Backend API", "Auto-start")
- Modify: `README.md` (voice section — locate with `grep -n -i 'speaches\|voice' README.md`)
- Modify: `docker-compose.voice.yml` (add an `edge-tts` service on 5050, matching the managed container's env)
- Create: `.changeset/voice-edge-tts-backend.md`

- [ ] **Step 1: `CLAUDE.md`**

Update §6 to describe *current* behaviour (no history): one endpoint by default, `ttsEndpoint`/`ttsApiKey` splitting synthesis off (and why the transcription key is never reused); `/api/voice/speak` resolving its host through `ttsTarget`; the `/voices` fallback in `fetchVoiceCatalog`; the managed backend being a **two-entry spec table keyed by target** with the endpoint still the source of truth, the per-target start guard, the model-install step being Speaches-only, and edge-tts being inferred from `ttsEndpoint` rather than configured; the `GET /api/voice/backend` envelope and `?target=` on the mutating routes; one `autoStartBackend` flag covering both containers. Add the edge-tts GPL-3.0 note (arms-length over HTTP, no redistribution).

- [ ] **Step 2: `README.md`**

Add a short "Better Italian voices" paragraph to the voice section: set the synthesis endpoint to `http://127.0.0.1:5050/v1`, model `tts-1`, voice `it-IT-ElsaNeural` or `it-IT-DiegoNeural`, press Save, then Start on the synthesis backend block; transcription keeps using Speaches. Mention the second container name (`caretaker-edge-tts`) and that Delete/Stop work per backend.

- [ ] **Step 3: `docker-compose.voice.yml`**

Add the `edge-tts` service (image, `127.0.0.1:5050:<internalPort>`, the auth-off env from Task 1, `restart: unless-stopped` to match the existing service). Note in a comment that a compose-started container is adopted by the managed Start when the name matches.

- [ ] **Step 4: Changeset**

`.changeset/voice-edge-tts-backend.md`, all five packages `minor`, describing: optional separate synthesis endpoint + key, managed `caretaker-edge-tts` container with per-target start/stop/delete, `/voices` catalogue fallback, and the new settings fields.

- [ ] **Step 5: Full verification**

```bash
pnpm test
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm build
```
Then manually, with Docker (`pnpm -F @hyperwindmill/caretaker-cli dev web`, Settings → Voice):
1. With only `endpoint` set, everything behaves exactly as before (one backend block, dictation + conversation work).
2. Prefill the synthesis endpoint, Save ⇒ a second block appears; Start pulls and runs `caretaker-edge-tts`; status goes to running.
3. Fetch models against the synthesis endpoint ⇒ the voice field offers `it-IT-*` ids.
4. Conversation mode: the reply is spoken with the Edge voice; dictation still transcribes through Speaches (`docker logs caretaker-speaches` shows the transcription hits).
5. Stop / Delete on the synthesis block touch only `caretaker-edge-tts` (`docker ps -a`), and Start on the other block still works while the first is starting.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docker-compose.voice.yml .changeset/voice-edge-tts-backend.md
git commit -m "docs: document the alternative edge-tts synthesis backend"
```
