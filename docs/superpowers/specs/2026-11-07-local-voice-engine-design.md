# Built-in local voice, streaming playback, pronunciation dictionary

**Date:** 2026-11-07
**Status:** design
**Surfaces:** web GUI and Electron desktop (voice is unavailable in the VSCode sidebar and TUI; unchanged)
**Packages:** `packages/cli` (voice proxy, new engine, installer), `packages/webview-ui` (Voice tab, `useVoice`), `packages/types`, `packages/desktop` (packaging only)

## Intent

Voice conversation mode has two defects today:

1. **Silence before every reply.** `useVoice.speakReply` waits for the whole
   `/api/voice/speak` response (`res.blob()`) before playing anything, so each
   spoken bubble starts only after its whole synthesis has finished.
2. **No good local synthesis.** The local options are a Docker container
   (Speaches with Kokoro/Piper, or openai-edge-tts). Edge needs Microsoft's
   online service and an image that has gone stale upstream (its `edge-tts`
   library started getting 403s from Microsoft in November 2026). Daniele
   wants synthesis that runs on the machine with nothing to install but the
   model: no Docker, no Python.

Measurements taken on Daniele's machine (Ryzen 5 1600X, no usable GPU) during
the discussion:

| Engine | Speed vs. real time (warm) | Time to first audio |
|---|---|---|
| Pocket TTS `italian`, PyTorch server | ~2× | streamed |
| Pocket TTS `italian`, ONNX INT8 via npm `pocket-tts` + `onnxruntime-node` | 1.27× | 0.35 s |
| Pocket TTS `italian_24l`, ONNX INT8 | 0.42× (too slow) | 0.83 s |
| Kokoro via Speaches | ~2× | — |

Pocket does not pronounce English words inside an Italian sentence well
("merge request", "pipeline"). Respelling them in Italian orthography fixes it
("mèrg riquèst", "pàiplain"); Daniele listened and approved this workaround.

## Goals

1. **Streaming playback for every synthesis engine.** Audio starts playing as
   soon as the first chunk arrives, for the new built-in engine and for the
   existing HTTP engines (Edge, Speaches, any OpenAI-compatible endpoint)
   whenever the upstream streams.
2. **A built-in local synthesis engine: Pocket TTS on ONNX**, running inside
   the web server process. Only the model has to be installed.
3. **Language and voice are selectable**, English included. Built-in voices
   only.
4. **A pronunciation dictionary per language.** It is applied host-side to the
   text before synthesis and edited from the Voice tab. caretaker ships a
   generic Italian list.
5. **Opt-in but highlighted.** The built-in engine is presented as the
   recommended local synthesis choice in the Voice tab, but nothing changes
   for an existing configuration until the user picks it.

## Non-goals

- Voice cloning from a user's WAV (Daniele: built-in voices only for now).
- Local transcription. STT stays exactly as it is: an OpenAI-compatible
  endpoint, Speaches by default.
- The 24-layer (`*_24l`) Pocket variants. They are slower than real time on
  the reference machine. Not offered in the UI.
- Fixing or replacing the openai-edge-tts container (its stale-image 403 is a
  separate issue; the documented workaround is `pip install -U edge-tts` in
  the container).
- Voice in the VSCode sidebar or the TUI.

## Anti-goals

- **Breaking a working setup.** A config without the new fields must behave
  exactly as today. That covers Speaches-only, Edge, and remote endpoints.
- **Reopening the mic early.** Streaming changes when audio *starts*, never
  when the mic reopens. The three voice invariants in CLAUDE.md layer 6 hold:
  the mic reopens only after the last queued bubble has *finished playing*
  and the turn is over.
- **Bloating the default install for people who never use voice.** See
  Constraints → dependency footprint.
- **Product or company names in shipped defaults.** caretaker is open source;
  the default dictionary contains generic terms only.

## Design

### 1. Engine selection (config contract)

`VoiceConfig` (`packages/types/src/index.ts`) gains:

```ts
/** Synthesis engine. Unset or 'endpoint' ⇒ today's behaviour: POST
 *  <ttsEndpoint ?? endpoint>/audio/speech. 'builtin' ⇒ the in-process Pocket
 *  TTS engine; ttsEndpoint/ttsApiKey are then ignored for synthesis. */
ttsEngine?: 'endpoint' | 'builtin';
/** Built-in engine only: Pocket language bundle, e.g. 'italian', 'english'. */
ttsLanguage?: string;
/** Pronunciation dictionary, keyed by lowercase ISO 639-1 code ('it', 'en', …).
 *  Absent ⇒ the shipped defaults for that language. Present ⇒ replaces them. */
pronunciation?: Record<string, PronunciationEntry[]>;
/** Apply the dictionary of the synthesis language before synthesis. */
pronunciationEnabled?: boolean;
```

```ts
type PronunciationEntry = { term: string; say: string };
```

For the built-in engine, `ttsVoice` holds a Pocket built-in voice name
(e.g. `giovanni`) and `ttsModel` is not used. Conversation mode is available
when `ttsEngine === 'builtin'` and the selected language bundle is installed,
even with no `ttsModel` (today `ttsModel` gates conversation mode; the gate
becomes "synthesis is configured" for whichever engine is selected). The
redacted `VoiceClientConfig` sent to the renderer must reflect that so
`canSpeak` stays correct.

**Synthesis language** (which dictionary applies): `ttsLanguage` mapped to
its ISO code for the built-in engine; otherwise the primary subtag of `lang`.
When neither is set, the renderer's `navigator.language` is the existing
fallback for `lang`, but the server has no access to it. With no language
known server-side, no dictionary applies.

### 2. Streaming playback (all engines)

**Server, `POST /api/voice/speak`** (`cli/web/voice_proxy.ts`): stop buffering
(`upstream.arrayBuffer()`). Pipe the upstream body to the client as it
arrives, preserving its `content-type`. Request a streamable format from
endpoints that support one (OpenAI-compatible APIs accept `response_format`
and Speaches supports `pcm`). Which format to request per engine is the
builder's call, made by measuring the three engines. Errors keep today's
contract: upstream error bodies are returned verbatim with their status,
before any audio byte is sent.

**Built-in engine** responds on the same route with the engine's own
streamed output (PCM or WAV chunks at the model's sample rate, 24 kHz mono for
Pocket).

**Renderer, `useVoice.speakReply`**: play from the first chunk. The builder
picks the mechanism by content type. Web Audio scheduling covers raw PCM and
WAV. Media Source Extensions or a streamed `<audio>` covers MP3, which is
what Edge returns. The contract the rest of `useVoice` relies on stays
identical:

- bubbles are spoken one at a time, in order (`queueRef` drain loop);
- "playback ended" for a bubble fires when the **last sample has played**,
  not when the response ends or the last chunk arrives;
- then `POST_PLAYBACK_MS`, then chain the next bubble or emit `playbackEnded`
  (invariant 1);
- `stopPlayback` (user stop, barge-in, mode change) cancels the in-flight
  fetch and stops audio immediately;
- a playback error goes through `fail(...)` as today.

**Fallback:** if an engine only returns a complete file, behaviour equals
today's. Playback starts once the file has arrived. No engine may regress.

### 3. Built-in engine (Pocket TTS on ONNX)

- **Runs in the web server process** (therefore in the desktop app too). It
  is loaded lazily on the first synthesis with `ttsEngine: 'builtin'`, kept
  warm per language, and released when the config switches away. Loading
  takes about 5 s, so the session must load once, not once per request.
  Concurrent requests are serialized per loaded model.
- **Languages offered:** the standard (non-24l) Pocket bundles: English,
  French, German, Spanish, Portuguese, Italian (Dutch if the chosen ONNX
  source ships it). One English bundle is enough; pick the newest stable one.
- **Voices offered:** Pocket's built-in voice names. The native one per
  language is suggested first (`giovanni` for Italian, `estelle` French,
  `lola` Spanish, `juergen` German, `rafael` Portuguese). Any built-in voice
  may be used with any language, since the voice gives the timbre and the
  model the language.
