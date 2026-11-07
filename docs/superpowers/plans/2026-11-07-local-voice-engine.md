# Built-in Local Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream synthesized speech to the renderer for every engine, add an opt-in in-process Pocket TTS engine (ONNX, runtime and model downloaded on demand), and a per-language pronunciation dictionary applied before synthesis.

**Architecture:** `/api/voice/speak` stops buffering and pipes audio as it arrives; the renderer plays MP3 through Media Source Extensions and raw PCM through Web Audio, firing "playback ended" only after the last sample. A new `packages/cli/src/voice/` module holds the dictionary, the pinned Pocket catalog, the installer (runtime from the npm registry tarballs, bundles from Hugging Face) and the engine behind a small interface; the web server dispatches on `voice.ttsEngine`.

**Tech Stack:** TypeScript ESM, Hono, `onnxruntime-node` (downloaded at runtime, loaded by absolute path), React, Web Audio API, Media Source Extensions, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-07-local-voice-engine-design.md`

## Global Constraints

- All code, comments and docs in English. Tests co-located `*.test.ts`, node:test via tsx. `CARETAKER_HOME` set at **file** top in tests that touch the store.
- `onnxruntime-node` is **never** a package dependency of any workspace package. It is downloaded into `~/.caretaker/voice/runtime/onnxruntime/<version>/` and loaded with `createRequire` by absolute path. Its `postinstall` is never run.
- Model source: Hugging Face `Alias-Alias/pocket-3-3-0-tts-onnx`, pinned revision, sha256 per file. Base URL is one constant.
- Every path under `CARETAKER_HOME` comes from an accessor resolved at call time (`dataDir()` pattern). Installs use a tmp sibling dir + `rename`, are idempotent, and leave nothing behind on failure.
- A config without `ttsEngine` behaves exactly as today (endpoint engine). No migration of existing configs.
- Voice invariants (CLAUDE.md layer 6) hold: a bubble's "playback ended" fires only after its last sample played; the mic reopens only after the queue drained **and** the turn is over.
- Secrets never come from the view. The saved `ttsApiKey` is sent only to the saved `ttsEndpoint`.
- Shipped defaults contain generic terms only (no product or company names).
- Not offered: `*_24l` bundles, voice cloning, local STT, VSCode/TUI voice.
- One changeset, `minor`, for `@hyperwindmill/caretaker-cli`, `caretaker-types`, `webview-ui`, `caretaker-desktop`. Never `--amend`; one commit per task.
- Running a third-party package's code may be blocked by the agent's permission classifier. Reading its source is always fine. If a step needs to *execute* external code (none should, by design), stop and ask Daniele.

## Review Focus

1. **A PCM chunk boundary splitting a 16-bit sample** (odd-length network chunk) must not shift every following sample. Expect clean audio; a carried byte joins the next chunk. Test in Task 4.
2. **Listen with an edited `ttsEndpoint` that differs from the saved one** must not send the saved `ttsApiKey` to the new host. Test in Task 3.
3. **Speak with `ttsEngine: 'builtin'` before the runtime or the bundle is installed** must answer at once with a clear 409 naming what is missing, never hang. Test in Task 6.
4. **Two syntheses at once on the built-in engine** (a conversation bubble while Listen runs) must both complete, serialized on the loaded model. Test in Task 6.
5. **Dictionary entries that are not plain words:** regex metacharacters (`c++`, `node.js`), a term inside a longer word (`build` in `buildings`), sentence-initial capitals (`Pipeline`), an empty `term`. Expect literal whole-word matches, untouched substrings, the empty entry ignored. Test in Task 2.

---

### Task 1: Pin the catalog and choose the inference source (read-only spike)

**Files:**
- Create: `packages/cli/src/voice/pocket/catalog.ts`
- Test: `packages/cli/src/voice/pocket/catalog.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PocketLanguage = 'english' | 'french' | 'german' | 'spanish' | 'portuguese' | 'italian' | 'dutch';
  export const POCKET_BASE_URL = 'https://huggingface.co/Alias-Alias/pocket-3-3-0-tts-onnx/resolve';
  export const POCKET_REVISION: string;             // 40-hex commit sha
  export type BundleFile = { name: string; sha256: string; bytes: number };
  export const POCKET_LANGUAGES: Readonly<Record<PocketLanguage, { code: string; dir: string; nativeVoice: string; files: readonly BundleFile[] }>>;
  export const POCKET_VOICES: readonly string[];      // built-in voice names in voices.bin
  export const ORT_VERSION: string;                  // e.g. '1.31.1'
  export const ORT_TARBALLS: Readonly<Record<'node' | 'common', { url: string; integrity: string }>>; // npm dist.tarball + dist.integrity (sha512-…)
  export const POCKET_SAMPLE_RATE = 24000;
  export type InferenceSource = 'npm-pocket-tts' | 'own-loop';
  export const INFERENCE_SOURCE: InferenceSource;
  ```

- [ ] **Step 1: Write the failing shape test** `catalog.test.ts`:
  ```ts
  test('revision is a full commit sha', () => assert.match(POCKET_REVISION, /^[0-9a-f]{40}$/));
  test('every language pins every file with sha256 and size', () => {
    for (const [lang, l] of Object.entries(POCKET_LANGUAGES)) {
      assert.ok(l.files.length >= 6, lang);
      for (const f of l.files) { assert.match(f.sha256, /^[0-9a-f]{64}$/); assert.ok(f.bytes > 0); }
      assert.ok(l.files.some((f) => f.name === 'voices.bin'), `${lang} ships voices.bin`);
      assert.ok(POCKET_VOICES.includes(l.nativeVoice), `${lang} native voice is a built-in voice`);
    }
  });
  test('italian uses giovanni', () => assert.equal(POCKET_LANGUAGES.italian.nativeVoice, 'giovanni'));
  test('runtime tarballs carry sha512 integrity', () => {
    for (const t of Object.values(ORT_TARBALLS)) assert.match(t.integrity, /^sha512-/);
  });
  ```
- [ ] **Step 2: Run it, expect FAIL (module missing).** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/voice/pocket/catalog.test.ts`
- [ ] **Step 3: Collect the pinned values (read-only, no code execution of third parties).**
  - Revision: `curl -s https://huggingface.co/api/models/Alias-Alias/pocket-3-3-0-tts-onnx` → `sha`.
  - Files with sha256/size per language dir: `curl -s "https://huggingface.co/api/models/Alias-Alias/pocket-3-3-0-tts-onnx/tree/<sha>/<dir>?expand=true"` (`lfs.oid` is the sha256 for LFS files; for small non-LFS files download and `sha256sum`).
  - Read `<dir>/bundle.json` and `<dir>/package-manifest.json` for one language: they name the graphs, the tokenizer, the voice names in `voices.bin` and the inference contract (schema 3). Record the voice list in `POCKET_VOICES`. Pick each language's native voice per spec §3; for English and Dutch choose a voice the manifest marks for that language, else the first listed.
  - Runtime: `curl -s https://registry.npmjs.org/onnxruntime-node/<ORT_VERSION>` and `…/onnxruntime-common/<ORT_VERSION>` → `dist.tarball`, `dist.integrity`. Use the latest stable at execution time.
