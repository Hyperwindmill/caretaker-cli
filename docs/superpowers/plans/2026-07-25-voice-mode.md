# Voice Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dictation and hands-free voice conversation to the caretaker chat, on the web GUI and Electron desktop app, driven by user-configured OpenAI-compatible speech endpoints.

**Architecture:** caretaker bundles no speech model. The renderer captures audio with `MediaRecorder`, ends turns with Silero VAD, and posts to two thin server proxies that forward to the configured `/audio/transcriptions` and `/audio/speech` endpoints — so the API key never reaches the browser. The conversation loop is derived from the existing `chatState` reducer in `App.tsx` rather than adding new protocol events.

**Tech Stack:** TypeScript (ESM, strict), React 19, Hono, esbuild, `@ricky0123/vad-web` + `onnxruntime-web`, Node's built-in test runner via `tsx`.

**Spec:** `docs/superpowers/specs/2026-07-25-voice-mode-design.md` — read it before starting. It records *why* the obvious approach (Web Speech API) does not work, which prevents re-deriving it.

## Global Constraints

- ESM only (`"type": "module"`), `moduleResolution: "bundler"`. No CommonJS.
- TypeScript `strict` is on but `noImplicitAny` is off.
- Tests are co-located as `*.test.ts` and run with Node's built-in runner through `tsx`. No Jest, no vitest.
- All paths under `~/.caretaker/` come from accessor functions (`dataDir()`, `configPath()`, …) resolved at call time, never at import time.
- Any test that touches on-disk state MUST set `process.env.CARETAKER_HOME` to a temp dir at **file scope**, before importing modules that read it — not inside a `describe`/`before`. Setting it later clobbers the developer's real store.
- Atomic-write policy for persisted state: tmp file + rename + Windows retry. Never fall back to writing the destination path directly.
- `loadX()` functions must never return a reference into a default singleton — clone before returning.
- Every user-facing or architectural change updates `CLAUDE.md` (and `README.md` when user-facing) in the same unit of work.
- Exactly one changeset for the whole feature (Task 8), semver **minor**.
- Voice is available on the web GUI and the Electron desktop app only. Never in the VSCode sidebar or the TUI.
- The API key is never sent to the renderer, in any message, under any condition.

---

### Task 1: `VoiceConfig` type and encrypted-at-rest API key

**Files:**
- Modify: `packages/types/src/index.ts` (add `VoiceConfig`, extend `CaretakerConfig` at lines 64-71)
- Modify: `packages/cli/src/store/json.ts` (extend `saveConfig` at lines 86-97)
- Test: `packages/cli/src/store/json_voice.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `VoiceConfig` type, exported from `caretaker-types`; `CaretakerConfig.voice?: VoiceConfig`. Every later task depends on these exact field names.

- [ ] **Step 1: Add the type**

In `packages/types/src/index.ts`, add above `CaretakerConfig`:

```ts
/** Voice mode configuration. One OpenAI-compatible base URL and key serve both
 *  transcription and synthesis; see docs/superpowers/specs/2026-07-25-voice-mode-design.md */
