# Telegram image support + per-chat accumulation window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Telegram images to agents as turn attachments, and merge every message a chat sends inside one window into a single agent turn.

**Architecture:** One new pure/persistence module (`telegram_window.ts`) owns the per-chat buffer, the flush decision and the merged prompt; one new module (`telegram_media.ts`) owns Telegram message classification and image download. `telegram.ts` keeps orchestration only: the poller accumulates into the buffer and flushes, and the run takes a flushed chat instead of a single message.

**Tech Stack:** TypeScript (strict, `noImplicitAny: false`), ESM, Node built-in test runner via `tsx`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-02-telegram-image-accumulation-design.md`

## Global Constraints

- All new state is written atomically: tmp file + rename, with the Windows `EACCES`/`EPERM`/`EBUSY` retry (5 attempts, exponential backoff). Never a direct `writeFile` on the destination.
- `HOLD_MS` = 180000, `WARM_MS` = 120000, `MAX_ENTRIES` = 20, `MAX_IMAGES` = 8, `MAX_FILE_BYTES` = 20 * 1024 * 1024.
- Accepted media: `photo`, and `document` whose `mime_type` starts with `image/`. Nothing else.
- The Telegram offset is committed before processing. Do not reorder this.
- Chat authorization (`telegramAllowedChats`) is checked before any `getFile` or download.
- Session id stays `telegram_<chatId>`; attachments go to that session via `saveAttachment`.
- Host-written strings shown to the agent are Italian, matching `[Allegato: ...]` in `harness/loop.ts` and `harness/history.ts`.
- Tests are co-located `*.test.ts`, run with `tsx --test`. Each test file sets `process.env.CARETAKER_HOME` to a fresh `mkdtempSync` dir at file scope before importing the module under test (see `telegram.test.ts`).
- A changeset is mandatory (Task 7), impact `minor`.

## Review Focus

1. **Unauthorized chat sends a photo** — no `getFile`, no bytes on disk, no buffer entry, no reply. Test in Task 6.
2. **Tick with zero updates and an expired buffer** — the buffer must still flush; today's `if (updates.length === 0) return;` would swallow it. Test in Task 6.
3. **Corrupt or unreadable `<taskId>.pending.json`** — treated as empty state and logged, never a thrown poller tick that wedges the service forever. Test in Task 2.
4. **`file_size` above `MAX_FILE_BYTES`** — refused in chat before `getFile` is called, not left to fail inside the Telegram API. Test in Task 4.
5. **Buffer already at capacity** — the new entry is refused out loud and the entries already buffered are untouched. Test in Task 6 (`isAtCapacity` itself is Task 1).

---

### Task 1: Window decision logic (pure)

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/telegram_window.ts`
- Test: `packages/cli/src/cli/web/scheduler/telegram_window.test.ts`

**Interfaces:**
- Consumes: `ToolAttachmentRecord` from `../../../session/types.js`.
- Produces:
  ```ts
  export const HOLD_MS = 180_000;
  export const WARM_MS = 120_000;
  export const MAX_ENTRIES = 20;
  export const MAX_IMAGES = 8;

  export interface PendingEntry {
    updateId: number;
    fromLabel: string;            // "@user", first_name, or "unknown"
    text?: string;                // msg.text ?? msg.caption, trimmed; absent when empty
    attachments: ToolAttachmentRecord[];
  }

  export interface PendingChat {
    chatId: number;
    chatLabel: string;            // title ?? username ?? String(chatId)
    chatType: string;
    entries: PendingEntry[];
    firstAt: number;              // ms epoch of the oldest buffered entry
    lastFlushAt?: number;         // ms epoch of the last flush for this chat
  }

  export interface PendingState { v: 1; chats: Record<string, PendingChat>; }

  export type FlushDecision = 'flush' | 'hold' | 'idle';
  export function decideFlush(chat: PendingChat, now: number): FlushDecision;
  export function isAtCapacity(chat: PendingChat): boolean;
  export function noTextLine(imageCount: number): string;
  export function buildMergedPrompt(chat: PendingChat, isNewSession: boolean): string;
  ```