- [ ] **Step 4: Decide `INFERENCE_SOURCE` by reading source only.** Download (do not install or run) the `pocket-tts` npm tarball and read its dist. Choose `'npm-pocket-tts'` only if all three hold: it can run a schema-3 bundle, it selects built-in voices from `voices.bin` without a reference WAV, and it accepts an `InferenceSession` factory or module we pass in (it must not `import 'onnxruntime-node'` by bare name, which would not resolve to our downloaded runtime). Otherwise `'own-loop'`. Write the reason in a header comment of `catalog.ts`.
- [ ] **Step 5: Write `catalog.ts`, run the test, expect PASS.**
- [ ] **Step 6: Commit** — `git add packages/cli/src/voice/pocket/catalog.ts packages/cli/src/voice/pocket/catalog.test.ts && git commit -m "feat(voice): pin the Pocket TTS ONNX catalog and runtime"`

---

### Task 2: Config types and the pronunciation dictionary

**Files:**
- Create: `.changeset/local-voice-engine.md`
- Modify: `packages/types/src/index.ts` (`VoiceConfig`)
- Create: `packages/cli/src/voice/pronunciation.ts`
- Test: `packages/cli/src/voice/pronunciation.test.ts`

**Interfaces:**
- Consumes: `POCKET_LANGUAGES` (Task 1) for the language→code map.
- Produces:
  ```ts
  // caretaker-types
  export type PronunciationEntry = { term: string; say: string };
  // VoiceConfig additions (doc comments from the spec §1):
  ttsEngine?: 'endpoint' | 'builtin';
  ttsLanguage?: string;            // PocketLanguage id
  pronunciation?: Record<string, PronunciationEntry[]>;   // keyed by ISO 639-1
  pronunciationEnabled?: boolean;
  // packages/cli/src/voice/pronunciation.ts
  export const DEFAULT_PRONUNCIATION: Readonly<Record<string, readonly PronunciationEntry[]>>;
  export function synthesisLanguage(voice: VoiceConfig): string | null;           // ISO code or null
  export function dictionaryFor(voice: VoiceConfig, code: string): readonly PronunciationEntry[];
  export function applyPronunciation(text: string, entries: readonly PronunciationEntry[]): string;
  ```

