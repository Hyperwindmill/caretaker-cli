# Voice mode (dictation + conversation) — design

Date: 2026-07-25
Status: implemented

## Goal

Add a voice affordance to the caretaker chat: dictate into the composer, or hold a
spoken conversation with the agent (speak → agent replies → the reply is read aloud →
the mic reopens for the next turn).

Available on the **web GUI** and the **Electron desktop app**. Not in the VSCode
sidebar, not in the TUI.

## Why the obvious approach does not work

The Web Speech API (`webkitSpeechRecognition` + `speechSynthesis`) is the cheapest
possible implementation and it is unusable here. Probed empirically against the
desktop app's own Electron (42.3.0 / Chromium 148), in a real `BrowserWindow` served
over `http://127.0.0.1` with every permission granted:

| API | present | actual result |
| --- | --- | --- |
| `SpeechRecognition` / `webkitSpeechRecognition` | yes | `start` → `audiostart` → **`error:network`** |
| `speechSynthesis` | yes | **0 voices** after `voiceschanged`, utterance → **`synthesis-failed`** |
| `getUserMedia` + `MediaRecorder` | yes | **works** — live mic track, 19 KB of opus in 1.5 s |
| `<audio>` playback | — | `canPlayType` webm/opus and mpeg both `probably` |

Recognition fails because Electron does not ship the Google speech-service API keys
that Chrome has compiled in. Synthesis fails because the Electron build does not wire
up Chromium's platform TTS integration — not for lack of a system speech stack
(speech-dispatcher and espeak-ng are present and working on the probe machine).

**Consequence for implementation:** capability detection by API *presence* is a trap
here. Both constructors exist in Electron and `'speechSynthesis' in window` is true
with zero voices. Detection must key off something that actually predicts function.

A fully in-renderer local-model stack (transformers.js Whisper + kokoro-js) was also
evaluated and rejected: `navigator.gpu.requestAdapter()` returns null on the probe
machine (no WebGPU), and `crossOriginIsolated` is false so `SharedArrayBuffer` is
unavailable, leaving single-threaded WASM. Viability would depend on the user's GPU,
which is not an acceptable basis for shipping a feature.

## Approach

