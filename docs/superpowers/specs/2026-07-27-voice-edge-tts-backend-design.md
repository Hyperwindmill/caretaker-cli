# Voice: openai-edge-tts as an alternative managed TTS backend — Design

**Status:** accepted (planning, task 26)
**Related:** `docs/superpowers/specs/2026-07-25-voice-mode-design.md`,
`docs/superpowers/specs/2026-07-26-voice-managed-backend-design.md`,
`docs/superpowers/specs/2026-07-27-voice-backend-delete-design.md`

## Problem

Voice mode assumes **one** OpenAI-compatible speech endpoint serving both
transcription and synthesis, and the managed local backend is hardcoded to
Speaches (`ghcr.io/speaches-ai/speaches:latest-cpu`, container
`caretaker-speaches`, HF cache volume). Speaches' Italian voices (Kokoro
`im_nicola`, Piper `paola`) are not good enough for some users.

[openai-edge-tts](https://github.com/travisvn/openai-edge-tts)
(`travisvn/openai-edge-tts:latest`) wraps Microsoft Edge's Neural voices
(`it-IT-ElsaNeural`, `it-IT-DiegoNeural`, …) behind an OpenAI-compatible
`POST /v1/audio/speech`. It is **TTS only** — no transcription. So it cannot
replace Speaches, only the synthesis half of it.

License: the container is GPL-3.0; caretaker talks to it over HTTP and
redistributes none of its code, so this is arms-length use, not a derivative
work. Nothing to do beyond attribution in the docs.

## Decision

Split synthesis from transcription **by endpoint**, and teach the managed
backend to manage two containers instead of one.

### 1. Config: one optional endpoint override, no backend enum

`VoiceConfig` gains two optional fields:

```ts
  /** Synthesis endpoint. Unset ⇒ synthesis uses `endpoint` (one server does
   *  both, the Speaches case). Set ⇒ /audio/speech goes here instead. */
  ttsEndpoint?: string;
  /** Encrypted at rest, like `apiKey`. Only used with `ttsEndpoint`. */
  ttsApiKey?: string;
```

`endpoint` / `apiKey` / `sttModel` keep their present meaning and stay the
transcription source of truth. `ttsModel` / `ttsVoice` / `ttsSpeed` keep
theirs; they simply address whatever endpoint synthesis resolves to (for
edge-tts: `ttsModel: 'tts-1'`, `ttsVoice: 'it-IT-ElsaNeural'`).

**No persisted `backendType` enum.** There is exactly one alternative TTS
backend, so the managed-container spec for the TTS target is edge-tts by
construction: `ttsEndpoint` set + loopback ⇒ offer to run edge-tts there. The
inference is marked in code with a `ponytail:` comment naming the upgrade path
(persist a kind field when a second alternative appears). Reasons: an enum
whose value is derivable from a field the user must set anyway is a second
source of truth for the same fact, and every branch that reads it has to
handle the incoherent combinations.

Auth: synthesis sends `Authorization: Bearer <ttsApiKey>` when `ttsEndpoint`
is set, and **nothing** when it is set without a key — never the Speaches
`apiKey`, which must not leak to a third-party TTS host. Keeping the key field
(rather than dropping auth for the TTS leg) also buys the "local Speaches for
STT + api.openai.com for TTS" combination for free.

### 2. Proxy routing

`voice_proxy.ts` gains one resolver:

```ts
export function ttsTarget(voice: VoiceConfig): { endpoint: string; apiKey?: string }
```

`POST /api/voice/speak` uses it; `POST /api/voice/transcribe` is untouched.
Everything else about the two routes — verbatim upstream error propagation,
the `model`/`voice`/`speed` payload — is unchanged, which is why edge-tts
needs no request adapter: it is OpenAI-compatible on that route.

### 3. Managed backends: a two-entry registry keyed by target

`voice_backend.ts` becomes target-parameterized (`type Target = 'stt' | 'tts'`)
over a table:

```ts
type BackendSpec = {
  container: string;       // caretaker-speaches | caretaker-edge-tts
  image: string;
  internalPort: number;    // published as 127.0.0.1:<endpointPort>:<internalPort>
  extraRunArgs: string[];  // -v <volume> for Speaches, -e … for edge-tts
  readyPath: string;       // appended to the endpoint for the readiness probe
  installsModels: boolean; // Speaches must be told to fetch; edge-tts ships its voices
  pullNote: string;        // the "about 2 GB" line, per image
};
```

Invariants carried over unchanged: **the configured endpoint is the source of
truth** (the port is parsed out of it, never invented, never rewritten); the
affordance exists only for loopback endpoints; start is idempotent (adopt a
container already running under that name); stop is `docker stop` only; delete
is `docker rm -f` and never touches volumes or images; a failed step never
rolls back the earlier ones.

Two things become per-target rather than global:

- the in-flight start guard (`Set<Target>` instead of a boolean) — starting
  edge-tts must not be refused because a 2 GB Speaches pull is running;
- the model-install step, which only Speaches has.

HTTP surface:

- `GET /api/voice/backend` → `{ stt: BackendStatus, tts: BackendStatus | null }`
  (`tts: null` when no separate `ttsEndpoint` is configured). Shape change, not
  an added route: the webview polls once and renders one block per non-null
  entry. Server and webview ship in the same version, and the VSCode sidebar
  keeps hiding the block by the same mechanism (the fetch fails there).
- `POST /api/voice/backend/{start,stop,delete}?target=stt|tts`, default `stt`.

Auto-start stays **one** flag (`autoStartBackend`): the user wants voice
working at boot, not per-container choreography. `runAutoStart` iterates the
configured targets.

### 4. Catalogue

`fetchVoiceCatalog(endpoint, apiKey)` keeps its `/models` logic and gains one
fallback: when no TTS entry came back with voices, try `GET <endpoint>/voices`
and attach whatever it lists to every TTS model entry. edge-tts publishes its
voice list there; an endpoint that 404s or answers something unparseable
degrades exactly as today (free-text voice field), which is already a working
path — the user types `it-IT-ElsaNeural`.

The settings form's Fetch button fetches per endpoint: the TTS endpoint's
catalogue populates the synthesis model/voice fields, the STT endpoint's the
transcription field. `ViewToHost.fetchVoiceModels` therefore gains an optional
`target: 'stt' | 'tts'` echoed back on `voiceModelsFetched` so the view can
keep the two results apart.

### 5. UI

- New optional **Synthesis Endpoint** + **Synthesis API Key** fields, with a
  prefill button ("Use Microsoft Edge voices") next to the existing "Use local
  defaults" one: `http://127.0.0.1:5050/v1`, `tts-1`, `it-IT-ElsaNeural`. A
  prefill button, not a backend `<select>` with branching defaults — the tab
  already establishes that pattern and the persisted state is just the fields.
- The managed-backend block is extracted into `VoiceBackendBlock.tsx` and
  rendered once per non-null status, labelled ("Speech backend (Speaches)" /
  "Synthesis backend (edge-tts)"). Extraction rather than duplication: the
  block owns busy/progress/error/confirm-delete state that must not be shared
  between the two containers. The single auto-start checkbox stays in the
  parent, as does the single status poll.

## Non-goals

- **A TTS-only setup.** `endpoint`/`sttModel` stay required; edge-tts adds a
  synthesis option, it does not make transcription optional. Dictation is the
  primary voice affordance.
- A third backend, a plugin registry of backends, or user-editable images.
- Per-container auto-start flags.
- Streaming synthesis, voice preview in the settings tab.

## To verify empirically before coding

The plan's first task runs the container and reads its API rather than
trusting documentation from memory (project convention: verify formats from
real artifacts). Unknowns: the internal port (expected 5050), whether
`/v1/models` exists, the exact `/v1/voices` response shape, and the env var
that disables the default API-key requirement (expected
`REQUIRE_API_KEY=False`). The constants and the `/voices` parser are written
from what the container actually answers.