- [ ] **Step 1: Changeset** `.changeset/local-voice-engine.md`, `minor` for the four packages: "Built-in local voice (Pocket TTS on ONNX, runtime and model downloaded from Settings → Voice), streaming playback for every synthesis engine, and a per-language pronunciation dictionary."
- [ ] **Step 2: Write the failing tests:**
  ```ts
  test('whole-word, case-insensitive, longest term first', () => {
    const e = [{ term: 'request', say: 'X' }, { term: 'merge request', say: 'mèrg riquèst' }];
    assert.equal(applyPronunciation('Two Merge Requests and a merge request.', e), 'Two Merge Requests and a mèrg riquèst.');
  });
  test('never matches inside a longer word', () =>
    assert.equal(applyPronunciation('buildings build', [{ term: 'build', say: 'bìld' }]), 'buildings bìld'));
  test('regex metacharacters are literal', () =>
    assert.equal(applyPronunciation('use node.js and c++ not nodexjs', [{ term: 'node.js', say: 'nod gèi es' }, { term: 'c++', say: 'ci plus plus' }]), 'use nod gèi es and ci plus plus not nodexjs'));
  test('sentence-initial capital still matches', () =>
    assert.equal(applyPronunciation('Pipeline verde.', [{ term: 'pipeline', say: 'pàiplain' }]), 'pàiplain verde.'));
  test('empty term is ignored', () => assert.equal(applyPronunciation('ciao', [{ term: '', say: 'x' }]), 'ciao'));
  test('italian defaults are the approved generic list', () => {
    assert.deepEqual(DEFAULT_PRONUNCIATION.it.map((e) => e.term).sort(),
      ['branch', 'build', 'deploy', 'feature', 'merge request', 'pipeline', 'pull request', 'review', 'stage']);
    assert.equal(DEFAULT_PRONUNCIATION.it.find((e) => e.term === 'stage')!.say, 'stèij');
  });
  test('synthesis language: builtin uses ttsLanguage, endpoint uses lang subtag, else null', () => {
    assert.equal(synthesisLanguage({ ttsEngine: 'builtin', ttsLanguage: 'italian' } as any), 'it');
    assert.equal(synthesisLanguage({ lang: 'en-GB' } as any), 'en');
    assert.equal(synthesisLanguage({} as any), null);
  });
  test('saved dictionary replaces defaults for that language only', () => {
    const v = { pronunciation: { it: [{ term: 'deploy', say: 'diplói' }] } } as any;
    assert.deepEqual(dictionaryFor(v, 'it'), [{ term: 'deploy', say: 'diplói' }]);
    assert.deepEqual(dictionaryFor({} as any, 'it'), DEFAULT_PRONUNCIATION.it);
    assert.deepEqual(dictionaryFor({} as any, 'fr'), []);
  });
  ```
  The full Italian values are the spec §4 table.