caretaker bundles no speech model, exactly as it bundles no LLM. It speaks two
OpenAI-compatible audio endpoints and the user points them wherever they like —
[Speaches](https://github.com/speaches-ai/speaches) in Docker for a fully local
setup (faster-whisper for STT, Kokoro or Piper for TTS), or a cloud provider.

One code path serves both surfaces, because it is just HTTP.

The only piece that must live in caretaker is capture, endpointing, the turn loop and
playback — all in the renderer, plus two thin server proxies.

## Scope

**In:** dictation mode, conversation mode, a `voice` settings tab, the two proxy
endpoints, Silero VAD for endpointing, docs, changeset.

**Out:** VSCode sidebar, TUI, desktop widget / `globalShortcut` / always-on-top,
barge-in (interrupting the agent by speaking over it), wake word, per-agent voice
configuration, streaming partial transcripts, sentence-chunked TTS, a settings
"test voice" button, bundling any speech model.

## Configuration

New type in `packages/types/src/index.ts`:

```ts
export type VoiceConfig = {
  /** Master gate. False ⇒ no mic affordance anywhere. */
  enabled: boolean;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8000/v1 */
  endpoint: string;
  /** Encrypted at rest. */
  apiKey?: string;
  /** Transcription model id, e.g. Systran/faster-whisper-small */
  sttModel: string;
  /** Synthesis model id. Unset ⇒ conversation mode unavailable, dictation still works. */
  ttsModel?: string;
  /** Voice id for the synthesis model, e.g. af_heart */
  ttsVoice?: string;
  /** BCP-47 language tag. Unset ⇒ the renderer's navigator.language. */
  lang?: string;
};
```

Added to `CaretakerConfig` as `voice?: VoiceConfig`. Optional, so existing
`caretaker.json` files on disk keep working with no migration.

One base URL and one key are shared by STT and TTS. This covers the two realistic
setups (Speaches for both, or OpenAI for both) with half the form fields. Mixing
providers stays possible later via additive optional overrides.

The key is encrypted on save in `packages/cli/src/store/json.ts`, at the same point
where `telegramBotToken` is already encrypted — the existing mechanism, two lines.
Provider LLM keys in that file are stored in plaintext; that is a pre-existing gap
and explicitly not addressed here.

A `voice` tab is added to `packages/webview-ui/src/SettingsPanel.tsx`, joining the
`TabId` union alongside the existing six. It exposes every field above.

### Reaching the renderer

The composer needs the voice settings during normal chat, not only when the settings
panel is open, so they cannot arrive through the existing on-demand
`getSettingsData` round-trip. A new `HostToView` message carries them:

```ts
| { type: 'voiceConfig'; voice: VoiceClientConfig | null }

export type VoiceClientConfig = {
  enabled: boolean;
  /** Whether an endpoint is configured. The URL itself is not needed client-side. */
  configured: boolean;
  /** Conversation mode is offered only when true. */
  canSpeak: boolean;
  lang?: string;
};
```

Posted right after `agentsLoaded` on connect, and again whenever the config is saved.
**The API key is never included** — the renderer only ever talks to the two local
proxy endpoints, so it has no use for it. Both the web server and the VSCode host
implement this message; the VSCode host may send `null`.

There is no configuration-validation button in V1. Because a misconfiguration
therefore surfaces only at use time, error propagation (below) is load-bearing
rather than cosmetic.

## Server: two proxy endpoints

Both in `packages/cli/src/cli/web/server.ts`.

### `POST /api/voice/transcribe`

Request: `multipart/form-data` with the audio as the `file` part
(`audio/webm;codecs=opus`, the format the probe confirmed Electron produces).
Forwards to `<endpoint>/audio/transcriptions` with `model: voice.sttModel`,
`language: voice.lang` when set, and the bearer key.

Response: `{ text: string }`.

### `POST /api/voice/speak`

Request: `{ text: string }`. Forwards to `<endpoint>/audio/speech` with
`model: voice.ttsModel`, `voice: voice.ttsVoice`, and the bearer key.

Response: the upstream audio bytes with the upstream content type (`audio/mpeg`).

### Shared behaviour

- `503` with an explicit message when `voice.enabled` is false or `endpoint` is empty.
- `400` when the required model id for that endpoint is unset.
- Upstream failures propagate the upstream status and **response body verbatim**, so a
  wrong model id reads as the provider's own error instead of a generic "voice error".

Why proxy rather than calling the endpoint straight from the renderer: the API key
must never reach the browser, and a browser-to-provider request carrying a bearer key
would not survive CORS anyway. This is a trust boundary, not a preference.

## Renderer

Three new units in `packages/webview-ui/src/`, plus edits to `Composer.tsx`.

### `voice_utils.ts` — pure, tested

No DOM, no React. Holds: BCP-47 normalization from a bare language code, markdown
stripping for synthesis, extraction of the spoken text from the chat items, and the
phase transition function `nextPhase(phase, event)`.

Keeping the decision logic here is what makes it testable at all, since the repo has
no DOM test harness.

### `useVoice.ts` — the hook

Owns `MediaRecorder` capture, the VAD, the two POSTs, an `<audio>` element for
playback, and the current phase. Thin: every branch it takes comes from
`nextPhase`.

### `Composer.tsx`

A mic button plus a mode selector (dictate | conversation), placed in the existing
button row next to the current send/abort controls.

Rendered only when **all** of: `voice.enabled`, `endpoint` non-empty, and
`typeof MediaRecorder !== 'undefined'` with `navigator.mediaDevices?.getUserMedia`
present. In the VSCode sidebar the last condition fails (its webview CSP is
`default-src 'none'` and webviews are not granted a microphone), so the control is
simply absent — by capability, not by a surface check.

Conversation mode is offered only when `ttsModel` is set; otherwise the selector
shows dictation alone.

### Phase machine

The two modes differ in exactly one place: who decides the turn is over.

- **Dictation:** the user does, by clicking again. The VAD does not run. This is
  deliberate — dictating a thought involves pauses, and an automatic cut mid-pause is
  the single most annoying way for dictation to fail.
- **Conversation:** the VAD does, so the loop can run hands-free.

```
idle
  └─ mic click ──────────────────────────────────────────────→ recording

recording (dictate)
  └─ user click ────────────────────────────────────────────→ transcribing

recording (conversation)
  ├─ VAD: speech ended ─────────────────────────────────────→ transcribing
  ├─ VAD: no speech within the idle window ─────────────────→ idle
  └─ user click ────────────────────────────────────────────→ idle  (discard)

transcribing
  ├─ dictate, ok ───────────────────────────────────────────→ idle  (merge into draft)
  ├─ conversation, ok, non-empty ───────────────────────────→ awaiting  (onSend)
  ├─ conversation, ok, empty ───────────────────────────────→ recording
  └─ error ─────────────────────────────────────────────────→ idle  (surface error)

awaiting                      (the harness turn is in flight)
  ├─ turn finished, ttsModel set ───────────────────────────→ speaking
  ├─ turn finished, no ttsModel ────────────────────────────→ recording
  ├─ chat error ────────────────────────────────────────────→ idle
  └─ user click ────────────────────────────────────────────→ idle

speaking                      (<audio> playing the synthesized reply)
  ├─ audio onended ─────────────────────────────────────────→ recording
  ├─ synthesis request failed / audio onerror ──────────────→ idle  (surface error)
  └─ user click ────────────────────────────────────────────→ idle  (cancel playback)
```

Stop conditions, as specified: a silence timeout with nothing spoken, or a user click.
Nothing else keeps the loop alive.

### Three invariants

These are not stylistic; each one corresponds to a specific failure.

1. **Relisten happens on the `<audio>` element's `onended`, never on the harness
   `done` event.** Reopening the mic while the reply is still being spoken makes the
   agent transcribe itself into the next turn.

2. **`awaiting → speaking` requires `chatState.status === 'idle'` *and*
   `chatState.pendingConfirms.length === 0`.** With a confirmation pending the turn
   never completes, so a loop keyed on completion alone dies silently. A voice
   conversation with an agent that has confirm-gated tools will therefore stall at the
   confirmation and wait for a click — accepted, and documented as such.

3. **`awaiting → speaking` requires `status === 'idle'`** — the turn actually being
   over. `send-user` sets `status: 'streaming'` in the same reducer batch as the send,
   so reaching `awaiting` says nothing about completion. Advancing there speaks the
   last *completed* assistant item, which is the previous turn's reply — and on the
   very first turn there is none, so nothing is spoken at all. The symptom is
   "reads the last message, one turn late".

   Having observed `status === 'streaming'` since the send is kept as a secondary
   guard, for a surface that might send without flipping status. It cannot carry the
   invariant on its own: because status flips in the send's own batch, it is already
   true the first time the transition is evaluated.

### Text selection for synthesis

The last `ChatItem` with `kind === 'assistant'` and `streaming === false`. The
`thinking` and `tool` item kinds are separate variants in the union and are excluded
by construction. Only the final reply text is spoken; tool activity is not narrated.

## Endpointing

Silero VAD via `@ricky0123/vad-web`, which bundles the v5 and legacy ONNX weights and
depends only on `onnxruntime-web`.

Chosen over a hand-rolled RMS threshold on an `AnalyserNode` deliberately: twenty
lines of fixed-threshold detection is not a simpler version of the same thing, it is a
measurably worse one, and a false cut mid-sentence damages the conversation more than
any other single defect here. Silero's model is ~2 MB and runs acceptably in
single-threaded WASM, so it survives on hardware without WebGPU.

Concrete defaults, so the behaviour is not left to interpretation. All three are
constants in `voice_utils.ts`, not settings — they become settings only if real use
shows one value cannot serve everyone:

- **End of turn:** 1200 ms of continuous silence after speech was detected.
- **Idle window:** 10 s in `recording` with no speech detected at all ends the loop
  and returns to `idle`. This is the "stops on silence" condition.
- **Post-playback delay:** 250 ms after the audio element's `onended` before the mic
  reopens, so reverb tail on speakers does not open the next turn.

Two implementation constraints:

- **Assets are self-hosted, not CDN-loaded.** The `.onnx` weights, the
  `onnxruntime-web` `.wasm`/`.mjs` files, the VAD worklet and the library's own
  `bundle.min.js` are copied into the webview-ui build output by `esbuild.config.mjs`
  and served by the web server under `/vad/`. A CDN dependency would break offline
  use and collide with CSP.
- **The library is not bundled.** It is loaded at first voice activation by injecting
  a `<script>` tag pointing at the served `/vad/bundle.min.js`, which is the loading
  path the library documents for self-hosting. Note that a dynamic `import()` would
  *not* have achieved this: webview-ui builds a single `iife` bundle with no code
  splitting, so esbuild would inline the import and grow the bundle for every user,
  voice or not. Loading a served script also means nothing is pulled into the VSCode
  webview bundle, which builds from the same sources.

### Licensing

Verified against the npm registry and the upstream LICENSE file:

| package | version | license |
| --- | --- | --- |
| `@ricky0123/vad-web` | 0.0.30 | ISC (ricky0123) |
| bundled Silero VAD weights | v5, legacy | MIT (Silero Team) |
| `onnxruntime-web` | 1.27.0 | MIT (Microsoft) |

All permissive and compatible with incorporation into this repo's FSL-1.1-MIT terms.
The obligation is to preserve the ISC and MIT notices: the implementation adds a
third-party notices file recording all three.

## Testing

- `voice_utils.test.ts`, co-located, covering `nextPhase` across every transition
  above (including the three invariants), BCP-47 normalization, markdown stripping,
  and text selection.
- `voice_proxy.test.ts` for the two endpoints: disabled → 503, missing model → 400,
  upstream error body propagated verbatim. Follows the existing `mcp_bridge.test.ts`
  pattern.
- No test for the hook itself. The repo has no DOM harness and this feature does not
  justify introducing one; the logic worth asserting lives in the pure module.

`packages/webview-ui` currently has **no `test` script**, so its existing
`toolFormat.test.ts` is never executed by `pnpm test`. Adding
`"test": "tsx --test \"src/**/*.test.ts\""` and `tsx` to its devDependencies is part
of this work: one line, it gives the new tests a home, and it revives six orphaned
tests that pass today but nobody runs.

## Documentation and release

- `CLAUDE.md`: the `voice` config block, the two endpoints, the surface matrix, and
  the Electron Web Speech finding (so nobody re-derives it).
- `README.md`: user-facing setup, with Speaches in Docker as the recommended
  fully-local configuration.
- A changeset (minor).

## Known ceilings

Deliberate limits, with the upgrade path each would take:

- **The whole reply is synthesized in one request**, so the user waits for generation
  plus synthesis before hearing anything. Sentence-chunking the stream would fix it at
  the cost of one TTS round-trip per sentence.
- **No barge-in.** Speaking over the agent does nothing; the turn must finish or be
  clicked off. Real barge-in needs the mic open during playback plus echo handling.
- **Playback and capture never overlap**, which is what keeps echo out. On speakers
  rather than headphones, reverb tail can still bleed into the start of the next
  recording; a short delay after `onended` mitigates it.
- **A confirm-gated tool stalls the loop** (invariant 2). Voice conversations work
  best with an agent whose `confirmTools` is empty.