export type VoiceConfig = {
  /** Master gate. False ⇒ no mic affordance on any surface. */
  enabled: boolean;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8000/v1 */
  endpoint: string;
  /** Encrypted at rest (encrypt() blob, see lib/encryption.ts). */
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

Then extend `CaretakerConfig` (currently lines 64-71) with one field:

```ts
export type CaretakerConfig = {
  port: number;
  providers: ProviderConfig[];
  scheduler?: {
    tasks: ScheduledTaskConfig[];
  };
  projects?: ProjectConfig[];
  voice?: VoiceConfig;
};
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/store/json_voice.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: must be set before importing anything that resolves CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-cfg-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig } from './json.js';
import { configPath } from './paths.js';
import { isEncrypted, decrypt } from '../lib/encryption.js';

test('saveConfig encrypts voice.apiKey at rest and loadConfig round-trips the block', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8000/v1',
      apiKey: 'sk-plaintext-secret',
      sttModel: 'Systran/faster-whisper-small',
      ttsModel: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
      ttsVoice: 'af_heart',
    },
  });

  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.ok(isEncrypted(raw.voice.apiKey), 'key must be encrypted on disk');
  assert.notEqual(raw.voice.apiKey, 'sk-plaintext-secret');
  assert.equal(decrypt(raw.voice.apiKey), 'sk-plaintext-secret');

  const loaded = await loadConfig();
  assert.equal(loaded.voice?.enabled, true);
  assert.equal(loaded.voice?.sttModel, 'Systran/faster-whisper-small');
});

test('saveConfig does not double-encrypt an already-encrypted key', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: 'http://x/v1', apiKey: 'sk-abc', sttModel: 'm' },
  });
  const once = JSON.parse(readFileSync(configPath(), 'utf8')).voice.apiKey;

  // Re-save the already-encrypted value, as the settings round-trip does.
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: 'http://x/v1', apiKey: once, sttModel: 'm' },
  });
  const twice = JSON.parse(readFileSync(configPath(), 'utf8')).voice.apiKey;
  assert.equal(decrypt(twice), 'sk-abc');
});

test('saveConfig leaves a config with no voice block untouched', async () => {
  await saveConfig({ port: 3000, providers: [] });
  const loaded = await loadConfig();
  assert.equal(loaded.voice, undefined);
});
```

Note: confirm the import path for `configPath` — it is exported from the store's paths module. If it lives elsewhere in this tree, import it from where `json.ts` itself imports it.

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/store/json_voice.test.ts
```

Expected: FAIL — the key is written in plaintext, so `isEncrypted` returns false.

- [ ] **Step 4: Encrypt on save**

In `packages/cli/src/store/json.ts`, inside `saveConfig`, after the existing scheduler-token loop and before `await writeJson(...)`:

```ts
  if (c.voice?.apiKey && !isEncrypted(c.voice.apiKey)) {
    c.voice.apiKey = encrypt(c.voice.apiKey);
  }
```

`encrypt` and `isEncrypted` are already imported at the top of this file (line 6).

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/store/json_voice.test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 6: Typecheck**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

Expected: clean. (`pnpm test` runs through `tsx` and does **not** typecheck — this step is not optional.)

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/index.ts packages/cli/src/store/json.ts packages/cli/src/store/json_voice.test.ts
git commit -m "feat(voice): VoiceConfig type with encrypted-at-rest api key"
```

---

### Task 2: `voice_utils.ts` — the pure decision logic

**Files:**
- Create: `packages/webview-ui/src/voice_utils.ts`
- Create: `packages/webview-ui/src/voice_utils.test.ts`
- Modify: `packages/webview-ui/package.json` (add `test` script and `tsx` devDependency)

**Interfaces:**
- Consumes: nothing. Deliberately imports no sibling module: `ChatItem` lives in `App.tsx`, which will consume this module, so depending on it would point the arrow the wrong way. The text-selection helper takes a structural subset instead.
- Produces:
  - `type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'awaiting' | 'speaking'`
  - `type VoiceMode = 'dictate' | 'conversation'`
  - `type VoiceEvent` (the discriminated union below)
  - `nextPhase(phase: VoicePhase, event: VoiceEvent): VoicePhase`
  - `toBcp47(lang: string | undefined, fallback: string): string`
  - `stripMarkdownForSpeech(md: string): string`
  - `type SpokenItem = { kind: string; text?: string; streaming?: boolean }`
  - `lastSpokenText(items: readonly SpokenItem[]): string | null`
  - `END_OF_TURN_MS = 1200`, `IDLE_WINDOW_MS = 10_000`, `POST_PLAYBACK_MS = 250`

Task 6 consumes all of these; the names must not drift.

- [ ] **Step 1: Give webview-ui a test runner**

`packages/webview-ui` currently has no `test` script, so its existing `toolFormat.test.ts` (6 tests, all passing) is never executed by `pnpm test`. In `packages/webview-ui/package.json`, add to `scripts`:

```json
    "test": "tsx --test \"src/**/*.test.ts\""
```

and to `devDependencies`:

```json
    "tsx": "^4.19.2"
```

Then install:

```bash
pnpm install
```

- [ ] **Step 2: Verify the runner picks up the orphaned tests**

```bash
pnpm -F webview-ui test
```

Expected: PASS, 6/6 from `toolFormat.test.ts`. This confirms the wiring before any new test exists. If these 6 fail, stop and report — that is a pre-existing breakage, not part of this task.

- [ ] **Step 3: Write the failing test**

Create `packages/webview-ui/src/voice_utils.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPhase,
  toBcp47,
  stripMarkdownForSpeech,
  lastSpokenText,
  END_OF_TURN_MS,
  IDLE_WINDOW_MS,
  POST_PLAYBACK_MS,
  type SpokenItem,
} from './voice_utils.js';

test('mic click starts recording from idle', () => {
  assert.equal(nextPhase('idle', { kind: 'micClick', mode: 'dictate' }), 'recording');
  assert.equal(nextPhase('idle', { kind: 'micClick', mode: 'conversation' }), 'recording');
});

test('dictation ends the turn on user click, not on VAD', () => {
  assert.equal(nextPhase('recording', { kind: 'micClick', mode: 'dictate' }), 'transcribing');
  // The VAD does not run in dictation; if an event leaks through it must not cut the turn.
  assert.equal(nextPhase('recording', { kind: 'speechEnded', mode: 'dictate' }), 'recording');
});

test('conversation ends the turn on VAD speech-end', () => {
  assert.equal(nextPhase('recording', { kind: 'speechEnded', mode: 'conversation' }), 'transcribing');
});

test('conversation returns to idle when nothing is spoken in the idle window', () => {
  assert.equal(nextPhase('recording', { kind: 'idleWindowElapsed', mode: 'conversation' }), 'idle');
});

test('user click always discards back to idle', () => {
  assert.equal(nextPhase('recording', { kind: 'userStop', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('awaiting', { kind: 'userStop', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('speaking', { kind: 'userStop', mode: 'conversation' }), 'idle');
});

test('dictation returns to idle after a successful transcription', () => {
  assert.equal(
    nextPhase('transcribing', { kind: 'transcribed', mode: 'dictate', empty: false }),
    'idle',
  );
});

test('conversation sends and awaits after a non-empty transcription', () => {
  assert.equal(
    nextPhase('transcribing', { kind: 'transcribed', mode: 'conversation', empty: false }),
    'awaiting',
  );
});

test('conversation keeps the mic alive when the transcription is empty', () => {
  assert.equal(
    nextPhase('transcribing', { kind: 'transcribed', mode: 'conversation', empty: true }),
    'recording',
  );
});

test('any error returns to idle', () => {
  assert.equal(nextPhase('transcribing', { kind: 'failed', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('awaiting', { kind: 'failed', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('speaking', { kind: 'failed', mode: 'conversation' }), 'idle');
});

// --- The three invariants from the spec. Each maps to a concrete failure. ---

test('INVARIANT 1: playback finishing is what reopens the mic', () => {
  assert.equal(
    nextPhase('speaking', { kind: 'playbackEnded', mode: 'conversation' }),
    'recording',
  );
  // The harness turn completing must NOT reopen the mic — that is what makes the
  // agent transcribe itself. From 'speaking' a turnFinished event is inert.
  assert.equal(
    nextPhase('speaking', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, sawStreaming: true, confirmPending: false }),
    'speaking',
  );
});

test('INVARIANT 2: a pending confirmation holds the loop in awaiting', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, sawStreaming: true, confirmPending: true }),
    'awaiting',
  );
});

test('INVARIANT 3: awaiting will not advance until streaming has been observed', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, sawStreaming: false, confirmPending: false }),
    'awaiting',
  );
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, sawStreaming: true, confirmPending: false }),
    'speaking',
  );
});

test('without a synthesis model the loop skips speaking and relistens', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: false, sawStreaming: true, confirmPending: false }),
    'recording',
  );
});

// --- Helpers ---

test('toBcp47 passes through a full tag and expands a bare code', () => {
  assert.equal(toBcp47('it-IT', 'en-US'), 'it-IT');
  assert.equal(toBcp47('it', 'en-US'), 'it-IT');
  assert.equal(toBcp47('en', 'en-US'), 'en-EN');
  assert.equal(toBcp47(undefined, 'it-IT'), 'it-IT');
  assert.equal(toBcp47('', 'it-IT'), 'it-IT');
});

test('stripMarkdownForSpeech removes syntax that should not be pronounced', () => {
  assert.equal(stripMarkdownForSpeech('**bold** and _italic_'), 'bold and italic');
  assert.equal(stripMarkdownForSpeech('# Heading\n\ntext'), 'Heading\n\ntext');
  assert.equal(stripMarkdownForSpeech('see [the docs](https://example.com)'), 'see the docs');
  assert.equal(stripMarkdownForSpeech('run `npm test` now'), 'run npm test now');
  assert.equal(stripMarkdownForSpeech('a\n```js\ncode()\n```\nb'), 'a\nb');
  assert.equal(stripMarkdownForSpeech('- one\n- two'), 'one\ntwo');
});

test('lastSpokenText picks the last completed assistant text', () => {
  const items: SpokenItem[] = [
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: 'first reply', streaming: false },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'tool' },
    { kind: 'assistant', text: 'second reply', streaming: false },
  ];
  assert.equal(lastSpokenText(items), 'second reply');
});

test('lastSpokenText ignores a still-streaming assistant item', () => {
  const items: SpokenItem[] = [
    { kind: 'assistant', text: 'done', streaming: false },
    { kind: 'assistant', text: 'partial', streaming: true },
  ];
  assert.equal(lastSpokenText(items), 'done');
});

test('lastSpokenText returns null when there is nothing to say', () => {
  assert.equal(lastSpokenText([]), null);
  assert.equal(lastSpokenText([{ kind: 'user', text: 'hi' }]), null);
  assert.equal(lastSpokenText([{ kind: 'assistant', text: '   ', streaming: false }]), null);
});

test('timing constants match the spec', () => {
  assert.equal(END_OF_TURN_MS, 1200);
  assert.equal(IDLE_WINDOW_MS, 10_000);
  assert.equal(POST_PLAYBACK_MS, 250);
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm -F webview-ui test
```

Expected: FAIL — `Cannot find module './voice_utils.js'`.

- [ ] **Step 5: Write the implementation**

Create `packages/webview-ui/src/voice_utils.ts`:

```ts
/** Where the voice loop is. See the phase machine in the design spec. */
export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'awaiting' | 'speaking';

export type VoiceMode = 'dictate' | 'conversation';

/** 1200 ms of continuous silence after speech ends the turn (conversation only). */
export const END_OF_TURN_MS = 1200;
/** 10 s in `recording` with no speech at all ends the loop. */
export const IDLE_WINDOW_MS = 10_000;
/** Delay after playback before reopening the mic, so reverb tail on speakers
 *  does not open the next turn. */
export const POST_PLAYBACK_MS = 250;

export type VoiceEvent =
  | { kind: 'micClick'; mode: VoiceMode }
  | { kind: 'userStop'; mode: VoiceMode }
  | { kind: 'speechEnded'; mode: VoiceMode }
  | { kind: 'idleWindowElapsed'; mode: VoiceMode }
  | { kind: 'transcribed'; mode: VoiceMode; empty: boolean }
  | {
      kind: 'turnFinished';
      mode: VoiceMode;
      /** A synthesis model is configured. */
      canSpeak: boolean;
      /** `status === 'streaming'` has been observed since the send. */
      sawStreaming: boolean;
      /** A tool confirmation is currently pending. */
      confirmPending: boolean;
    }
  | { kind: 'playbackEnded'; mode: VoiceMode }
  | { kind: 'failed'; mode: VoiceMode };

/**
 * The whole loop's decision table. Pure on purpose: this repo has no DOM test
 * harness, so keeping every branch here is what makes the behaviour testable.
 * Unhandled (phase, event) pairs return the phase unchanged — the loop must never
 * advance on an event it does not understand.
 */
export function nextPhase(phase: VoicePhase, event: VoiceEvent): VoicePhase {
  // A user stop is honoured from anywhere.
  if (event.kind === 'userStop') return 'idle';
  // Any failure returns to idle; the caller surfaces the message.
  if (event.kind === 'failed') return 'idle';

  switch (phase) {
    case 'idle':
      return event.kind === 'micClick' ? 'recording' : phase;

    case 'recording':
      // Dictation ends only when the user says so: dictating involves pauses, and
      // an automatic cut mid-pause is the worst way for dictation to fail.
      if (event.mode === 'dictate') {
        return event.kind === 'micClick' ? 'transcribing' : phase;
      }
      if (event.kind === 'speechEnded') return 'transcribing';
      if (event.kind === 'idleWindowElapsed') return 'idle';
      return phase;

    case 'transcribing':
      if (event.kind !== 'transcribed') return phase;
      if (event.mode === 'dictate') return 'idle';
      // Nothing intelligible: keep the mic alive rather than ending the loop.
      return event.empty ? 'recording' : 'awaiting';

    case 'awaiting':
      if (event.kind !== 'turnFinished') return phase;
      // INVARIANT 3: `status` is still 'idle' between onSend and the socket
      // round-trip, so advancing without having seen 'streaming' would speak the
      // *previous* reply.
      if (!event.sawStreaming) return phase;
      // INVARIANT 2: with a confirmation pending the turn never completes; a loop
      // keyed on completion alone would die silently here.
      if (event.confirmPending) return phase;
      return event.canSpeak ? 'speaking' : 'recording';

    case 'speaking':
      // INVARIANT 1: only playback finishing reopens the mic. Reacting to the
      // harness turn completing here is what makes the agent transcribe itself.
      return event.kind === 'playbackEnded' ? 'recording' : phase;
  }
}

/** Expand a bare language code to a BCP-47 tag; pass through anything already tagged. */
export function toBcp47(lang: string | undefined, fallback: string): string {
  if (!lang) return fallback;
  if (lang.includes('-')) return lang;
  return `${lang}-${lang.toUpperCase()}`;
}

/** Strip markdown that should not be pronounced. Not a parser — a reader's filter. */
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```\n?/g, '')      // fenced code blocks: skip entirely
    .replace(/`([^`]+)`/g, '$1')            // inline code: keep the text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // images: drop
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')// links: keep the label
    .replace(/^#{1,6}\s+/gm, '')            // headings
    .replace(/^\s*[-*+]\s+/gm, '')          // list bullets
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // bold
    .replace(/\*([^*]+)\*/g, '$1')          // italic
    .replace(/_([^_]+)_/g, '$1')            // underscore italic
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Structural subset of App's `ChatItem` — just enough to pick the reply. Declared
 *  here rather than imported so this module stays a leaf. */
export type SpokenItem = { kind: string; text?: string; streaming?: boolean };

/** The text to speak: the last completed assistant reply. `thinking` and `tool` are
 *  separate item kinds, so they are excluded by construction. */
export function lastSpokenText(items: readonly SpokenItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'assistant') continue;
    if (item.streaming) continue;
    const text = (item.text ?? '').trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm -F webview-ui test
```