- [ ] **Step 3: Run, expect FAIL.** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/voice/pronunciation.test.ts`
- [ ] **Step 4: Implement.** Word boundary = not preceded/followed by a Unicode letter or digit (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, flag `iu`), terms escaped, sorted by length descending, one combined pass so a replacement is never re-matched. Add the `VoiceConfig` fields, then `pnpm -F caretaker-types build`.
- [ ] **Step 5: Run the test and `pnpm -F @hyperwindmill/caretaker-cli typecheck`, expect PASS.**
- [ ] **Step 6: Commit** — `feat(voice): pronunciation dictionary and voice engine config fields`

---

### Task 3: Streaming speak route, synthesis resolution, Listen preview

**Files:**
- Modify: `packages/cli/src/cli/web/voice_proxy.ts`
- Modify: `packages/webview-ui/src/bridge.ts` (`VoiceClientConfig` doc only: `canSpeak` = "synthesis is configured for the selected engine")
- Test: `packages/cli/src/cli/web/voice_proxy.test.ts` (extend; reuse its fake-upstream Hono pattern)

**Interfaces:**
- Consumes: `applyPronunciation`, `dictionaryFor`, `synthesisLanguage` (Task 2).
- Produces:
  ```ts
  export type SynthesisSettings = Pick<VoiceConfig, 'ttsEngine' | 'ttsLanguage' | 'ttsVoice' | 'ttsModel' | 'ttsSpeed' | 'ttsEndpoint' | 'pronunciationEnabled'> & { pronunciation?: PronunciationEntry[] };
  export async function resolveSynthesis(): Promise<{ voice: VoiceConfig } | { error: string }>; // enabled; endpoint engine needs endpoint||ttsEndpoint; builtin needs neither
  export function mergePreview(saved: VoiceConfig, s: SynthesisSettings): VoiceConfig;        // drops ttsApiKey when s.ttsEndpoint differs from saved; pronunciation rows go under the synthesis language code
  export type BuiltinSpeaker = (voice: VoiceConfig, text: string, signal: AbortSignal) => Promise<Response>;
  export function setBuiltinSpeaker(fn: BuiltinSpeaker | null): void;  // Task 6 registers the real one
  export async function synthesize(voice: VoiceConfig, text: string, signal: AbortSignal): Promise<Response>;
  // routes: POST /api/voice/speak { text }   POST /api/voice/preview { text, settings: SynthesisSettings }
  ```
  `voiceClientConfig.canSpeak` = `ttsEngine === 'builtin' ? !!ttsLanguage : !!ttsModel`.

- [ ] **Step 1: Write the failing tests:**
  - `speak streams: the first chunk reaches the client before upstream finishes` — fake upstream writes a chunk, then waits on a promise the test resolves only after reading the first bytes from `/api/voice/speak`'s body.
  - `speak applies the dictionary when enabled and the language matches` — saved `{ lang: 'it-IT', pronunciationEnabled: true }`; upstream receives `input` containing `pàiplain` for text `la pipeline`.
  - `speak leaves text alone when pronunciationEnabled is false`.
  - `preview with a different ttsEndpoint does not send the saved ttsApiKey` — saved `ttsEndpoint: A, ttsApiKey: 'k'`; preview `ttsEndpoint: B`; upstream B sees no `authorization` header. Same endpoint → header present.
  - `preview uses unsaved dictionary rows` — preview `pronunciation: [{ term: 'stage', say: 'stèij' }]` → upstream `input` contains `stèij`.
  - `builtin engine works without a transcription endpoint` — saved `{ enabled: true, endpoint: '', ttsEngine: 'builtin', ttsLanguage: 'italian' }`, `setBuiltinSpeaker` stub returns `new Response('PCM')` → 200.
  - `builtin engine without a registered speaker → 503 with a readable message`.
  - Existing tests (400 without model, ttsSpeed, verbatim upstream errors) keep passing.
- [ ] **Step 2: Run, expect FAIL.** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/cli/web/voice_proxy.test.ts`
- [ ] **Step 3: Implement.** Endpoint engine: same request as today; return `new Response(upstream.body, { status, headers: { 'content-type': … } })` (no `arrayBuffer()`), errors still verbatim. Forward `c.req.raw.signal` so a client abort cancels the upstream fetch. `/speak` and `/preview` both go through `synthesize`. Transcription keeps `resolveVoice` unchanged.
- [ ] **Step 4: Run tests + typecheck, expect PASS.**
- [ ] **Step 5: Commit** — `feat(voice): stream synthesis to the client, preview route, dictionary on speak`

---

### Task 4: Streaming playback in the renderer

**Files:**
- Create: `packages/webview-ui/src/voice_stream.ts` (pure)
- Create: `packages/webview-ui/src/speech_player.ts`
- Modify: `packages/webview-ui/src/useVoice.ts` (`speakReply`, `stopPlayback`, refs)
- Test: `packages/webview-ui/src/voice_stream.test.ts`