`decideFlush` evaluates in this order: no entries → `idle`; any entry has text → `flush`; `lastFlushAt` set and `now - lastFlushAt < WARM_MS` → `flush`; `now - firstAt >= HOLD_MS` → `flush`; otherwise `hold`.

`buildMergedPrompt`, single sender: header is `From: <fromLabel>`, plus `\nChat: <chatLabel> (id: <chatId>, type: <chatType>)` when `isNewSession`, then `\n\n`, then the entry texts joined by `\n\n` — or `noTextLine(n)` when no entry has text. Mixed senders: optional `Chat: ...\n\n` prefix when `isNewSession`, then one `From: <fromLabel>\n\n<text or noTextLine(1)>` block per entry, joined by `\n\n`.

- [ ] **Step 1: Write the failing tests**

```ts
test('decideFlush returns flush when any entry has text', ...)           // text wins over a cold, fresh buffer
test('decideFlush holds an attachment-only buffer in a cold chat', ...)  // no lastFlushAt, firstAt = now → 'hold'
test('decideFlush flushes an attachment-only buffer once HOLD_MS elapsed', ...)  // now = firstAt + HOLD_MS → 'flush'
test('decideFlush flushes an attachment-only buffer in a warm chat', ...)        // lastFlushAt = now - 1000 → 'flush'
test('decideFlush holds an attachment-only buffer once the chat goes cold', ...) // lastFlushAt = now - WARM_MS → 'hold'
test('decideFlush returns idle for an empty buffer', ...)
test('isAtCapacity is true at MAX_ENTRIES entries', ...)
test('isAtCapacity is true at MAX_IMAGES attachments spread over entries', ...)
test('noTextLine is singular for one image and plural above', ...)
test('buildMergedPrompt reproduces the legacy format for one text entry', ...)
  // isNewSession false → exactly `From: @ada\n\nciao`
test('buildMergedPrompt includes the Chat block on a new session', ...)
  // → `From: @ada\nChat: Lab (id: 7, type: group)\n\nciao`
test('buildMergedPrompt joins several entries from one sender under one header', ...)
  // → `From: @ada\n\nuno\n\ndue`
test('buildMergedPrompt uses noTextLine when no entry has text', ...)
test('buildMergedPrompt gives each entry its own From line when senders differ', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/telegram_window.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the constants, types and the four functions in `telegram_window.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/telegram_window.ts packages/cli/src/cli/web/scheduler/telegram_window.test.ts
git commit -m "feat(telegram): add per-chat accumulation window decision logic"
```

---

### Task 2: Buffer persistence

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/telegram_window.ts`
- Modify: `packages/cli/src/cli/web/scheduler/telegram.ts:20-46` (`saveTelegramOffset` reuses the extracted writer)
- Test: `packages/cli/src/cli/web/scheduler/telegram_window.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function pendingStatePath(taskId: string): string;   // scheduler-logs/<taskId>.pending.json
  export async function atomicWriteFile(path: string, contents: string): Promise<void>;
  export async function loadPendingState(taskId: string): Promise<PendingState>;
  export async function savePendingState(taskId: string, state: PendingState): Promise<void>;
  ```

`atomicWriteFile` is the tmp+rename+Windows-retry loop currently inlined in `saveTelegramOffset`; move it here and have `saveTelegramOffset` call it, so the retry policy exists once. `loadPendingState` returns `{ v: 1, chats: {} }` when the file is missing, unreadable, unparsable, or not `v: 1`, and logs on the parse failure.

- [ ] **Step 1: Write the failing tests**

```ts
test('loadPendingState returns empty state when no file exists', ...)
test('savePendingState round-trips a buffered chat', ...)
test('loadPendingState returns empty state on corrupt JSON', ...)   // write "{ not json", expect { v: 1, chats: {} }
test('savePendingState creates scheduler-logs when missing', ...)
test('saveTelegramOffset still round-trips after the writer extraction', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL, functions not exported.

- [ ] **Step 3: Implement `atomicWriteFile`, `pendingStatePath`, `loadPendingState`, `savePendingState`; rewrite `saveTelegramOffset` to call `atomicWriteFile`**

`ensureSchedulerLogsDir()` from `./logs.js` runs before the write, as `saveTelegramOffset` already does.

- [ ] **Step 4: Run tests to verify they pass**

Run the window test file and `packages/cli/src/cli/web/scheduler/telegram.test.ts`.
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/telegram_window.ts packages/cli/src/cli/web/scheduler/telegram_window.test.ts packages/cli/src/cli/web/scheduler/telegram.ts
git commit -m "feat(telegram): persist the per-chat accumulation buffer"
```