Expected: PASS — the 6 pre-existing plus every new test. If `stripMarkdownForSpeech` or `toBcp47` assertions fail, fix the implementation to match the test, not the reverse: the expectations encode the spec.

- [ ] **Step 7: Commit**

```bash
git add packages/webview-ui/src/voice_utils.ts packages/webview-ui/src/voice_utils.test.ts packages/webview-ui/package.json pnpm-lock.yaml
git commit -m "feat(voice): pure phase machine and speech text helpers, plus a test runner for webview-ui"
```

---

### Task 3: Server proxy endpoints

**Files:**
- Modify: `packages/webview-ui/src/bridge.ts` (add `VoiceClientConfig`)
- Create: `packages/cli/src/cli/web/voice_proxy.ts`
- Create: `packages/cli/src/cli/web/voice_proxy.test.ts`
- Modify: `packages/cli/src/cli/web/server.ts` (call `registerVoiceProxy(app)` beside the other route registrations)

**Interfaces:**
- Consumes: `CaretakerConfig.voice` / `VoiceConfig` from Task 1.
- Produces:
  - `VoiceClientConfig` exported from `packages/webview-ui/src/bridge.ts`
  - `registerVoiceProxy(app: Hono): void` — mounts `POST /api/voice/transcribe` and `POST /api/voice/speak`
  - `voiceClientConfig(config: CaretakerConfig): VoiceClientConfig | null` — the redacted projection Task 4 sends to the renderer

- [ ] **Step 1: Define the shared type in the bridge, not twice**

`packages/cli` already imports from the webview's bridge — `server.ts:51` has
`import type { ConfirmDecision, HostToView, ViewToHost } from 'webview-ui/bridge'`, and
`webview-ui` is a `workspace:*` dependency of the CLI. So this type gets **one**
definition, in the bridge, and the server imports it. Do not declare it in both places.

In `packages/webview-ui/src/bridge.ts`, near the other shared shapes (around lines 55-64):

```ts
/** Voice settings the renderer is allowed to see. The API key is deliberately
 *  absent: the renderer only talks to the local /api/voice/* proxies. */
export type VoiceClientConfig = {
  enabled: boolean;
  /** An endpoint is configured. The URL itself is not needed client-side. */
  configured: boolean;
  /** A synthesis model is configured; conversation mode requires it. */
  canSpeak: boolean;
  lang?: string;
};
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/cli/web/voice_proxy.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-proxy-'));

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registerVoiceProxy, voiceClientConfig } from './voice_proxy.js';
import { saveConfig } from '../../store/json.js';

let server: ReturnType<typeof serve>;
let baseUrl: string;

// A stand-in for the user's speech provider. Records what it was sent.
let upstream: ReturnType<typeof serve>;
let upstreamUrl: string;
let lastRequest: { path: string; auth: string | null; model: string | null; body: any } | null = null;
let upstreamStatus = 200;
let upstreamBody: string | Uint8Array = JSON.stringify({ text: 'ciao mondo' });
let upstreamType = 'application/json';

before(async () => {
  const up = new Hono();
  up.post('/v1/audio/transcriptions', async (c) => {
    const form = await c.req.formData();
    lastRequest = {
      path: '/v1/audio/transcriptions',
      auth: c.req.header('authorization') ?? null,
      model: (form.get('model') as string) ?? null,
      body: form.get('file'),
    };
    return c.body(upstreamBody as any, upstreamStatus as any, { 'content-type': upstreamType });
  });
  up.post('/v1/audio/speech', async (c) => {
    const json = await c.req.json();
    lastRequest = {
      path: '/v1/audio/speech',
      auth: c.req.header('authorization') ?? null,
      model: json.model ?? null,
      body: json,
    };
    return c.body(upstreamBody as any, upstreamStatus as any, { 'content-type': upstreamType });
  });
  upstream = serve({ fetch: up.fetch, port: 0 });
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;

  const app = new Hono();
  registerVoiceProxy(app);
  server = serve({ fetch: app.fetch, port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  upstream.close();
});

beforeEach(() => {
  lastRequest = null;
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ text: 'ciao mondo' });
  upstreamType = 'application/json';
});

function audioForm(): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'turn.webm');
  return form;
}

test('transcribe returns 503 when voice is disabled', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: false, endpoint: upstreamUrl, sttModel: 'whisper' },
  });
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /voice/i);
});

test('transcribe returns 503 when the endpoint is empty', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: '', sttModel: 'whisper' },
  });
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 503);
});

test('transcribe forwards the audio with the model and bearer key', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: upstreamUrl,
      apiKey: 'sk-secret',
      sttModel: 'Systran/faster-whisper-small',
      lang: 'it-IT',
    },
  });
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: 'ciao mondo' });
  assert.equal(lastRequest?.model, 'Systran/faster-whisper-small');
  assert.equal(lastRequest?.auth, 'Bearer sk-secret');
});

test('speak returns 400 when no synthesis model is configured', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: upstreamUrl, sttModel: 'whisper' },
  });
  const res = await fetch(`${baseUrl}/api/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ciao' }),
  });
  assert.equal(res.status, 400);
});