**Interfaces:**
- Consumes: `/api/voice/speak` streamed body (Task 3). Built-in engine content type `audio/pcm;rate=24000;channels=1`, int16 little-endian.
- Produces:
  ```ts
  // voice_stream.ts
  export function parsePcmType(contentType: string | null): { rate: number; channels: number } | null;
  export function pcm16Chunk(bytes: Uint8Array, carry: Uint8Array | null): { samples: Float32Array; carry: Uint8Array | null };
  export function nextStart(now: number, cursor: number, leadSeconds: number): number;   // max(cursor, now + lead)
  export type PlaybackPath = 'pcm' | 'mse' | 'buffered';
  export function choosePath(contentType: string | null, mseSupports: (t: string) => boolean): PlaybackPath;
  // speech_player.ts
  export function playSpeech(res: Response, signal: AbortSignal): Promise<void>; // resolves after the last sample played; rejects on decode/playback error; abort stops audio now and resolves
  ```

- [ ] **Step 1: Write the failing tests** (`voice_stream.test.ts`):
  ```ts
  test('pcm type parsing', () => {
    assert.deepEqual(parsePcmType('audio/pcm;rate=24000;channels=1'), { rate: 24000, channels: 1 });
    assert.equal(parsePcmType('audio/mpeg'), null);
  });
  test('odd-length chunk carries one byte into the next', () => {
    const a = pcm16Chunk(new Uint8Array([0x00, 0x40, 0xff]), null);   // 0x4000 then half a sample
    assert.equal(a.samples.length, 1); assert.equal(a.samples[0], 0.5); assert.deepEqual([...a.carry!], [0xff]);
    const b = pcm16Chunk(new Uint8Array([0x7f]), a.carry);             // 0x7fff
    assert.equal(b.samples.length, 1); assert.ok(Math.abs(b.samples[0] - 32767 / 32768) < 1e-9); assert.equal(b.carry, null);
  });
  test('scheduling never goes back in time', () => {
    assert.equal(nextStart(10, 0, 0.05), 10.05);
    assert.equal(nextStart(10, 12, 0.05), 12);
  });
  test('path choice', () => {
    assert.equal(choosePath('audio/pcm;rate=24000;channels=1', () => true), 'pcm');
    assert.equal(choosePath('audio/mpeg', (t) => t === 'audio/mpeg'), 'mse');
    assert.equal(choosePath('audio/mpeg', () => false), 'buffered');
    assert.equal(choosePath('audio/wav', () => true), 'buffered');
  });
  ```
- [ ] **Step 2: Run, expect FAIL.** `pnpm -F webview-ui test`
- [ ] **Step 3: Implement `voice_stream.ts`, run, expect PASS.**
- [ ] **Step 4: Implement `playSpeech`.** `pcm`: one `AudioContext` per call (closed at the end), each chunk → `AudioBuffer` → `AudioBufferSourceNode` started at `nextStart(ctx.currentTime, cursor, 0.05)`; resolve on the last source's `onended` after the reader is done. `mse`: `MediaSource` + one `SourceBuffer('audio/mpeg')`, append chunks sequentially (wait `updateend`), `endOfStream()` at reader end, resolve on the `<audio>` `ended` event; `audio.play()` after the first append. `buffered`: today's blob + `<audio>` path. Abort: cancel the reader, stop sources / pause audio, close the context, resolve.
- [ ] **Step 5: Wire `useVoice`.** Replace the blob block in `speakReply` with `await playSpeech(res, ac.signal)` (fetch with the same `AbortController`, held in a ref); keep the `POST_PLAYBACK_MS` chain and `playbackEnded` exactly as now; `stopPlayback` aborts the controller. No change to `voice_utils.nextPhase`.
- [ ] **Step 6: Verify:** `pnpm -F webview-ui typecheck && pnpm -F webview-ui test && pnpm -F webview-ui build`, all PASS. Manual, web GUI with Edge **and** with Speaches: the first words start well before the whole reply has been synthesized; a multi-bubble turn speaks in order; the mic reopens only after the last bubble ends; clicking stop mid-sentence silences at once.
- [ ] **Step 7: Commit** — `feat(voice): play synthesized speech as it streams`

---

### Task 5: Installer for the runtime and the language bundles

