# Built-in local transcription (Whisper on ONNX)

## Why

Voice mode needs a transcription endpoint today, which in practice means running
the Speaches container (Docker). The built-in synthesis engine
(`2026-11-07-local-voice-engine-design.md`) already downloads an ONNX runtime on
demand; the same runtime can run Whisper. With both built-in engines, voice mode
needs no Docker and no external service at all.

This is an **additional, opt-in transcription engine** next to the existing
endpoint, the same way the built-in voice sits next to the synthesis endpoint.
Nothing changes for a config that does not select it.

## Goals

- `sttEngine: 'builtin'` transcribes in process with Whisper (ONNX), model and
  runtime downloaded from Settings → Voice.
- Selectable model size: `tiny`, `base` (default, recommended), `small`.
- Works with no transcription endpoint configured.
- Same conversation and dictation behaviour as today: record the whole
  utterance, then transcribe it.

## Non-goals (explicitly later)

- Live partial transcripts, speculative transcription on a pause, any VAD or
  turn-taking change.
- Streaming (transducer) models, GPU, translation, timestamps.
- VSCode sidebar / TUI voice (unchanged surface matrix).

## Measurements that fix the design (spike, Ryzen 5 1600X, 6 threads)

Our own pipeline (log-mel in TypeScript, greedy decoding on the merged decoder)
on the caretaker-downloaded `onnxruntime-node` 1.31.1. Log-mel features match
faster-whisper's extractor to 3.8e-6.

| model (int8 encoder + q4 decoder) | 4–5 s utterance | 22 s clip | load | RSS loaded | download |
|---|---|---|---|---|---|
| tiny | ~0.35 s | ~0.9 s | 1.0 s | ~440 MB | ~41 MB |
| base | ~0.70–0.76 s | ~1.6 s | 1.4 s | ~575 MB | ~147 MB |
| small | ~2.2 s | ~4.0 s | 2.7 s | ~950 MB | ~250 MB |
| Speaches (faster-whisper-small, today) | ~4.2 s | ~7.4 s | — | — | container |

Quality in Italian: small ≈ Speaches word for word; base gets the meaning right
with errors on proper nouns and English loanwords; tiny is clearly worse.

Non-obvious findings the implementation must honour:

- **The int8 decoder is the slow one** on a CPU without VNNI (~2.5× slower per
  token than q4 or fp32); encoder speed is the same across variants. Ship
  `encoder_model_quantized.onnx` + `decoder_model_merged_q4.onnx`.
- **The encoder always processes a 30 s window** (the stock export rejects a
  shorter input), so its cost is the latency floor (~0.47 s for base) whatever
  the utterance length. Longer audio needs windowing.
- Encoder speed scales with threads (6 > 4); decoder speed does not (per-op
  overhead).

Reference implementation (throwaway, reading only): the spike's
`whisper.mjs` in the session scratchpad
(`…/scratchpad/whisper-spike/scripts/whisper.mjs`), with the bench data next to
it.

## Design

### 1. Config contract

`VoiceConfig` gains:

```ts
/** Transcription engine. Unset or 'endpoint' ⇒ POST <endpoint>/audio/transcriptions
 *  (today). 'builtin' ⇒ in-process Whisper; endpoint/sttModel unused for it. */
sttEngine?: 'endpoint' | 'builtin';
/** Built-in transcription only: Whisper size. Unset ⇒ 'base'. */
sttBuiltinModel?: 'tiny' | 'base' | 'small';
```

- `resolveVoice` stops requiring `endpoint` when `sttEngine === 'builtin'`.
- `VoiceClientConfig.configured` becomes "transcription is configured for the
  selected engine": `sttEngine === 'builtin'` ⇒ true; otherwise today's
  endpoint check. `VoiceClientConfig` also carries `sttEngine` so the renderer
  knows to send PCM (§3).
- A built-in model that is not installed answers the transcribe route with
  **409** and a readable message, like the built-in voice.