test('speak forwards text, model and voice, and returns the audio bytes', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: upstreamUrl,
      sttModel: 'whisper',
      ttsModel: 'kokoro',
      ttsVoice: 'af_heart',
    },
  });
  upstreamBody = new Uint8Array([0xff, 0xfb, 0x90]);
  upstreamType = 'audio/mpeg';

  const res = await fetch(`${baseUrl}/api/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ciao' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(new Uint8Array(await res.arrayBuffer()).length, 3);
  assert.equal(lastRequest?.body.model, 'kokoro');
  assert.equal(lastRequest?.body.voice, 'af_heart');
  assert.equal(lastRequest?.body.input, 'ciao');
});

test('upstream failures propagate status and body verbatim', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: upstreamUrl, sttModel: 'nonexistent-model' },
  });
  upstreamStatus = 404;
  upstreamBody = JSON.stringify({ error: { message: 'model nonexistent-model not found' } });

  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 404);
  // Verbatim: a wrong model id must read as the provider's own error, because
  // there is no configuration-validation button in the UI.
  assert.match(await res.text(), /nonexistent-model not found/);
});

test('voiceClientConfig redacts the key and reports capability', () => {
  assert.equal(voiceClientConfig({ port: 3000, providers: [] }), null);

  const full = voiceClientConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: 'http://x/v1',
      apiKey: 'sk-secret',
      sttModel: 'whisper',
      ttsModel: 'kokoro',
      lang: 'it-IT',
    },
  });
  assert.deepEqual(full, { enabled: true, configured: true, canSpeak: true, lang: 'it-IT' });
  assert.ok(!JSON.stringify(full).includes('sk-secret'));

  const noTts = voiceClientConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: 'http://x/v1', sttModel: 'whisper' },
  });
  assert.equal(noTts?.canSpeak, false);

  const noEndpoint = voiceClientConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: '', sttModel: 'whisper' },
  });
  assert.equal(noEndpoint?.configured, false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/cli/web/voice_proxy.test.ts
```

Expected: FAIL — `Cannot find module './voice_proxy.js'`.

- [ ] **Step 4: Write the implementation**

Create `packages/cli/src/cli/web/voice_proxy.ts`:

```ts
import type { Hono } from 'hono';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';
// One definition, in the bridge — the CLI already imports types from there
// (server.ts:51) and webview-ui is a workspace dependency.
import type { VoiceClientConfig } from 'webview-ui/bridge';
import { loadConfig } from '../../store/json.js';
import { decrypt, isEncrypted } from '../../lib/encryption.js';

export function voiceClientConfig(config: CaretakerConfig): VoiceClientConfig | null {
  const voice = config.voice;
  if (!voice) return null;
  const out: VoiceClientConfig = {
    enabled: voice.enabled === true,
    configured: typeof voice.endpoint === 'string' && voice.endpoint.trim().length > 0,
    canSpeak: typeof voice.ttsModel === 'string' && voice.ttsModel.trim().length > 0,
  };
  if (voice.lang) out.lang = voice.lang;
  return out;
}

/** Resolve the usable voice config, or a reason it cannot be used. */
async function resolveVoice(): Promise<{ voice: VoiceConfig } | { error: string }> {
  const config = await loadConfig();
  const voice = config.voice;
  if (!voice || voice.enabled !== true) {
    return { error: 'Voice mode is disabled. Enable it in Settings → Voice.' };
  }
  if (!voice.endpoint || voice.endpoint.trim().length === 0) {
    return { error: 'No voice endpoint configured. Set one in Settings → Voice.' };
  }
  return { voice };
}

function authHeaders(voice: VoiceConfig): Record<string, string> {
  if (!voice.apiKey) return {};
  const key = isEncrypted(voice.apiKey) ? decrypt(voice.apiKey) : voice.apiKey;
  return { authorization: `Bearer ${key}` };
}

/** Join a base URL and a path without doubling or dropping the slash. */
function url(endpoint: string, suffix: string): string {
  return `${endpoint.replace(/\/+$/, '')}${suffix}`;
}

export function registerVoiceProxy(app: Hono): void {
  app.post('/api/voice/transcribe', async (c) => {
    const resolved = await resolveVoice();
    if ('error' in resolved) return c.text(resolved.error, 503);
    const { voice } = resolved;
    if (!voice.sttModel) return c.text('No transcription model configured.', 400);

    const incoming = await c.req.formData();
    const file = incoming.get('file');
    if (!file) return c.text('No audio uploaded (expected a "file" part).', 400);

    const form = new FormData();
    form.set('file', file);
    form.set('model', voice.sttModel);
    if (voice.lang) form.set('language', voice.lang.split('-')[0]);

    let upstream: Response;
    try {
      upstream = await fetch(url(voice.endpoint, '/audio/transcriptions'), {
        method: 'POST',
        headers: authHeaders(voice),
        body: form,
      });
    } catch (err) {
      return c.text(`Could not reach the voice endpoint: ${err}`, 502);
    }

    // Propagate failures verbatim: with no validation button in the UI, a wrong
    // model id must surface as the provider's own message.
    if (!upstream.ok) {
      return c.body(await upstream.arrayBuffer(), upstream.status as any, {
        'content-type': upstream.headers.get('content-type') ?? 'text/plain',
      });
    }
    return c.body(await upstream.arrayBuffer(), 200, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
  });

  app.post('/api/voice/speak', async (c) => {
    const resolved = await resolveVoice();
    if ('error' in resolved) return c.text(resolved.error, 503);
    const { voice } = resolved;
    if (!voice.ttsModel) return c.text('No synthesis model configured.', 400);

    const { text } = await c.req.json<{ text?: string }>();
    if (!text || text.trim().length === 0) return c.text('No text to speak.', 400);

    const payload: Record<string, unknown> = { model: voice.ttsModel, input: text };
    if (voice.ttsVoice) payload.voice = voice.ttsVoice;

    let upstream: Response;
    try {
      upstream = await fetch(url(voice.endpoint, '/audio/speech'), {
        method: 'POST',
        headers: { ...authHeaders(voice), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return c.text(`Could not reach the voice endpoint: ${err}`, 502);
    }

    if (!upstream.ok) {
      return c.body(await upstream.arrayBuffer(), upstream.status as any, {
        'content-type': upstream.headers.get('content-type') ?? 'text/plain',
      });
    }
    return c.body(await upstream.arrayBuffer(), 200, {
      'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
    });
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/cli/web/voice_proxy.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 6: Mount it on the real server**

In `packages/cli/src/cli/web/server.ts`, next to where the other route groups are registered (the `app.get('/api/...')` block starting around line 235), add the import at the top:

```ts
import { registerVoiceProxy, voiceClientConfig } from './voice_proxy.js';
```

and the registration inside the same function that declares the other routes:

```ts
  registerVoiceProxy(app);
```

`voiceClientConfig` is imported now but used in Task 4.

- [ ] **Step 7: Typecheck and run the full CLI suite**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
```

Expected: typecheck clean; the whole suite green (it was green before this task — any new failure is yours).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cli/web/voice_proxy.ts packages/cli/src/cli/web/voice_proxy.test.ts packages/cli/src/cli/web/server.ts
git commit -m "feat(voice): transcribe and speak proxy endpoints keeping the api key server-side"
```

---

### Task 4: Deliver the redacted config to the renderer

**Files:**
- Modify: `packages/webview-ui/src/bridge.ts` (add a `HostToView` variant, near lines 66-90)
- Modify: `packages/cli/src/cli/web/server.ts` (post after `agentsLoaded` at line 691, and on `saveConfig` at lines 956-960)
- Modify: `packages/vscode-extension/src/sidebar.ts` (post `null`)

**Interfaces:**
- Consumes: `voiceClientConfig()` from Task 3.
- Produces: `HostToView` variant `{ type: 'voiceConfig'; voice: VoiceClientConfig | null }`. Task 7 reads this.

- [ ] **Step 1: Extend the bridge contract**

`VoiceClientConfig` already exists in `bridge.ts` from Task 3. Add one variant to the
`HostToView` union:

```ts
  | { type: 'voiceConfig'; voice: VoiceClientConfig | null }
```

No change to `ViewToHost` and therefore none to `parseViewToHost` — this message only travels host → view. (There is no `parseHostToView`; the view trusts its host.)

- [ ] **Step 2: Post it from the web server**

In `packages/cli/src/cli/web/server.ts`, immediately after the existing `post({ type: 'agentsLoaded', agents: agentSummaries });` (line 691):

```ts
        post({ type: 'voiceConfig', voice: voiceClientConfig(await loadConfig()) });
```

and in the `case 'saveConfig':` handler (lines 956-960), after `await saveConfig(msg.config);`:

```ts
              post({ type: 'voiceConfig', voice: voiceClientConfig(msg.config) });
```

- [ ] **Step 3: Post null from the VSCode host**

In `packages/vscode-extension/src/sidebar.ts`, wherever the host sends its initial `agentsLoaded` message to the webview, send alongside it:

```ts
    void this.postMessage({ type: 'voiceConfig', voice: null });
```

Voice is unavailable in the sidebar (its CSP is `default-src 'none'` and webviews are not granted a microphone), so `null` is the honest value. Match the file's existing post/`postMessage` helper name rather than introducing a new one.

- [ ] **Step 4: Typecheck every package**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F caretaker-vscode build
pnpm -F webview-ui build
```

Expected: all clean. The `HostToView` union is exhaustively switched in `App.tsx`, so if the compiler complains there, that is Task 7's job — add a `case 'voiceConfig':` that does nothing for now if needed to keep the build green, and replace it in Task 7.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/bridge.ts packages/cli/src/cli/web/server.ts packages/vscode-extension/src/sidebar.ts
git commit -m "feat(voice): deliver redacted voice config to the renderer"
```

---

### Task 5: Serve the Silero VAD assets

**Files:**
- Modify: `packages/webview-ui/package.json` (add `@ricky0123/vad-web` dependency)
- Modify: `packages/webview-ui/esbuild.config.mjs` (copy VAD assets into `dist/vad/`)
- Modify: `packages/cli/src/cli/web/server.ts` (serve `/vad/:file`, beside the existing `/standalone.css` route at line 222)
- Create: `THIRD-PARTY-NOTICES.md` (repo root)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /vad/<file>` serving `bundle.min.js`, `vad.worklet.bundle.min.js`, `silero_vad_v5.onnx`, and the `onnxruntime-web` `.wasm`/`.mjs` runtime files. Task 6 loads `/vad/bundle.min.js` and points the library's `baseAssetPath` at `/vad/`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm -F webview-ui add @ricky0123/vad-web
pnpm install
```

`onnxruntime-web` arrives transitively (it is `vad-web`'s only dependency).

- [ ] **Step 2: Record the license notices**

Create `THIRD-PARTY-NOTICES.md` at the repo root:

```markdown
# Third-party notices

Caretaker is distributed under the Functional Source License 1.1 (MIT Future
License); see LICENSE. It redistributes the following third-party components,
whose own notices are reproduced as their licenses require.

## @ricky0123/vad-web — ISC License

Copyright (c) ricky0123

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Silero VAD model weights (bundled in @ricky0123/vad-web) — MIT License

Copyright (c) Silero Team

## onnxruntime-web — MIT License

Copyright (c) Microsoft Corporation
```

Then copy the full MIT license text into the two MIT sections, taken verbatim from
`node_modules/onnxruntime-web/LICENSE` and the MIT block of
`node_modules/@ricky0123/vad-web/LICENSE`. Do not paraphrase license text.

- [ ] **Step 3: Copy the assets at build time**

In `packages/webview-ui/esbuild.config.mjs`, alongside the existing `copyHtml()` helper, add:

```js
// The VAD library is NOT bundled: webview-ui builds a single iife with no code
// splitting, so a dynamic import would be inlined and grow the bundle for every
// user, voice or not. Instead its assets are served and the script is injected on
// demand (see useVoice.ts). Assets stay local — a CDN would break offline use.
const copyVadAssets = () => {
  const dest = 'dist/vad';
  fs.mkdirSync(dest, { recursive: true });

  const files = [
    ['node_modules/@ricky0123/vad-web/dist/bundle.min.js', 'bundle.min.js'],
    ['node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
    ['node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
    ['node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', 'silero_vad_legacy.onnx'],
  ];

  // onnxruntime-web ships its wasm/mjs runtime files; the VAD loads them by name
  // from the same base path.
  const ortDir = 'node_modules/onnxruntime-web/dist';
  for (const name of fs.readdirSync(ortDir)) {
    if (name.startsWith('ort-wasm') && (name.endsWith('.wasm') || name.endsWith('.mjs'))) {
      files.push([path.join(ortDir, name), name]);
    }
  }

  for (const [from, to] of files) {
    if (!fs.existsSync(from)) {
      console.warn(`[webview-ui] VAD asset missing, skipping: ${from}`);
      continue;
    }
    fs.copyFileSync(from, path.join(dest, to));
  }
  console.log(`[webview-ui] copied ${files.length} VAD assets -> ${dest}`);
};

copyVadAssets();
```

Add `import path from 'path';` at the top of the file next to the existing `import fs from 'fs';`.

Because `pnpm` uses a virtual store, verify the real on-disk paths before trusting the list above:

```bash
ls packages/webview-ui/node_modules/@ricky0123/vad-web/dist/
ls packages/webview-ui/node_modules/onnxruntime-web/dist/ | head -20
```

Adjust the paths and filenames to what is actually there. If `bundle.min.js` is absent, list the package's `dist` and use the file its README names for script-tag loading.

- [ ] **Step 4: Verify the copy works**

```bash
pnpm -F webview-ui build
ls packages/webview-ui/dist/vad/
```

Expected: `bundle.min.js`, the worklet, at least `silero_vad_v5.onnx`, and one or more `ort-wasm*` files.

No unit test here: this is build glue with no branching logic, and the next step's `curl` is the real check. `scripts/copy-webview.mjs` already copies the whole `webview-ui/dist` tree recursively, so these files reach the published npm package with no change to that script.

- [ ] **Step 5: Serve them**

In `packages/cli/src/cli/web/server.ts`, beside the existing `/standalone.css` route (line 222), add:

```ts
  app.get('/vad/:file', (c) => {
    const name = c.req.param('file');
    // Serve only from the flat vad directory; reject any traversal attempt.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return c.text('Not found', 404);
    const full = path.join(webviewDistPath, 'vad', name);
    if (!fs.existsSync(full)) return c.text('Not found', 404);
    const type = name.endsWith('.wasm')
      ? 'application/wasm'
      : name.endsWith('.onnx')
        ? 'application/octet-stream'
        : name.endsWith('.mjs') || name.endsWith('.js')
          ? 'text/javascript'
          : 'application/octet-stream';
    return c.body(fs.readFileSync(full), 200, { 'content-type': type });
  });
```

The filename regex is the guard: the parameter comes from the URL, and `path.join` alone would happily accept `../`.

- [ ] **Step 6: Verify end to end**

```bash
CARETAKER_HOME=/tmp/ct-voice pnpm -F @hyperwindmill/caretaker-cli dev web &
sleep 4
curl -sI http://127.0.0.1:3000/vad/bundle.min.js | head -3
curl -sI http://127.0.0.1:3000/vad/silero_vad_v5.onnx | head -3
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3000/vad/..%2f..%2fpackage.json'
kill %1
```

Expected: `200` for the two assets with sensible content types, and `404` for the traversal attempt.

- [ ] **Step 7: Commit**

```bash
git add packages/webview-ui/package.json packages/webview-ui/esbuild.config.mjs packages/cli/src/cli/web/server.ts THIRD-PARTY-NOTICES.md pnpm-lock.yaml
git commit -m "feat(voice): serve self-hosted silero vad assets"
```

---

### Task 6: The `useVoice` hook

**Files:**
- Create: `packages/webview-ui/src/useVoice.ts`

**Interfaces:**
- Consumes: everything from Task 2 (`nextPhase`, `VoicePhase`, `VoiceMode`, `SpokenItem`, `toBcp47`, `stripMarkdownForSpeech`, `lastSpokenText`, the three timing constants); `VoiceClientConfig` from `./bridge.js` (Task 3); `/api/voice/transcribe` and `/api/voice/speak` from Task 3; `/vad/*` from Task 5.
- Produces:

```ts
export type UseVoiceResult = {
  available: boolean;
  phase: VoicePhase;
  mode: VoiceMode;
  setMode: (mode: VoiceMode) => void;
  toggle: () => void;
  error: string | null;
};

export function useVoice(opts: {
  voice: VoiceClientConfig | null;
  chatStatus: 'idle' | 'streaming' | 'error';
  pendingConfirmCount: number;
  /** App's ChatItem[] satisfies this structurally. */
  items: readonly SpokenItem[];
  onTranscript: (text: string, mode: VoiceMode) => void;
}): UseVoiceResult;
```

Task 7 consumes exactly this shape.

- [ ] **Step 1: Write the hook**

Create `packages/webview-ui/src/useVoice.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceClientConfig } from './bridge.js';
import {
  nextPhase,
  toBcp47,
  stripMarkdownForSpeech,
  lastSpokenText,
  END_OF_TURN_MS,
  IDLE_WINDOW_MS,
  POST_PLAYBACK_MS,
  type SpokenItem,
  type VoiceMode,
  type VoicePhase,
} from './voice_utils.js';