**Files:**
- Create: `packages/cli/src/voice/pocket/install.ts`
- Create: `packages/cli/src/cli/web/voice_builtin.ts` (routes)
- Modify: `packages/cli/src/cli/web/server.ts` (`registerVoiceBuiltin(app)` next to `registerVoiceBackend`)
- Modify: `packages/webview-ui/src/bridge.ts` (shared status type)
- Test: `packages/cli/src/voice/pocket/install.test.ts`, `packages/cli/src/cli/web/voice_builtin.test.ts`

**Interfaces:**
- Consumes: `catalog.ts` (Task 1); `DEFAULT_PRONUNCIATION` (Task 2).
- Produces:
  ```ts
  // bridge.ts (shared, like VoiceClientConfig)
  export type BuiltinVoiceStatus = {
    runtime: { installed: boolean; version: string; loadError?: string };
    languages: Array<{ id: string; code: string; nativeVoice: string; installed: boolean; bytes: number }>;
    voices: string[];
    /** Shipped dictionary defaults by ISO code (the view cannot import the CLI). */
    defaults: Record<string, PronunciationEntry[]>;
  };
  export type BuiltinInstallProgress =
    | { step: 'runtime' | 'bundle'; file: string; received: number; total: number }
    | { step: 'done'; status: BuiltinVoiceStatus }
    | { step: 'error'; message: string };
  // install.ts
  export function runtimeDir(): string;                       // <dataDir>/voice/runtime/onnxruntime/<ORT_VERSION>
  export function bundleDir(lang: PocketLanguage): string;   // <dataDir>/voice/pocket/<dir>/<POCKET_REVISION>
  export function installBuiltinVoice(lang: PocketLanguage): AsyncGenerator<BuiltinInstallProgress>;
  export async function deleteBuiltinVoice(lang: PocketLanguage): Promise<void>; // removes the runtime too when no bundle remains
  export async function builtinVoiceStatus(): Promise<BuiltinVoiceStatus>;
  export function __setFetch(f: typeof fetch): void; export function __resetFetch(): void;
  // routes: GET /api/voice/builtin   POST /api/voice/builtin/install?language=<id> (ndjson)   POST /api/voice/builtin/delete?language=<id>
  ```

