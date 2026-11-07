# Built-in Local Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in in-process Whisper transcription engine (`sttEngine: 'builtin'`), model and runtime downloaded on demand, so voice mode needs no Docker.

**Architecture:** Mirrors the built-in voice. `packages/cli/src/voice/whisper/` holds the catalog, WAV parsing, log-mel features, the greedy decoder loop and the engine; the installer and routes from `voice/pocket/install.ts` / `cli/web/voice_builtin.ts` are extended to Whisper models and a runtime shared by both engines. The renderer converts its recording to 16 kHz PCM WAV only for this engine.

**Tech Stack:** TypeScript ESM, Hono, `onnxruntime-node` (downloaded, never a dependency), Web Audio (`decodeAudioData`, `OfflineAudioContext`), React, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-07-local-transcription-engine-design.md`

## Global Constraints

- Everything in the built-in voice plan's Global Constraints applies (English code/docs, co-located tests, `CARETAKER_HOME` at file top, runtime never a package dependency, accessors resolved at call time, tmp + rename, generic terms only, never `--amend`, one commit per task).
- A config without `sttEngine` behaves exactly as today; the endpoint transcription path (webm upload, proxy) is not modified.
- Model files: `onnx/encoder_model_quantized.onnx` + `onnx/decoder_model_merged_q4.onnx` (not the int8 decoder — measured 2.5× slower per token on a CPU without VNNI).
- No behaviour change in voice mode: whole utterance recorded, then transcribed. No partial transcripts, no speculative transcription, no VAD changes.
- Reference implementation to port (read, don't import): `/tmp/claude-1000/-mnt-a341655b-7af5-403e-a435-792e0e283f08-Dev-caretaker-cli/32c1dbbe-7e45-45ad-a186-7c43eaaaeed1/scratchpad/whisper-spike/scripts/whisper.mjs` (features, FFT, Slaney filterbank, decoder loop, byte decoder); models and bench data next to it.
- Extend the existing changeset `.changeset/local-voice-engine.md` (still unreleased) with one paragraph; no new changeset.

## Review Focus

1. **Deleting the last Pocket bundle while a Whisper model is installed** (or the reverse) must keep the runtime. Test in Task 3.
2. **A WAV that is not 16 kHz mono PCM16** (wrong rate, stereo, float, truncated header) → 400 with a readable message, never a crash or garbage text. Test in Task 2.
3. **Audio over 30 s** must be fully transcribed (windowed), not truncated at 30 s. Test in Task 4.
4. **Built-in transcription with no `endpoint`** (fully local config) must work, and dictation-only configs without synthesis must too. Test in Task 2.
5. **Silence or a very short clip** (< 0.3 s, all zeros) → empty text, no hallucinated words loop past the token cap. Test in Task 4.

---

### Task 1: Whisper catalog (read-only pinning)

**Files:** Create `packages/cli/src/voice/whisper/catalog.ts`, `catalog.test.ts`.

**Interfaces — Produces:**
```ts
export type WhisperSize = 'tiny' | 'base' | 'small';
export const WHISPER_BASE_URL = 'https://huggingface.co'; // + /onnx-community/whisper-<size>/resolve/<rev>/<path>
export const WHISPER_MODELS: Readonly<Record<WhisperSize, { repo: string; revision: string; files: readonly { name: string; sha256: string; bytes: number }[] }>>;
export const DEFAULT_WHISPER_SIZE: WhisperSize = 'base';
export const WHISPER_SAMPLE_RATE = 16000;
```
`name` keeps the repo path (`onnx/encoder_model_quantized.onnx`); stored flattened by basename is the installer's call (Task 3).

- [ ] **Step 1: Failing shape test** — every size: 40-hex revision; exactly the seven spec files; sha256 64-hex; bytes > 0; default is `base`.
- [ ] **Step 2: Pin.** `curl -s https://huggingface.co/api/models/onnx-community/whisper-<size>` → `sha`; `…/tree/<sha>/onnx?expand=true` and `…/tree/<sha>?expand=true` for LFS sha256/size; small JSON files: download and `sha256sum`. Starting points (re-check): tiny `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`, base `27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c`, small `36050c46d777d46dc4b5f43f6d90574fc38f8732`. Licence note in a header comment (Whisper weights MIT, export onnx-community).
- [ ] **Step 3: Test passes. Commit** — `feat(voice): pin the Whisper ONNX catalog`

### Task 2: Config, WAV, transcribe dispatch

**Files:** Modify `packages/types/src/index.ts`, `packages/webview-ui/src/bridge.ts` (`VoiceClientConfig.sttEngine`), `packages/cli/src/cli/web/voice_proxy.ts`; create `packages/cli/src/voice/whisper/wav.ts`; tests `wav.test.ts`, extend `voice_proxy.test.ts`; extend `.changeset/local-voice-engine.md`.