export type UseVoiceResult = {
  available: boolean;
  phase: VoicePhase;
  mode: VoiceMode;
  setMode: (mode: VoiceMode) => void;
  toggle: () => void;
  error: string | null;
};

/** The Web Speech API is NOT usable here: in Electron both SpeechRecognition
 *  constructors exist but recognition fails with error:network and synthesis
 *  reports zero voices. Capability detection therefore keys off capture, which
 *  the probe confirmed works. See the design spec. */
function canCapture(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

type VadInstance = { start: () => void; pause: () => void; destroy: () => void };

/** Load the VAD library from the served assets. Not bundled — see esbuild.config.mjs. */
let vadScriptPromise: Promise<any> | null = null;
function loadVadLibrary(): Promise<any> {
  if (vadScriptPromise) return vadScriptPromise;
  vadScriptPromise = new Promise((resolve, reject) => {
    const existing = (window as any).vad;
    if (existing) return resolve(existing);
    const script = document.createElement('script');
    script.src = '/vad/bundle.min.js';
    script.onload = () => {
      const lib = (window as any).vad;
      lib ? resolve(lib) : reject(new Error('VAD library loaded but window.vad is missing'));
    };
    script.onerror = () => reject(new Error('Could not load /vad/bundle.min.js'));
    document.head.appendChild(script);
  });
  return vadScriptPromise;
}

export function useVoice(opts: {
  voice: VoiceClientConfig | null;
  chatStatus: 'idle' | 'streaming' | 'error';
  pendingConfirmCount: number;
  items: readonly SpokenItem[];
  onTranscript: (text: string, mode: VoiceMode) => void;
}): UseVoiceResult {
  const { voice, chatStatus, pendingConfirmCount, items, onTranscript } = opts;

  const available = !!voice && voice.enabled && voice.configured && canCapture();
  const canSpeak = !!voice?.canSpeak;
  const lang = toBcp47(voice?.lang, typeof navigator !== 'undefined' ? navigator.language : 'en-US');

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [mode, setMode] = useState<VoiceMode>('dictate');
  const [error, setError] = useState<string | null>(null);

  // Latest-value refs so async callbacks never read stale state.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadRef = useRef<VadInstance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heardSpeechRef = useRef(false);
  /** INVARIANT 3: `chatStatus` is still 'idle' between onTranscript and the socket
   *  round-trip. Without this, the loop would advance immediately and speak the
   *  previous reply. */
  const sawStreamingRef = useRef(false);

  const apply = useCallback((event: Parameters<typeof nextPhase>[1]) => {
    setPhase((current) => nextPhase(current, event));
  }, []);

  const clearIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  };

  const teardownCapture = useCallback(() => {
    clearIdleTimer();
    try {
      vadRef.current?.destroy();
    } catch {
      /* the library throws if already destroyed; nothing to do */
    }
    vadRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    chunksRef.current = [];
    heardSpeechRef.current = false;
  }, []);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
  }, []);

  const fail = useCallback(
    (message: string) => {
      teardownCapture();
      stopPlayback();
      setError(message);
      apply({ kind: 'failed', mode: modeRef.current });
    },
    [apply, teardownCapture, stopPlayback],
  );

  /** Stop the recorder and hand the audio to the transcription proxy. */
  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      teardownCapture();
      try {
        const form = new FormData();
        form.set('file', blob, 'turn.webm');
        const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
        if (!res.ok) return fail(await res.text());
        const { text } = (await res.json()) as { text?: string };
        const trimmed = (text ?? '').trim();
        const currentMode = modeRef.current;
        if (trimmed) {
          if (currentMode === 'conversation') sawStreamingRef.current = false;
          onTranscriptRef.current(trimmed, currentMode);
        }
        apply({ kind: 'transcribed', mode: currentMode, empty: trimmed.length === 0 });
      } catch (err) {
        fail(`Transcription failed: ${err}`);
      }
    };
    recorder.stop();
  }, [apply, fail, teardownCapture]);

  /** Open the mic. In conversation mode the VAD decides when the turn is over; in
   *  dictation the user does, because dictating involves pauses. */
  const startRecording = useCallback(async () => {
    setError(null);
    chunksRef.current = [];
    heardSpeechRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorderRef.current = recorder;
      recorder.start();

      if (modeRef.current === 'conversation') {
        const lib = await loadVadLibrary();
        const vad = await lib.MicVAD.new({
          stream,
          baseAssetPath: '/vad/',
          onnxWASMBasePath: '/vad/',
          redemptionFrames: Math.round(END_OF_TURN_MS / 32), // ~32 ms per frame
          onSpeechStart: () => {
            heardSpeechRef.current = true;
            clearIdleTimer();
          },
          onSpeechEnd: () => {
            if (phaseRef.current !== 'recording') return;
            apply({ kind: 'speechEnded', mode: 'conversation' });
            finishRecording();
          },
        });
        vadRef.current = vad;
        vad.start();

        // Nothing said at all within the idle window ends the loop.
        idleTimerRef.current = setTimeout(() => {
          if (heardSpeechRef.current) return;
          teardownCapture();
          apply({ kind: 'idleWindowElapsed', mode: 'conversation' });
        }, IDLE_WINDOW_MS);
      }
    } catch (err) {
      fail(`Microphone unavailable: ${err}`);
    }
  }, [apply, fail, finishRecording, teardownCapture]);

  /** Synthesize and play the reply, then reopen the mic on playback end. */
  const speakReply = useCallback(async () => {
    const text = lastSpokenText(itemsRef.current);
    if (!text) {
      apply({ kind: 'playbackEnded', mode: 'conversation' });
      return;
    }
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: stripMarkdownForSpeech(text) }),
      });
      if (!res.ok) return fail(await res.text());
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        // INVARIANT 1: the mic reopens here and nowhere else. Reopening on the
        // harness `done` event instead is what makes the agent transcribe itself.
        setTimeout(() => apply({ kind: 'playbackEnded', mode: 'conversation' }), POST_PLAYBACK_MS);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        fail('Could not play the synthesized reply.');
      };
      await audio.play();
    } catch (err) {
      fail(`Synthesis failed: ${err}`);
    }
  }, [apply, fail]);

  // Observe streaming so `awaiting` can distinguish "my turn started" from
  // "the previous turn was already finished".
  useEffect(() => {
    if (chatStatus === 'streaming') sawStreamingRef.current = true;
  }, [chatStatus]);

  // Drive the awaiting → speaking/recording transition off the existing chat
  // reducer rather than adding protocol events.
  useEffect(() => {
    if (phase !== 'awaiting') return;
    if (chatStatus === 'error') {
      apply({ kind: 'failed', mode: 'conversation' });
      return;
    }
    apply({
      kind: 'turnFinished',
      mode: 'conversation',
      canSpeak,
      sawStreaming: sawStreamingRef.current,
      confirmPending: pendingConfirmCount > 0,
    });
  }, [phase, chatStatus, pendingConfirmCount, canSpeak, apply]);

  // Perform the side effect each phase implies. One effect, so the phase is the
  // single source of truth for what the hook is doing.
  const prevPhase = useRef<VoicePhase>('idle');
  useEffect(() => {
    const from = prevPhase.current;
    prevPhase.current = phase;
    if (from === phase) return;
    if (phase === 'recording') void startRecording();
    if (phase === 'speaking') void speakReply();
    if (phase === 'idle') {
      teardownCapture();
      stopPlayback();
    }
  }, [phase, startRecording, speakReply, teardownCapture, stopPlayback]);

  // Release the mic and stop audio if the component unmounts mid-loop.
  useEffect(
    () => () => {
      teardownCapture();
      stopPlayback();
    },
    [teardownCapture, stopPlayback],
  );

  const toggle = useCallback(() => {
    if (!available) return;
    const current = phaseRef.current;
    if (current === 'idle') {
      apply({ kind: 'micClick', mode: modeRef.current });
      return;
    }
    if (current === 'recording' && modeRef.current === 'dictate') {
      apply({ kind: 'micClick', mode: 'dictate' });
      finishRecording();
      return;
    }
    apply({ kind: 'userStop', mode: modeRef.current });
  }, [available, apply, finishRecording]);

  const changeMode = useCallback(
    (next: VoiceMode) => {
      apply({ kind: 'userStop', mode: modeRef.current });
      setMode(next);
    },
    [apply],
  );

  return { available, phase, mode, setMode: changeMode, toggle, error };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -F webview-ui build
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