### 2. Install

- Catalog: Hugging Face `onnx-community/whisper-{tiny,base,small}`, each pinned
  to a revision, sha256 + size per file. Files per size:
  `onnx/encoder_model_quantized.onnx`, `onnx/decoder_model_merged_q4.onnx`,
  `vocab.json`, `added_tokens.json`, `generation_config.json`,
  `preprocessor_config.json`, `config.json`. Weights: OpenAI Whisper, MIT;
  ONNX export by onnx-community.
- Stored under `voice/whisper/<size>/<revision>/`, tmp + rename, idempotent,
  same downloader as the Pocket bundles.
- **Shared runtime:** the runtime is installed by whichever built-in engine is
  installed first; deleting the last built-in model of **either** engine
  removes it (still never while loaded in-process). Today's rule only counts
  Pocket bundles — it must count Whisper models too.
- Status and routes extend the existing ones: `BuiltinVoiceStatus` gains
  `stt: Array<{ id: 'tiny'|'base'|'small'; installed: boolean; bytes: number }>`;
  install/delete accept `?stt=<size>` as the alternative to `?language=<id>`.
  The single install/delete guard covers both.

### 3. Audio into the engine

The renderer records `audio/webm;codecs=opus` (MediaRecorder) for both modes.
The server has no opus decoder and must not get one. So, **only when
`sttEngine === 'builtin'`**, the renderer decodes the blob with
`decodeAudioData`, downmixes to mono, resamples to 16 kHz with an
`OfflineAudioContext`, and uploads a 16-bit PCM WAV in the same `file` part of
the same route. The endpoint engine keeps uploading webm exactly as today.

### 4. Engine

`packages/cli/src/voice/whisper/`:

- WAV parsing (16 kHz mono PCM16 only; anything else is a 400).
- Log-mel: n_fft 400, hop 160, Hann, 80 Slaney mel bins computed in code
  (the export ships no filterbank), log10 clamp to max − 8, `(x + 4) / 4`,
  padded to 3000 frames.
- Greedy decoding on the merged decoder with KV cache (`use_cache_branch`),
  forced prompt `<|startoftranscript|><|lang|><|transcribe|><|notimestamps|>`,
  timestamp/special/`suppress_tokens` suppressed, stop at `<|endoftext|>` or
  224 tokens; text from `vocab.json` through the GPT-2 byte decoder.
- Language: the primary subtag of `voice.lang` when it is a Whisper language,
  else auto-detected from the first decoder step (argmax over the language
  tokens).
- Audio over 30 s (long dictation): split into ≤ 30 s windows, each cut at the
  quietest 0.5 s within its last 5 s, transcribed in order, texts joined.
- One warm model at a time (switching size releases the other), calls
  serialized, `intraOpNumThreads` = physical cores. Same event-loop caveat as
  the built-in voice (synchronous graph calls; a worker thread is the upgrade
  path).
- The route returns `{ text }` like an OpenAI-compatible endpoint, so the
  renderer's handling of the response is unchanged.

### 5. Voice tab

- Transcription engine switch (endpoint / built-in), showing only the relevant
  fields.
- Built-in transcription block: model picker tiny / base / small with size and
  installed state, Install / Delete with ndjson progress (same pattern as the
  built-in voice block), "recommended" on base, a note that small is slow for
  conversation on most CPUs, credit and licence.
- The "Built-in voice" preset becomes the fully local preset: built-in
  synthesis **and** built-in transcription (base). Presets still only prefill.

## Executor's calls

- Model size is a per-config choice, not per mode (dictation and conversation
  use the same model).
- No first-run benchmark to choose between int8 and q4 decoders: q4 is measured
  faster here and is not slower anywhere we know of. A machine where int8 wins
  is a later optimisation.
- Windowing for > 30 s is in scope because dictation can exceed it and the
  stock encoder cannot.