**Interfaces — Produces:**
```ts
// VoiceConfig
sttEngine?: 'endpoint' | 'builtin';
sttBuiltinModel?: 'tiny' | 'base' | 'small';
// wav.ts
export function parseWav16kMono(buf: Uint8Array): Float32Array; // throws Error with a readable message otherwise
// voice_proxy.ts
export type BuiltinTranscriber = (voice: VoiceConfig, audio: Float32Array, signal: AbortSignal) => Promise<Response>; // JSON { text }
export function setBuiltinTranscriber(fn: BuiltinTranscriber | null): void;
```
- `resolveVoice` no longer requires `endpoint` when `sttEngine === 'builtin'`; `sttModel` is required only for the endpoint engine.
- `voiceClientConfig`: `configured = sttEngine === 'builtin' || <today's endpoint check>`; add `sttEngine` when set.
- `/api/voice/transcribe`: builtin ⇒ read the `file` part, `parseWav16kMono` (400 on error), call the transcriber (503 when none registered); endpoint ⇒ unchanged.

- [ ] **Step 1: Failing tests** — WAV: valid 16 kHz mono PCM16 → samples (`0x4000` → 0.5); 44.1 kHz → error naming the rate; stereo → error; float format → error; truncated → error; `data` chunk after an extra `LIST` chunk is found. Proxy: builtin with `endpoint: ''` and a stub transcriber → 200 `{ text }`; no transcriber → 503; bad WAV → 400; endpoint engine path unchanged (existing tests pass); `voiceClientConfig` builtin ⇒ `configured: true`, `sttEngine: 'builtin'`.
- [ ] **Step 2: Implement, run tests + both typechecks, commit** — `feat(voice): built-in transcription engine config and route dispatch`

### Task 3: Installer and routes for Whisper models, shared runtime