Expected: clean. `lang` is computed but only used once the transcription proxy needs it — the server already sends `language` from config, so if the compiler flags `lang` as unused, delete the local rather than inventing a use for it.

- [ ] **Step 3: Confirm the pure tests still pass**

```bash
pnpm -F webview-ui test
```

Expected: PASS. The hook has no test of its own by design (no DOM harness in this repo); its decisions all live in `voice_utils.ts`, which is fully covered.

- [ ] **Step 4: Commit**

```bash
git add packages/webview-ui/src/useVoice.ts
git commit -m "feat(voice): useVoice hook driving capture, vad, transcription and playback"
```

---

### Task 7: Composer UI, App wiring, and the settings tab

**Files:**
- Modify: `packages/webview-ui/src/Composer.tsx` (props at lines 5-13, controls row at lines 144-161)
- Modify: `packages/webview-ui/src/App.tsx` (message switch around line 343, Composer render around line 851)
- Create: `packages/webview-ui/src/VoiceTab.tsx`
- Modify: `packages/webview-ui/src/SettingsPanel.tsx` (`TabId` union line 35, `renderTabContent` line 70, tab buttons from line 144)
- Modify: `packages/webview-ui/src/styles.css` (classes used below)

**Interfaces:**
- Consumes: `useVoice` (Task 6), `VoiceClientConfig` and the `voiceConfig` message (Task 4), `VoiceConfig` (Task 1).
- Produces: user-visible affordances. Nothing downstream depends on these signatures.