- **Speed:** honour `ttsSpeed` if the engine supports it. Otherwise ignore it
  and say so in the tab.
- **Inference code is the builder's first task (spike), with this rule:** the
  model source is fixed (Constraints → model source), so the question is only
  who drives the graphs. Use the npm `pocket-tts` package (MIT) **if** it can
  run that bundle format with its built-in voices and our downloaded runtime.
  In the measured version, local mode took a reference WAV, which is cloning,
  and used a different export. Otherwise implement the inference loop
  ourselves on `onnxruntime-node`, following the bundle's `bundle.json`
  (schema 3) and the upstream reference implementation. Either way the engine
  sits behind a small interface of our own
  (`load(language) → synthesize(text, voice) → AsyncIterable<PCM chunk>`),
  so the source can be swapped without touching the proxy or the UI.
- **Model install:** an "Install" action per language in the Voice tab.
  Download to `~/.caretaker/voice/pocket/<bundle>/<pinned-revision>/`
  (path from accessor functions resolved at call time), with sha256 per file
  pinned in our code and a tmp dir renamed into place, following the
  `acp/install.ts` pattern. The install is idempotent and shows progress the
  same way the managed voice backend does (ndjson over HTTP). A missing or
  partial bundle surfaces a clear error from `/api/voice/speak`, never a
  hang. Delete is also offered per language.
- **Attribution:** the weights are CC BY 4.0. The Voice tab and README credit
  Kyutai and link the model, and the license text is stored with the bundle.

### 4. Pronunciation dictionary

- **Applied server-side** in `/api/voice/speak`, after the renderer's
  markdown stripping, before any engine. The chat text is never changed; only
  what is spoken.
- **Matching:** case-insensitive, whole-word (a term never matches inside a
  longer word), longest term first so `merge request` wins over `request`.
  Entries are literal strings, not regexes. Pure function, unit-tested.
- **Scope:** the dictionary of the synthesis language (§1), for every engine,
  when `pronunciationEnabled` is true. Presets set it (§5): on for the
  built-in engine, off for Edge, whose Italian voices already pronounce
  English terms well.
- **Shipped Italian defaults** (generic terms only, values from Daniele's
  listening tests):

| term | say |
|---|---|
| merge request | mèrg riquèst |
| pull request | pùl riquèst |
| pipeline | pàiplain |
| deploy | diplòi |
| branch | brènc |
| feature | fìciar |
| build | bìld |
| review | riviù |
| stage | stèij |

  Other languages ship empty.
- **Editing:** a table in the Voice tab for the current synthesis language.
  Add, edit and remove rows, and "Restore defaults". Saving writes
  `pronunciation[<code>]` through the ordinary `saveConfig` message.