- [ ] **Step 1: Write the failing tests** (stubbed fetch; a tiny gzipped tar built in the test with `package/package.json`, `package/dist/index.js` and `package/bin/napi-v6/<process.platform>/<process.arch>/onnxruntime_binding.node`, plus a second platform dir; bundle files as small byte arrays with their real sha256 swapped into a test catalog through a `__setCatalogForTest` seam):
  - `installs runtime once and the bundle; second run downloads nothing` (count fetch calls).
  - `keeps only the current platform binary from the runtime tarball`.
  - `sha256 mismatch on a bundle file fails with the file name and leaves no bundle dir`.
  - `integrity mismatch on the runtime tarball fails and leaves no runtime dir`.
  - `HTTP 404 surfaces the status and URL`.
  - `delete keeps the runtime while another bundle remains, removes it with the last`.
  - Routes: `unknown language → 400`; `install streams ndjson ending with done`; `a second install for the same language while one runs → 409`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/voice/pocket/install.test.ts src/cli/web/voice_builtin.test.ts`
- [ ] **Step 3: Implement.** Runtime: download both tarballs, verify `integrity` (sha512 base64), extract with the `tar` package already in the CLI dependencies (check `packages/cli/package.json`; if absent, use `node:zlib` + a minimal tar reader, no new dependency), keep `package/` JS and the current platform's `bin/**/<platform>/<arch>/`, place `onnxruntime-common` at `node_modules/onnxruntime-common` inside the runtime dir so the binding's `require('onnxruntime-common')` resolves. Bundle: download each file to the tmp dir with streaming sha256, `rename` the dir into place. Progress events per file. In-flight guard per language (a `Set`).
- [ ] **Step 4: Run tests + typecheck, expect PASS.**
- [ ] **Step 5: Commit** — `feat(voice): on-demand installer for the ONNX runtime and Pocket bundles`

---

### Task 6: The built-in engine

**Files:**
- Create: `packages/cli/src/voice/pocket/engine.ts`
- Create: `packages/cli/src/voice/pocket/inference.ts` (only if `INFERENCE_SOURCE === 'own-loop'`; else an adapter over `pocket-tts` in the same file)
- Modify: `packages/cli/src/cli/web/voice_builtin.ts` (register the speaker)
- Test: `packages/cli/src/voice/pocket/engine.test.ts`

**Interfaces:**
- Consumes: `runtimeDir`, `bundleDir`, `builtinVoiceStatus` (Task 5); `setBuiltinSpeaker`, `BuiltinSpeaker` (Task 3); catalog (Task 1).
- Produces:
  ```ts
  export interface PocketModel { readonly sampleRate: number; synthesize(text: string, voice: string, signal: AbortSignal): AsyncIterable<Float32Array>; close(): Promise<void>; }
  export type ModelLoader = (lang: PocketLanguage) => Promise<PocketModel>;
  export function setModelLoaderForTest(l: ModelLoader | null): void;
  export function loadOnnxRuntime(): { InferenceSession: unknown } ;         // createRequire(runtimeDir()) — throws a readable error when missing or unloadable
  export const speakBuiltin: BuiltinSpeaker;                                // 409 when runtime/bundle missing; else 200 audio/pcm;rate=24000;channels=1 streaming int16 LE
  export async function releasePocketModels(): Promise<void>;
  ```
  One loaded model per language, kept warm; calls on the same model run one at a time (a promise chain); switching `ttsLanguage` releases the others. Sessions use `intraOpNumThreads` = physical cores (`os.availableParallelism()` / 2 floored, min 1).

- [ ] **Step 1: Write the failing tests** (fake loader through `setModelLoaderForTest`):
  - `missing runtime → 409 naming the runtime; missing bundle → 409 naming the language` (status stubbed via the Task 5 seam).
  - `streams int16 LE PCM with the pcm content type` — fake model yields `[Float32Array([0.5]), Float32Array([-1])]`; body bytes `00 40 00 80`.
  - `two concurrent syntheses on one language both complete, serialized` — fake model records start/end order; assert no overlap.
  - `client abort stops generation` — abort after the first chunk; the fake model sees `signal.aborted` and the iterator is returned.
  - `model loads once per language across requests` (loader call count).
  - `runtime load failure is reported in builtinVoiceStatus().runtime.loadError`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/voice/pocket/engine.test.ts`
- [ ] **Step 3: Implement the engine** (cache, serialization, PCM encoding, 409s, `loadError`).
- [ ] **Step 4: Implement the real loader** per `INFERENCE_SOURCE`: own loop follows the bundle's `bundle.json` (schema 3) and the upstream reference flow: tokenizer → text conditioner → flow LM main + flow steps with explicit streaming state → mimi decoder, yielding audio per decoded frame.
- [ ] **Step 5: Run tests + typecheck, expect PASS.**
- [ ] **Step 6: Real-model smoke (reference machine, manual).** `CARETAKER_HOME=/tmp/ct-voice pnpm -F @hyperwindmill/caretaker-cli dev web`, install Italian from the API (`curl -N -X POST 'http://127.0.0.1:3000/api/voice/builtin/install?language=italian'`), set `ttsEngine: 'builtin', ttsLanguage: 'italian', ttsVoice: 'giovanni'`, then `curl -s -X POST localhost:3000/api/voice/speak -H 'content-type: application/json' -d '{"text":"Ciao, la pipeline di stage è verde."}' -o /tmp/ct-voice/out.pcm -w '%{time_starttransfer} %{time_total}\n'`. Expected: first byte < 1 s warm; generation ≥ 1.0× real time (bytes / 48000 = seconds of audio, compared with `time_total`). If below 1.0×, stop and report the numbers before continuing.
- [ ] **Step 7: Commit** — `feat(voice): in-process Pocket TTS engine`

---

### Task 7: Voice tab — engine switch, built-in block, presets, dictionary, Listen

**Files:**
- Create: `packages/webview-ui/src/BuiltinVoiceBlock.tsx`
- Create: `packages/webview-ui/src/PronunciationTable.tsx`
- Create: `packages/webview-ui/src/voice_tab_presets.ts` (pure)
- Modify: `packages/webview-ui/src/VoiceTab.tsx`
- Test: `packages/webview-ui/src/voice_tab_presets.test.ts`