**Files:** Modify `packages/cli/src/voice/pocket/install.ts` (or extract the shared downloader/runtime part into `packages/cli/src/voice/runtime.ts` if that keeps both engines clean — executor's call, keep the diff small), `packages/cli/src/cli/web/voice_builtin.ts`, `packages/webview-ui/src/bridge.ts`; tests extend `install.test.ts`, `voice_builtin.test.ts`.

**Interfaces — Produces:**
```ts
export function whisperDir(size: WhisperSize): string;               // <dataDir>/voice/whisper/<size>/<revision>
export function installBuiltinStt(size: WhisperSize): AsyncGenerator<BuiltinInstallProgress>; // runtime (if missing) + model
export async function deleteBuiltinStt(size: WhisperSize, opts?: { keepRuntime?: boolean }): Promise<void>;
// BuiltinVoiceStatus.stt: Array<{ id: WhisperSize; installed: boolean; bytes: number }>
// routes: install/delete accept ?stt=<size> as the alternative to ?language=<id>; same single busy guard
```
- [ ] **Step 1: Failing tests** — install a fake Whisper model (stubbed fetch, sha seam) → files present, runtime installed once; **delete the last Pocket bundle while a Whisper model is installed keeps the runtime, and the reverse**; deleting the last model of both engines removes it; routes: `?stt=huge` → 400, `?stt=base` streams ndjson ending `done`, concurrent install of a voice and a model → 409, status lists `stt`.
- [ ] **Step 2: Implement, tests + typechecks, commit** — `feat(voice): install Whisper models next to the built-in voice`

### Task 4: Whisper inference

**Files:** Create `packages/cli/src/voice/whisper/features.ts`, `decoder.ts`, `inference.ts`; tests `features.test.ts`, `inference.test.ts`.

**Interfaces — Produces:**
```ts
// features.ts
export function logMel(samples: Float32Array): Float32Array; // [80 * 3000], input ≤ 30 s at 16 kHz
// decoder.ts
export function byteDecode(ids: number[], vocab: ReadonlyMap<number, string>): string;
// inference.ts
export interface WhisperModel { transcribe(audio: Float32Array, lang: string | null, signal: AbortSignal): Promise<string>; close(): Promise<void>; }
export function createWhisperModel(ort: OrtModule, dir: string, opts: { threads: number }): Promise<WhisperModel>;
export function splitWindows(audio: Float32Array, rate: number): Float32Array[]; // ≤ 30 s each, cut at the quietest 0.5 s within the last 5 s
```
Reuse `OrtModule`/`OrtSession`/`OrtTensor` from `voice/pocket/inference.ts` (move them to a shared spot only if needed).

- [ ] **Step 1: Failing tests** — features: a 440 Hz sine peaks in the expected mel bin, output length 80×3000, values within the spike's observed range; FFT/filterbank pinned by a small numeric fixture produced from the spike script (store ≤ 20 values in the test). Decoder: byte decoding of known GPT-2 pieces (`Ġ`, accented bytes). Inference with a fake runtime: forced prompt ids (`<|it|>` when lang is `it`), auto-detect picks the argmax language token when lang is null or unknown, stops at EOT, stops at 224, suppresses timestamps; `splitWindows` on 70 s → 3 windows, each ≤ 30 s, covering all samples, cut at a planted silence; all-zero 0.2 s clip → `''` via the real pipeline shape (fake decoder emitting EOT first).
- [ ] **Step 2: Implement** by porting the spike (features, Slaney filterbank, mixed-radix FFT, merged-decoder loop with `use_cache_branch`, empty past tensors `[1,H,0,64]` at step 0). Special token ids from `added_tokens.json`/`generation_config.json`, never hard-coded.
- [ ] **Step 3: Real-model check (scratch script, not committed):** with a Whisper base model installed via Task 3 into an isolated `CARETAKER_HOME`, transcribe the spike's clips; transcripts must match the spike's base output and timing must be in the spike's range (4–5 s clip ≈ 0.7 s at 6 threads).
- [ ] **Step 4: Tests + typecheck, commit** — `feat(voice): Whisper ONNX inference`

### Task 5: The built-in transcriber

**Files:** Create `packages/cli/src/voice/whisper/engine.ts`, `engine.test.ts`; modify `packages/cli/src/cli/web/voice_builtin.ts` (register).

**Interfaces — Produces:** `export const transcribeBuiltin: BuiltinTranscriber;` `setWhisperLoaderForTest`, `releaseWhisperModels()`. Uses `loadOnnxRuntime()` from `voice/pocket/engine.ts` (shared loaded runtime).

- One warm model (size switch releases the other), calls serialized, threads = physical cores (`availableParallelism()/2`, min 1), 409 naming the missing runtime or model, language from `voice.lang` primary subtag (auto when unknown), windows joined with a space, `{ text }` JSON.
- [ ] **Step 1: Failing tests** — 409 runtime / 409 model; concurrent calls serialized; model loads once per size; size switch releases the previous; > 30 s audio produces one call per window in order.
- [ ] **Step 2: Implement, tests + typecheck.**
- [ ] **Step 3: Smoke on the web server** (isolated home with base installed): `curl -F file=@clip16k.wav …/api/voice/transcribe` returns the expected text.
- [ ] **Step 4: Commit** — `feat(voice): in-process Whisper transcription`

### Task 6: Renderer and Voice tab

**Files:** Create `packages/webview-ui/src/pcm_wav.ts` (pure) + test; create `BuiltinSttBlock.tsx`; modify `useVoice.ts` (upload), `VoiceTab.tsx`, `voice_tab_presets.ts` + test, `voice_utils.ts` (`voiceSignature` covers the two new fields).

**Interfaces — Produces:**
```ts
export function encodeWavPcm16(samples: Float32Array, rate: number): Uint8Array; // mono
export async function toWav16k(blob: Blob): Promise<Blob>; // decodeAudioData → mono → OfflineAudioContext 16 kHz → encodeWavPcm16
```
- `useVoice`: when `voice.sttEngine === 'builtin'`, upload `toWav16k(blob)` as `file` (`audio.wav`); otherwise unchanged.
- Voice tab: transcription engine switch; `BuiltinSttBlock` (tiny/base/small, size, installed, Install/Delete with ndjson, recommended on base, small-is-slow note, credit + MIT); the built-in preset sets `sttEngine: 'builtin', sttBuiltinModel: 'base'` together with the built-in synthesis fields.
- [ ] **Step 1: Failing tests** — WAV header bytes (RIFF, fmt 16 kHz mono PCM16, data size), sample clamping; presets: built-in preset sets both engines; edge and local-defaults presets leave `sttEngine` unset/endpoint.
- [ ] **Step 2: Implement; `pnpm -F webview-ui typecheck && test && build` pass. Commit** — `feat(voice): built-in transcription in the Voice tab`

### Task 7: Docs and verification

- [ ] **CLAUDE.md** layer 6: transcription engine switch, renderer PCM conversion for the built-in engine only, Whisper engine (files, q4 decoder rationale, 30 s window + windowing, language auto-detect, warm model, 409), shared runtime deletion rule, state on disk `voice/whisper/`.
- [ ] **README** Voice Mode: fully local voice with no Docker (built-in voice + built-in transcription), model sizes and what they cost, credit/licence.
- [ ] `pnpm build && pnpm test` green.
- [ ] Manual (Daniele): web GUI with only built-in engines, dictation and conversation in Italian.
- [ ] **Commit** — `docs: built-in local transcription`