- **Try it:** a "Listen" action in the tab speaks a sample sentence (or the
  edited term in a short sentence) with the **unsaved form values**, so a
  respelling can be tuned by ear without a Save between tries. Daniele tuned
  "stage" through several rounds; the tab must make that loop cheap.
  *(Executor's call.)* This needs a preview path that accepts the synthesis
  settings in the request: engine, language, voice, speed, the edited
  dictionary rows and the text. Secrets never travel from the view, so for the
  endpoint engine the saved `apiKey`/`ttsApiKey` are used. Input is validated
  like any other request body.
- *(Executor's call.)* The built-in engine (install, Listen, speak) works
  even when no transcription `endpoint` is configured. Today `resolveVoice`
  refuses without one; the built-in synthesis path must not depend on it.
  Conversation mode as a whole still needs transcription.

### 5. Voice tab: presets and the "local default"

Today the tab offers "Use local defaults" (Speaches + Kokoro for STT and TTS)
and "Use Microsoft Edge voices" (synthesis only). After this change:

- A new synthesis preset, **"Use the built-in voice"** (wording is the
  builder's), presented first and marked as recommended for local use. It sets
  `ttsEngine: 'builtin'`, a language (from `lang` when it maps to a bundle,
  else English), its native voice, and `pronunciationEnabled: true`. It
  prefills only; the user still presses Save, consistent with today's presets.
- **"Use local defaults"** keeps filling the transcription side (Speaches)
  and, for synthesis, now points to the built-in engine instead of Kokoro.
  Kokoro stays reachable by choosing the endpoint engine.
- **"Use Microsoft Edge voices"** stays, and sets `ttsEngine: 'endpoint'` and
  `pronunciationEnabled: false`.
- An explicit engine switch (endpoint / built-in) shows only the relevant
  fields: endpoint, key and model for the endpoint engine; language, voice,
  install state and size for the built-in one.
- **Opt-in:** an existing config is never migrated. Users get the built-in
  engine only by choosing it.

## Constraints

- **ONNX runtime is downloaded on demand, never a package dependency**
  (Daniele's decision). `onnxruntime-node` unpacks to ~308 MB across all
  platforms (1.31.1), too much to add to every caretaker install. The
  "Install" action of the built-in engine first ensures the runtime, then the
  language bundle:
  - Source: the npm registry tarballs of `onnxruntime-node` and
    `onnxruntime-common` at a pinned version, verified against the registry
    `dist.integrity` (sha512) pinned in our code.
  - Kept: the JS entry points and the native binary for the current
    platform/arch only, extracted into
    `~/.caretaker/voice/runtime/onnxruntime/<version>/` (tmp dir + rename,
    idempotent, shared by all languages).
  - Never run: the package's `postinstall` (it only fetches GPU providers;
    CPU is all we use). Its install-time dependencies (`adm-zip`,
    `global-agent`) are not needed at runtime; the spike confirms this.
  - Loaded by absolute path (`createRequire`) only when the built-in engine
    is used. No `asarUnpack` is needed, because nothing native lives inside
    the app bundle.
  - Delete removes the runtime only when no language bundle remains.
- **Model source** (Daniele's decision): the Hugging Face repo
  `Alias-Alias/pocket-3-3-0-tts-onnx`, pinned to a revision with sha256 per
  file. It ships, per language: four INT8 graphs, `tokenizer.json`,
  `voices.bin` (the built-in voices), `bundle.json` (schema 3) and the upstream
  license. Accepted risk: the repo belongs to an individual and could
  disappear. Re-hosting under an account Daniele owns is deferred, so the base
  URL is one constant, easy to switch.
- **Platforms** *(executor's call)*: verified on Linux, which is the
  reference machine, in both `desktop:dev` and a packaged build. On any
  platform where the runtime fails to load, the built-in option is shown as
  unavailable with the load error, it is not marked as recommended, and the
  endpoint engine is untouched. No crash, no hidden failure.
- **Electron packaging:** the downloaded native module must load inside the
  desktop app's forked web server (`utilityProcess`). Verified with a
  packaged build, not only `desktop:dev`.
- Atomic writes and accessor-resolved paths, as everywhere under
  `CARETAKER_HOME`.
- No company or product names in defaults, docs or fixtures.
- Changeset: `minor`.
- Docs: CLAUDE.md layer 6 (Voice Mode) describes the engine switch, the
  streaming contract (playback-ended = last sample played), the dictionary,
  the installer and the new routes. README Voice section: the built-in voice
  as the recommended local synthesis, the dictionary, and the Kyutai credit.

## Left to the builder

- The npm `pocket-tts` package versus our own ONNX loop, decided by the spike
  with the rule in §3. The spike also measures speed on the reference machine
  with the pinned bundle and runtime, and fixes the runtime's thread count:
  `intraOpNumThreads` set to the physical cores, since the earlier measure may
  have used fewer.
- Stream formats per engine and the browser playback mechanism per format.
- The HTTP surface for install, status and delete (the voice-backend routes
  are the model to follow).
- Exact UI wording and layout of the engine switch, the dictionary table and
  the Listen action.
- Tests: the dictionary function (whole-word, case, longest-first, accents
  preserved); speak-route engine dispatch and error passthrough; installer
  (sha mismatch, partial download, idempotency) with a stubbed fetch; the
  `useVoice` contract that playback-ended fires after the last chunk has
  played and that the mic does not reopen mid-stream (pure logic extracted
  where needed, as `voice_utils.ts` already does).