**Interfaces:**
- Consumes: `BuiltinVoiceStatus` (including `defaults`), `BuiltinInstallProgress` (Task 5), routes of Tasks 3 and 5, `PronunciationEntry` (Task 2).
- Produces:
  ```ts
  export function builtinPreset(lang: string | undefined, status: BuiltinVoiceStatus): Partial<VoiceConfig>; // { ttsEngine:'builtin', ttsLanguage, ttsVoice: native, pronunciationEnabled:true }
  export function edgePreset(): Partial<VoiceConfig>;      // existing EDGE_TTS_DEFAULTS + { ttsEngine:'endpoint', pronunciationEnabled:false }
  export function localDefaultsPreset(lang: string | undefined, status: BuiltinVoiceStatus | null): Partial<VoiceConfig>; // Speaches STT + builtin synthesis when available, else today's Kokoro
  export function pocketLanguageFor(bcp47: string | undefined, status: BuiltinVoiceStatus): string; // 'it-IT'→'italian', unknown→'english'
  ```

- [ ] **Step 1: Write the failing tests:**
  - `builtinPreset maps it-IT to italian with giovanni and enables the dictionary`.
  - `unknown lang falls back to english`.
  - `edgePreset selects the endpoint engine and disables the dictionary`.
  - `localDefaultsPreset uses the built-in engine when the runtime can load, Kokoro when status reports loadError`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm -F webview-ui test`
- [ ] **Step 3: Implement the presets, run, expect PASS.**
- [ ] **Step 4: Build the UI.** Engine switch (endpoint / built-in) showing only relevant fields. Built-in block: recommended badge unless `runtime.loadError` (then "not available on this system" with the error), language picker with installed state and size, Install/Delete with ndjson progress (same pattern as `VoiceBackendBlock`), voice picker (`voices`, native first), speed note if unsupported, Kyutai credit and model link (CC BY 4.0). Preset buttons in this order: built-in voice (recommended), Use local defaults, Use Microsoft Edge voices; all prefill only. Dictionary table for the current synthesis language: add/edit/remove, Restore defaults, enable toggle. Listen button: `POST /api/voice/preview` with unsaved form values and a sample sentence (or the edited row's term in a short sentence), played with `playSpeech`.
- [ ] **Step 5: Verify:** `pnpm -F webview-ui typecheck && pnpm -F webview-ui test && pnpm -F webview-ui build`. Manual in the web GUI on an isolated `CARETAKER_HOME`: choose the built-in preset, install Italian, Listen speaks with giovanni, edit `stage` and Listen again without saving, Save, conversation mode speaks a reply as it streams.
- [ ] **Step 6: Commit** — `feat(voice): built-in voice, dictionary and Listen in the Voice tab`

---

### Task 8: Docs and end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (layer 6 Voice Mode; State on disk: `voice/runtime`, `voice/pocket`)
- Modify: `README.md` (Voice Mode section)

- [ ] **Step 1: CLAUDE.md.** Engine switch and config fields; streaming contract (playback ended = last sample played; MSE for MP3, Web Audio for PCM, buffered fallback); `/api/voice/speak` pass-through and `/api/voice/preview` (saved key only to the saved endpoint); dictionary rules (server-side, whole-word, longest first, per language, defaults generic); installer (runtime from npm tarballs with pinned integrity, platform binary only, postinstall never run, bundles pinned on Hugging Face, tmp+rename); engine (in-process, one warm model per language, serialized, threads, 409 when missing); `loadError` fallback; surface matrix unchanged.
- [ ] **Step 2: README.** The built-in voice as the recommended local synthesis (Settings → Voice), languages and voices, what gets downloaded and where, the dictionary and Listen, the Kyutai credit with the model link and licence, and that Edge/Speaches stay available and now stream too.
- [ ] **Step 3: Full suite.** `pnpm build && pnpm test`, all green.
- [ ] **Step 4: Desktop, reference machine (Linux).** `pnpm desktop:dev` with an isolated `CARETAKER_HOME` (from the VSCode terminal: `env -u ELECTRON_RUN_AS_NODE`): install Italian, conversation mode speaks with the built-in voice. Then `pnpm desktop:dist` and run the packaged AppImage or `.deb` the same way: the downloaded native runtime loads inside the forked web server.
- [ ] **Step 5: Commit** — `docs: built-in local voice, streaming playback and pronunciation dictionary`