---

### Task 3: Message classification (pure)

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/telegram_media.ts`
- Modify: `packages/cli/src/cli/web/scheduler/telegram.ts:61-78` (remove the local `TgMessage`/`TgUpdate`, import them)
- Test: `packages/cli/src/cli/web/scheduler/telegram_media.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TgPhotoSize { file_id: string; file_size?: number; }
  export interface TgDocument { file_id: string; file_size?: number; mime_type?: string; file_name?: string; }
  export interface TgMessage {
    message_id: number;
    date: number;
    chat: { id: number; type: string; title?: string; first_name?: string; username?: string };
    from?: { id: number; first_name: string; username?: string };
    text?: string;
    caption?: string;
    photo?: TgPhotoSize[];
    document?: TgDocument;
    video?: unknown; audio?: unknown; voice?: unknown; sticker?: unknown; animation?: unknown;
  }
  export interface TgUpdate { update_id: number; message?: TgMessage; }

  export type MessageClass = 'content' | 'unsupported' | 'service';
  export function classifyMessage(msg: TgMessage): MessageClass;
  export function selectImage(msg: TgMessage): { fileId: string; fileSize?: number } | null;
  export function messageText(msg: TgMessage): string | undefined;
  export function senderLabel(msg: TgMessage): string;
  ```

`classifyMessage`: `content` when the message has text, caption, `photo`, or a `document` with an `image/*` mime; `unsupported` when it carries `video`, `audio`, `voice`, `sticker`, `animation`, or a non-image `document`; `service` otherwise. `selectImage` returns the **last** element of `photo` (largest size), else the image `document`, else `null`. `messageText` returns `text ?? caption` trimmed, `undefined` when empty. `senderLabel` returns `@username`, else `first_name`, else `'unknown'`; it is what fills `PendingEntry.fromLabel`.

- [ ] **Step 1: Write the failing tests**

```ts
test('classifyMessage accepts plain text', ...)
test('classifyMessage accepts a photo with a caption', ...)
test('classifyMessage accepts a photo with no caption', ...)
test('classifyMessage accepts an image document', ...)
test('classifyMessage marks a PDF document unsupported', ...)
test('classifyMessage marks voice and sticker unsupported', ...)
test('classifyMessage marks a bare service message as service', ...)   // only message_id/date/chat
test('selectImage picks the largest photo size', ...)                  // last element of the array
test('selectImage returns null for a text-only message', ...)
test('messageText prefers text and falls back to caption', ...)
test('senderLabel prefers username over first_name', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the types and the four functions in `telegram_media.ts`, then import `TgMessage`/`TgUpdate` into `telegram.ts` instead of declaring them**

- [ ] **Step 4: Run tests and the typecheck**

Run: the media test file, then `pnpm -F @hyperwindmill/caretaker-cli typecheck`.
Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/telegram_media.ts packages/cli/src/cli/web/scheduler/telegram_media.test.ts packages/cli/src/cli/web/scheduler/telegram.ts
git commit -m "feat(telegram): classify incoming messages and select image media"
```

---

### Task 4: Image download

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/telegram_media.ts`
- Test: `packages/cli/src/cli/web/scheduler/telegram_media.test.ts`

**Interfaces:**
- Consumes: `saveAttachment` from `../../../session/store.js`, `ToolAttachmentRecord` from `../../../session/types.js`.
- Produces:
  ```ts
  export const MAX_FILE_BYTES = 20 * 1024 * 1024;
  export class FileTooLargeError extends Error {}
  export async function downloadImage(
    token: string,
    sessionId: string,
    media: { fileId: string; fileSize?: number },
    deps?: { fetchImpl?: typeof fetch },
  ): Promise<ToolAttachmentRecord>;
  ```

Throws `FileTooLargeError` **before** any network call when `media.fileSize` exceeds `MAX_FILE_BYTES`. Otherwise calls `getFile`, downloads `https://api.telegram.org/file/bot<token>/<file_path>`, derives the extension from the returned `file_path` (fallback `.jpg`) and the mime from that extension, then `saveAttachment(sessionId, buf, ext)`. The `fetchImpl` dep exists so the tests never touch the network; production passes nothing.

- [ ] **Step 1: Write the failing tests**

```ts
test('downloadImage refuses an oversized file before any request', ...)
  // fileSize = MAX_FILE_BYTES + 1, fetchImpl throws if called → rejects with FileTooLargeError
test('downloadImage stores the bytes and returns an attachment record', ...)
  // stub getFile → { file_path: 'photos/x.png' }, then raw bytes; assert record.mime === 'image/png'
  // and that the file exists under attachmentsDir(sessionId)
test('downloadImage falls back to .jpg when file_path has no extension', ...)
test('downloadImage propagates a failed getFile', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL, `downloadImage` not exported.

- [ ] **Step 3: Implement `MAX_FILE_BYTES`, `FileTooLargeError` and `downloadImage`**

- [ ] **Step 4: Run tests to verify they pass**

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/telegram_media.ts packages/cli/src/cli/web/scheduler/telegram_media.test.ts
git commit -m "feat(telegram): download image media into the session attachment store"
```

---

### Task 5: Run a flushed chat as one turn

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/telegram.ts:176-392` (`executeTelegramTaskRun`)

**Interfaces:**
- Consumes: `PendingChat`, `buildMergedPrompt` (Task 1); `ToolAttachmentRecord`.
- Produces: `async function executeTelegramTaskRun(task: ServiceConfig, chat: PendingChat): Promise<void>` — the `msg: TgMessage` and `updateId: number` parameters are gone.

Changes inside the function:
- `chatId`, `fromLabel` and the chat labels come from `chat`, not from a `TgMessage`.
- The busy-lock early return and its "session already in progress" `sendMessage` are **deleted**; the caller guarantees it never flushes a locked chat. Keep `runningTasks.add` / `delete`.
- `effectivePrompt` becomes `buildMergedPrompt(chat, isNewSession)`.
- The attachments of every entry are concatenated, in order, into one array passed both as `harness.run`'s `promptAttachments` and as the persisted user record's `attachments`, so later turns replay the images.
- `userMessage(effectivePrompt)` gains those attachments on the record it produces.

This task has no tests of its own: it is a signature and wiring change whose behaviour is pinned by Task 1 (`buildMergedPrompt`) and exercised end to end by Task 6, which injects `runChat`. Do not invent a harness mock here.

- [ ] **Step 1: Verify the current suite is green before the signature change**

Run: `pnpm -F @hyperwindmill/caretaker-cli test`
Expected: exit 0. Record the pass count.

- [ ] **Step 2: Apply the changes above**

- [ ] **Step 3: Typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: exit 0. Callers in `telegram.ts` will not compile until Task 6; adapt the single call site minimally so the typecheck passes, since Task 6 rewrites it.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/telegram.ts
git commit -m "feat(telegram): run a flushed chat window as a single agent turn"
```

---

### Task 6: Poller accumulation and flush

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/telegram.ts:394-460` (`executeTelegramPoller`)
- Test: `packages/cli/src/cli/web/scheduler/telegram_poller.test.ts` (create)

**Interfaces:**
- Consumes: everything produced by Tasks 1–5.
- Produces: `export async function accumulateAndFlush(...)` — the testable core of the tick, extracted from `executeTelegramPoller` so the test drives it without the Telegram API. Exact shape:
  ```ts
  export interface TickDeps {
    downloadImage: (sessionId: string, media: { fileId: string; fileSize?: number }) => Promise<ToolAttachmentRecord>;
    notify: (chatId: number, text: string) => Promise<void>;
    isLocked: (chatId: number) => boolean;
    runChat: (chat: PendingChat) => Promise<void>;
    now: () => number;
  }
  export async function accumulateAndFlush(
    taskId: string,
    updates: TgUpdate[],
    allowedChats: Set<string>,
    deps: TickDeps,
  ): Promise<void>;
  ```

Behaviour, in order: load the persisted state; for each update with a `message`, drop it unless the chat is allowed (**before** any download); classify it — `service` is ignored silently, `unsupported` gets a `notify` and no entry, `content` is appended; a `content` message whose chat `isAtCapacity` gets a `notify` telling the user to wait and is not appended; images are downloaded via `deps.downloadImage` and a `FileTooLargeError` or any download failure becomes a `notify` with no entry. Then, **for every chat in the state, including those with no new update**, call `decideFlush`; skip any chat where `isLocked` is true; on `flush`, clear the entries, set `lastFlushAt`, persist, and only then `await deps.runChat(flushedChat)`. Persist once more at the end.

`executeTelegramPoller` keeps the offset commit first, then calls `accumulateAndFlush` with production deps — and **must no longer return early when `updates.length === 0`**, since hold expiry and post-lock delivery both happen on empty ticks.

- [ ] **Step 1: Write the failing tests**

```ts
test('a text message flushes on the same tick', ...)
test('two messages in one tick produce a single run with both texts', ...)
test('a photo with no caption is held, then flushes after HOLD_MS', ...)  // two ticks, second with updates: []
test('a photo arriving in a warm chat flushes on the next tick', ...)     // text tick, then photo-only tick
test('a photo then a text in the same tick produce one run carrying the image', ...)
test('three photos in one tick produce one run carrying three images', ...)  // media group, merged for free
test('an empty tick still flushes an expired buffer', ...)                // Review Focus 2
test('a photo from an unauthorized chat downloads nothing and replies nothing', ...)  // Review Focus 1
test('a locked chat is not flushed and keeps its entries for the next tick', ...)
test('an unsupported document notifies the chat and buffers nothing', ...)
test('a service message is ignored without a notify', ...)
test('a download failure notifies the chat and buffers no entry', ...)
test('entries beyond MAX_ENTRIES are refused without losing the buffered ones', ...)  // Review Focus 5
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/telegram_poller.test.ts`
Expected: FAIL, `accumulateAndFlush` not exported.

- [ ] **Step 3: Implement `accumulateAndFlush` and rewire `executeTelegramPoller` to it**

Drop the per-message `for` loop and the per-chat `byChat` grouping: the window replaces both. Keep the `Promise.all` across chats so different chats still progress in parallel.

- [ ] **Step 4: Run the full suite and the typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli test` then `pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: exit 0 on both, pass count at least the number recorded in Task 5 Step 1 plus the new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/telegram.ts packages/cli/src/cli/web/scheduler/telegram_poller.test.ts
git commit -m "feat(telegram): accumulate messages per chat and flush them as one turn"
```

---

### Task 7: Documentation and changeset

**Files:**
- Modify: `CLAUDE.md` (layer 5, the Telegram bullet)
- Modify: `README.md` (the Telegram service section)
- Create: `.changeset/<generated>.md`

**Interfaces:** none.

- [ ] **Step 1: Update the Telegram bullet in `CLAUDE.md`**

It currently says messages from one `chat.id` are grouped and processed sequentially. Replace with the window: accumulation per chat, the three flush rules with their constants, the merged single turn, image attachments limited to `image/*` with the 20 MB ceiling, buffer persisted in `scheduler-logs/<taskId>.pending.json`, and the non-goal that `claude_code_runner.ts` / `acp_runner.ts` ignore `promptAttachments` so external-runner agents receive the text without the images. Describe current behaviour, not the change.

- [ ] **Step 2: Update the user-facing description in `README.md`**

What a user sees: send images, send several messages and get one reply, a caption-less image answered after about three minutes when nothing follows.

- [ ] **Step 3: Create the changeset**

Run: `pnpm run changeset` — impact `minor`, describing Telegram image support and the single-reply accumulation window.

- [ ] **Step 4: Verify the whole workspace**

Run: `pnpm -F @hyperwindmill/caretaker-cli test` and `pnpm -F @hyperwindmill/caretaker-cli build`
Expected: exit 0 on both.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset
git commit -m "docs(telegram): document the accumulation window and image support"
```