- [ ] **Step 1: Extend Composer props and render the control**

In `packages/webview-ui/src/Composer.tsx`, add to `ComposerProps`:

```ts
  /** Voice control, or null when voice is unavailable on this surface. */
  voice?: {
    phase: 'idle' | 'recording' | 'transcribing' | 'awaiting' | 'speaking';
    mode: 'dictate' | 'conversation';
    canSpeak: boolean;
    setMode: (mode: 'dictate' | 'conversation') => void;
    toggle: () => void;
  } | null;
```

Destructure `voice = null` in the signature. Then, immediately after the attach `<input type="file" …>` (line 161), insert:

```tsx
        {voice && (
          <div className="composer__voice">
            <button
              type="button"
              className={`composer__action-btn${
                voice.phase === 'recording'
                  ? ' composer__action-btn--recording'
                  : voice.phase === 'speaking'
                    ? ' composer__action-btn--speaking'
                    : ''
              }`}
              title={voice.phase === 'idle' ? 'Start voice' : 'Stop voice'}
              aria-label={voice.phase === 'idle' ? 'Start voice' : 'Stop voice'}
              aria-pressed={voice.phase !== 'idle'}
              onClick={voice.toggle}
              disabled={voice.phase === 'transcribing'}
            >
              <MicIcon size={16} />
            </button>
            {voice.canSpeak && (
              <select
                className="composer__voice-mode"
                value={voice.mode}
                onChange={(e) => voice.setMode(e.target.value as 'dictate' | 'conversation')}
                disabled={voice.phase !== 'idle'}
                aria-label="Voice mode"
              >
                <option value="dictate">Dictate</option>
                <option value="conversation">Conversation</option>
              </select>
            )}
            <span role="status" aria-live="polite" className="composer__voice-status">
              {voice.phase === 'recording'
                ? 'Listening…'
                : voice.phase === 'transcribing'
                  ? 'Transcribing…'
                  : voice.phase === 'speaking'
                    ? 'Speaking…'
                    : ''}
            </span>
          </div>
        )}
```

The mode selector appears only when a synthesis model is configured — without one there is no conversation to offer.

Add `MicIcon` to the existing import from `./icons.js`. `icons.ts` is a re-export
barrel over `lucide-react` (no hand-written SVG), so the whole change is one line in
the aliased export list, beside `Paperclip as AttachIcon`:

```ts
  Mic as MicIcon,
```

- [ ] **Step 2: Wire it in App**

In `packages/webview-ui/src/App.tsx`:

Add state near the other top-level state:

```tsx
  const [voiceConfig, setVoiceConfig] = useState<VoiceClientConfig | null>(null);
```

Add a case to the host-message switch (beside `case 'contextUsage':` around line 369):

```tsx
        case 'voiceConfig':
          setVoiceConfig(msg.voice);
          return;
```

Call the hook after `chatState` is available:

```tsx
  const voice = useVoice({
    voice: voiceConfig,
    chatStatus: chatState.status,
    pendingConfirmCount: chatState.pendingConfirms.length,
    items: chatState.items,
    onTranscript: (text, mode) => {
      if (mode === 'conversation') onSend(text);
      else setComposerDraft((draft) => (draft ? `${draft} ${text}` : text));
    },
  });
```

Dictation writes into the composer draft rather than sending. If `Composer` currently owns its draft in local state (it does — `const [value, setValue] = useState('')` at line 14), lift that state into `App` as `composerDraft` and pass `value`/`onValueChange` down, so dictation has something to write into. This is the one structural change in the task; keep it mechanical and do not alter send behaviour.

Pass the control down:

```tsx
        voice={
          voice.available
            ? {
                phase: voice.phase,
                mode: voice.mode,
                canSpeak: voiceConfig?.canSpeak ?? false,
                setMode: voice.setMode,
                toggle: voice.toggle,
              }
            : null
        }
```

Surface voice errors through the existing error element (line ~856) rather than adding a second error surface: `{(chatState.errorText || voice.error) && …}`.

- [ ] **Step 3: Build the settings tab**

Create `packages/webview-ui/src/VoiceTab.tsx`. The class names below (`glass-form`,
`glass-form__body`, `form-group`, `form-group--checkbox`, `form-actions`) are the ones
`McpTab.tsx` already uses — read it if anything looks off, but do not invent new ones.

```tsx
import { useState } from 'react';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';

export interface VoiceTabProps {
  config: CaretakerConfig;
  onSave: (config: CaretakerConfig) => void;
}

const EMPTY: VoiceConfig = { enabled: false, endpoint: '', sttModel: '' };

export function VoiceTab({ config, onSave }: VoiceTabProps) {
  const current = config.voice ?? EMPTY;
  const [enabled, setEnabled] = useState(current.enabled);
  const [endpoint, setEndpoint] = useState(current.endpoint);
  const [apiKey, setApiKey] = useState(current.apiKey ?? '');
  const [sttModel, setSttModel] = useState(current.sttModel);
  const [ttsModel, setTtsModel] = useState(current.ttsModel ?? '');
  const [ttsVoice, setTtsVoice] = useState(current.ttsVoice ?? '');
  const [lang, setLang] = useState(current.lang ?? '');

  const save = () => {
    const voice: VoiceConfig = { enabled, endpoint: endpoint.trim(), sttModel: sttModel.trim() };
    if (apiKey.trim()) voice.apiKey = apiKey.trim();
    if (ttsModel.trim()) voice.ttsModel = ttsModel.trim();
    if (ttsVoice.trim()) voice.ttsVoice = ttsVoice.trim();
    if (lang.trim()) voice.lang = lang.trim();
    onSave({ ...config, voice });
  };

  return (
    <div className="glass-form">
      <h4>Voice</h4>
      <div className="glass-form__body">
        <div className="form-group form-group--checkbox">
          <label htmlFor="voice-enabled">
            <input
              id="voice-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable voice mode
          </label>
        </div>

        <div className="form-group">
          <label htmlFor="voice-endpoint">Speech Endpoint</label>
          <input
            id="voice-endpoint"
            type="text"
            placeholder="http://127.0.0.1:8000/v1"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <small>
            OpenAI-compatible speech endpoint — e.g. a local Speaches container.
            Transcription posts to <code>/audio/transcriptions</code>, synthesis to{' '}
            <code>/audio/speech</code>. Leave the synthesis fields empty for dictation
            only. Voice is unavailable in the VSCode sidebar.
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-key">API Key (optional)</label>
          <input
            id="voice-key"
            type="password"
            placeholder="Leave empty for a local server with no auth"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <small>Stored encrypted. Never sent to the browser — requests are proxied.</small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-stt">Transcription Model</label>
          <input
            id="voice-stt"
            type="text"
            placeholder="e.g. Systran/faster-whisper-small"
            value={sttModel}
            onChange={(e) => setSttModel(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="voice-tts">Synthesis Model (optional)</label>
          <input
            id="voice-tts"
            type="text"
            placeholder="e.g. speaches-ai/Kokoro-82M-v1.0-ONNX"
            value={ttsModel}
            onChange={(e) => setTtsModel(e.target.value)}
          />
          <small>Required for conversation mode. Without it, only dictation is offered.</small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-voice">Voice (optional)</label>
          <input
            id="voice-voice"
            type="text"
            placeholder="e.g. af_heart"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="voice-lang">Language (optional)</label>
          <input
            id="voice-lang"
            type="text"
            placeholder="e.g. it-IT — defaults to the browser language"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
```

Register it in `SettingsPanel.tsx`: import it beside the other tabs (lines 5-10), add
`'voice'` to the `TabId` union (line 35), add the case in `renderTabContent` (line 70):

```tsx
      case 'voice':
        return <VoiceTab config={config} onSave={onSaveConfig} />;
```

and a tab button matching the existing pattern (from line 144). Use the prop names the
sibling tabs already receive for config and save — read the `ProvidersTab` call site at
line 74 and match it rather than assuming `onSaveConfig`.

- [ ] **Step 4: Add the styles**

In `packages/webview-ui/src/styles.css`, append:

```css
.composer__voice {
  display: flex;
  align-items: center;
  gap: 4px;
}

.composer__voice-mode {
  font-size: 11px;
  padding: 2px 4px;
  background: transparent;
  color: inherit;
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 4px;
}

.composer__voice-status {
  font-size: 11px;
  opacity: 0.7;
  min-width: 74px;
}

.composer__action-btn--recording {
  color: #e5484d;
  animation: composer-voice-pulse 1.4s ease-in-out infinite;
}

.composer__action-btn--speaking {
  animation: composer-voice-pulse 1.4s ease-in-out infinite;
}

@keyframes composer-voice-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
```

If the file already defines a colour variable for a danger/red state, use it in place of
the literal `#e5484d` — grep for `--` custom properties near the top before adding the
hex. `.composer__action-btn--speaking` deliberately inherits its colour so it picks up
whatever accent the surrounding theme uses.

- [ ] **Step 5: Build everything**

```bash
pnpm build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

Expected: all five packages build, tests green, typecheck clean.

- [ ] **Step 6: Manual verification against a real speech server**

This feature cannot be verified by unit tests alone — the whole point is the loop's feel.

```bash
docker run --rm -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
```

Confirm the exact image tag from the Speaches README before running; if it differs, use theirs.

Then in a second shell:

```bash
CARETAKER_HOME=/tmp/ct-voice pnpm -F @hyperwindmill/caretaker-cli dev web
```

Open `http://127.0.0.1:3000`, go to Settings → Voice, enable it, set the endpoint to
`http://127.0.0.1:8000/v1`, set `sttModel` and `ttsModel` to models the container
actually serves, save. Then verify, in order:

1. The mic button appears in the composer without a reload (the `voiceConfig` message arrives on save).
2. **Dictation:** click the mic, speak, click again. The text lands in the composer draft and is not sent.
3. **Conversation:** switch mode, click the mic, speak, stop speaking. Within roughly a second the turn is sent, the agent replies, the reply is read aloud, and the mic reopens on its own.
4. **The self-transcription check:** during step 3, confirm the next turn does not begin with the agent's own words. This is the failure invariant 1 exists to prevent.
5. **Silence stop:** with the mic open, say nothing for ten seconds. The loop returns to idle by itself.
6. **Confirm gate:** configure an agent with a `[!]` confirm-each-call tool and ask it to use that tool in conversation mode. The loop must stop and wait at the confirmation rather than reopening the mic or hanging silently.
7. **Bad configuration:** set `sttModel` to `nope`, speak. The composer must show the provider's own error text, not a generic failure.
8. **VSCode:** launch the extension (F5) and confirm no mic button appears.

- [ ] **Step 7: Commit**

```bash
git add packages/webview-ui/src
git commit -m "feat(voice): mic control, conversation loop wiring, and voice settings tab"
```

---

### Task 8: Documentation and changeset

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Create: `.changeset/voice-mode.md`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update CLAUDE.md**

Add a subsection under the architecture layers describing: the `voice` block in `caretaker.json` and that its `apiKey` is encrypted at rest; the two proxy endpoints and why they are proxies (the key must not reach the browser); that the loop is derived from the `chatState` reducer rather than new protocol events; the three invariants; and the surface matrix (web GUI and desktop yes, VSCode and TUI no).

Include the Electron finding explicitly — it is the single most valuable thing to record, because without it someone will "simplify" this back to the Web Speech API:

> The Web Speech API is unusable in Electron even though it is present: recognition
> fails with `error:network` (no Google speech API keys in an Electron build) and
> `speechSynthesis` reports zero voices and `synthesis-failed`. Capability detection
> must key off `MediaRecorder`/`getUserMedia`, never off the presence of
> `SpeechRecognition` or `speechSynthesis`.

Also note that `packages/webview-ui` now has a `test` script, so its co-located tests run under `pnpm test`.

- [ ] **Step 2: Update README.md**

Add a user-facing Voice section: what the two modes do, that it needs an
OpenAI-compatible speech endpoint, a copy-pasteable Speaches Docker command as the
recommended fully-local setup, the settings fields, that dictation works with no
synthesis model configured, and that voice is unavailable in the VSCode sidebar.

- [ ] **Step 3: Write the changeset**

Create `.changeset/voice-mode.md`:

```markdown
---
'@hyperwindmill/caretaker-cli': minor
---

Voice mode in the chat: dictate into the composer, or hold a hands-free
conversation where the agent's reply is read aloud and the mic reopens for the
next turn. Configure an OpenAI-compatible speech endpoint under Settings → Voice
— a local Speaches container keeps everything on your machine. Available in the
web GUI and the desktop app.
```

The five packages are one fixed group, so naming the published package is enough.

- [ ] **Step 4: Verify the whole repo**

```bash
pnpm build
pnpm test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

Expected: all green. Report the actual counts.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/voice-mode.md
git commit -m "docs(voice): document voice mode and add changeset"
```

---

## Notes for the implementer

**The Web Speech API is not an option.** If you find yourself thinking "this would be
much simpler with `webkitSpeechRecognition`" — it was measured, in this project's own
Electron, and it does not work. The spec records the exact event sequences.

**Do not add a DOM test harness.** The absence of one is why `voice_utils.ts` exists.
If you find yourself wanting to test the hook, that is a signal that a decision
belongs in `voice_utils.ts` instead.

**`pnpm test` does not typecheck.** It runs through `tsx`. Run
`pnpm -F @hyperwindmill/caretaker-cli typecheck` separately; several tasks above make
type-level changes that tests will happily ignore.

**Verify paths inside `node_modules` before trusting Task 5's list.** pnpm's virtual
store means the layout may differ from the plan; the plan tells you to check, so check.
Note that `copyVadAssets` *warns and continues* on a missing file — so a wrong path
produces a green build and a runtime failure. Confirm with `ls dist/vad/` (Task 5,
Step 4), not with the build exiting 0.

**The pre-commit hook will block every commit until Task 8.** `.husky/pre-commit`
requires a `.changeset/*.md` file to be **staged in that same commit** whenever the
branch is not `main`/`master`. The changeset for this feature is written once, in
Task 8. So commit Tasks 1-7 with `--no-verify` and let Task 8's commit satisfy the
hook normally. Do **not** create seven throwaway changesets to appease it — the five
packages are one fixed group and each file becomes a separate changelog entry.
