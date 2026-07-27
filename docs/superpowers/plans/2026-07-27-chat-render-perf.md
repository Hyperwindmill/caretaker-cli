# Chat Rendering Performance on Long Conversations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 200k-token conversation stays typeable and keeps streaming smoothly in the web
GUI, the desktop app and the VSCode sidebar.

**Root cause (already investigated — do not re-investigate):** the composer draft lives in
`App` state, so every keystroke re-renders `MessageList`, and `MarkdownText` re-parses every
item's markdown in its render body with no memoization — O(whole conversation) work per
keystroke and per streaming chunk. Collapsed tool `<details>` bodies are mounted and parsed
too. Both hosts already send *incremental* chunks, so nothing on the CLI/extension side is at
fault; the fix is entirely in `packages/webview-ui`.

**Architecture:** new pure `markdown.ts` module with an LRU parse cache; `React.memo` on
`MarkdownText`, `Item` and `MessageList` with reference-stable props from the three call
sites; collapsed tool bodies rendered only when open. Virtualization deliberately not added.

**Tech Stack:** React 19, TypeScript ESM, esbuild, Node built-in test runner via tsx, pnpm
workspaces, Changesets.

**Spec:** `docs/superpowers/specs/2026-07-27-chat-render-perf-design.md`

## Global Constraints

- Only `packages/webview-ui` source changes (plus docs and the changeset). No new runtime
  dependency — no `react-window`, no `dompurify`.
- Behaviour must not change: same markdown output, same sanitizing, same stick-to-bottom
  scroll, same streaming caret, same tool/thinking blocks.
- `webview-ui`'s test script is `tsx --test "src/**/*.test.ts"` — **`.ts` only**, no DOM, no
  React testing library. Testable logic goes in pure modules; components are verified by
  build + typecheck + the manual check in Task 4.
- Conventional commits, **no** Co-Authored-By / AI attribution. Commit after each task.
- Changeset required (`.changeset/*.md`, all five packages, `patch`).
- `CLAUDE.md` must be updated in the same unit of work.

---

### Task 1: Cache markdown parsing in a pure module

**Files:**
- Create: `packages/webview-ui/src/markdown.ts`
- Create: `packages/webview-ui/src/markdown.test.ts`
- Modify: `packages/webview-ui/src/MarkdownText.tsx` (whole file)

**Interfaces:**
- Consumes: `marked` (already a dependency).
- Produces: `renderMarkdown(content: string): string`, plus test seams
  `markdownCacheSizeForTest()` / `resetMarkdownCacheForTest(limit?)`. Task 2 and Task 3 rely
  on `MarkdownText` being a memoized component.

- [ ] **Step 1: Write the failing tests**

Create `packages/webview-ui/src/markdown.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, markdownCacheSizeForTest, resetMarkdownCacheForTest } from './markdown.js';

test('renders gfm markdown', () => {
  resetMarkdownCacheForTest();
  const html = renderMarkdown('**bold** and `code`');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('strips script tags and inline event handlers', () => {
  resetMarkdownCacheForTest();
  const html = renderMarkdown('<script>alert(1)</script><p onclick="alert(1)">hi</p>');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onclick/i);
});

test('a repeated key is served from the cache instead of growing it', () => {
  resetMarkdownCacheForTest();
  const first = renderMarkdown('# same');
  assert.equal(markdownCacheSizeForTest(), 1);
  const second = renderMarkdown('# same');
  assert.equal(second, first);
  assert.equal(markdownCacheSizeForTest(), 1);
});

test('evicts the least-recently-used entry past the limit', () => {
  resetMarkdownCacheForTest(2);
  renderMarkdown('a');
  renderMarkdown('b');
  renderMarkdown('a'); // touching 'a' makes 'b' the oldest
  renderMarkdown('c'); // evicts 'b'
  assert.equal(markdownCacheSizeForTest(), 2);
  renderMarkdown('a');
  assert.equal(markdownCacheSizeForTest(), 2, "'a' should still be cached");
  renderMarkdown('b');
  assert.equal(markdownCacheSizeForTest(), 2, "'b' was evicted, re-adding it evicts 'c'");
});

// The regression guard for the actual bug: re-rendering a whole conversation must not
// re-parse it. Ratio, not absolute time, so it holds on any machine.
test('a cached second pass over a long conversation is far cheaper than the first', () => {
  resetMarkdownCacheForTest();
  const docs = Array.from(
    { length: 800 },
    (_, i) => `## Item ${i}\n\nSome **text** with \`code\` and a list:\n\n- one\n- two\n`,
  );
  const cold = process.hrtime.bigint();
  for (const d of docs) renderMarkdown(d);
  const afterCold = process.hrtime.bigint();
  for (const d of docs) renderMarkdown(d);
  const afterWarm = process.hrtime.bigint();

  const coldNs = Number(afterCold - cold);
  const warmNs = Number(afterWarm - afterCold);
  assert.ok(
    warmNs * 5 < coldNs,
    `expected the cached pass to be >5x faster (cold ${coldNs}ns, warm ${warmNs}ns)`,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm -F webview-ui exec tsx --test src/markdown.test.ts
```
Expected: all five FAIL — the module does not exist yet.

- [ ] **Step 3: Create `markdown.ts`**

`sanitize()` moves here verbatim from `MarkdownText.tsx` (same regexes, same comment intent
— it is not a full DOMPurify replacement and stays that way).

```ts
// Markdown → sanitized HTML, with an LRU cache in front of the parser.
//
// Why the cache: the chat re-renders on every composer keystroke and every
// streaming chunk. Parsing every bubble again on each of those is
// O(whole conversation) work per render, which is what froze 200k-token
// sessions. Keyed on the raw content string, so a bubble that has not changed
// is a Map hit.
//
// LRU, not a plain bounded map: a render pass touches every visible item, so
// stable bubbles stay hot while the growing prefixes of the currently
// streaming bubble (a new key per chunk, never touched again) age out first.

import { marked } from 'marked';

/** Strip dangerous tags/attributes while keeping formatting elements. Lightweight
 *  on purpose — not a full DOMPurify replacement, but sufficient for an AI chat
 *  whose source we control. */
function sanitize(html: string): string {
  // Remove script, style, iframe, object, embed, form, input
  const dangerous = /<(script|style|iframe|object|embed|form|input|button|textarea)[^>]*>.*?<\/\1>|<(script|style|iframe|object|embed|form|input|button|textarea)[^>]*>/gi;
  const sanitized = html.replace(dangerous, '');

  // Remove event handlers (onclick, onerror, etc.) and javascript: URLs
  const eventHandlers = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
  const noEvents = sanitized.replace(eventHandlers, '');

  const jsUrls = /href\s*=\s*["']\s*javascript:[^"']*["']/gi;
  return noEvents.replace(jsUrls, 'href="#"');
}

// ponytail: entries keyed by the full content string; hash the key if the
// duplicated text ever costs more than the parse it saves. The limit has to
// exceed the item count of a realistic conversation, otherwise a single render
// pass evicts entries it still needs later in the same pass.
let cacheLimit = 2000;
const cache = new Map<string, string>();

export function renderMarkdown(content: string): string {
  const hit = cache.get(content);
  if (hit !== undefined) {
    // Map keeps insertion order: re-inserting marks this the most recent.
    cache.delete(content);
    cache.set(content, hit);
    return hit;
  }
  const html = sanitize(marked.parse(content, { breaks: true, gfm: true }) as string);
  cache.set(content, html);
  if (cache.size > cacheLimit) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return html;
}

export function markdownCacheSizeForTest(): number {
  return cache.size;
}

export function resetMarkdownCacheForTest(limit = 2000): void {
  cache.clear();
  cacheLimit = limit;
}
```

- [ ] **Step 4: Rewrite `MarkdownText.tsx` on top of it**

Replace the whole file:

```tsx
// Markdown renderer. Parsing + sanitizing live in ./markdown.ts behind a cache;
// this component is memoized so an unchanged bubble is not even revisited.

import { memo } from 'react';

import { renderMarkdown } from './markdown.js';

export interface MarkdownTextProps {
  content: string;
  inline?: boolean;
}

export const MarkdownText = memo(function MarkdownText({ content, inline = false }: MarkdownTextProps) {
  const html = renderMarkdown(content);

  if (inline) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
});
```

- [ ] **Step 5: Verify**

```bash
pnpm -F webview-ui exec tsx --test src/markdown.test.ts
pnpm -F webview-ui build
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: five tests PASS, build clean, typecheck clean. (`MarkdownText` is imported as a
value in several files — a `memo` wrapper keeps that valid.)

- [ ] **Step 6: Commit**

```bash
git add packages/webview-ui/src/markdown.ts packages/webview-ui/src/markdown.test.ts packages/webview-ui/src/MarkdownText.tsx
git commit -m "perf(webview): cache markdown parsing behind an LRU and memoize MarkdownText"
```

---

### Task 2: Stop a keystroke from re-rendering the thread

**Files:**
- Modify: `packages/webview-ui/src/MessageList.tsx` (`MessageList` export ~line 19, `Item` ~line 77)
- Modify: `packages/webview-ui/src/App.tsx` (imports ~line 12, `onConfirm` ~line 453, both `<MessageList>` call sites ~line 753 and ~line 893)
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (~line 1360)
- Modify: `packages/webview-ui/src/SchedulerTab.tsx` (~line 282)

**Interfaces:**
- Consumes: Task 1's memoized `MarkdownText`.
- Produces: `MessageList` and `Item` as memoized components whose bail-out depends on
  callers passing reference-stable `items` / `trailing`. Task 3 edits `Item`'s `tool` case.

- [ ] **Step 1: Memoize `MessageList` and `Item`**

In `MessageList.tsx`:

1. Add `memo` to the React import: `import { memo, useEffect, useRef, type ReactNode } from 'react';`
2. Change the `MessageList` declaration to a memoized export and document the props
   contract (this is the invariant that, once broken, brings the freeze back):

```tsx
/** Memoized: the composer draft lives in `App` state, so this list re-renders on
 *  every keystroke unless it can bail out. That bail-out only works while callers
 *  keep `items` and `trailing` reference-stable — pass a `useMemo`'d array, never
 *  one built inline in JSX.
 *  ponytail: memoization + a cached parser, no virtualization. If a conversation
 *  ever gets heavy enough that the DOM itself is the bottleneck, the escalation is
 *  `content-visibility` on the heavy blocks first, a windowing library only after. */
export const MessageList = memo(function MessageList({
  items,
  sessionId = null,
  trailing,
  isStreaming,
  agentName,
}: MessageListProps) {
```

Close it with `});` instead of the current `}` at the end of the component (line ~75).

3. Memoize `Item` the same way — `const Item = memo(function Item({ item, sessionId }: { item: ChatItem; sessionId: string | null }) {` … closing `});`. Props are already
   reference-stable per item: the reducer only replaces the object it changes.

- [ ] **Step 2: Make `App`'s props stable**

In `App.tsx`:

1. Extend the React import with `useCallback` and `useMemo`.
2. Wrap `onConfirm` (~line 453) in `useCallback` with `[postMessage]` (or `[]` if it only
   uses `dispatch` and `postMessage` — check the body and keep deps honest).
3. Above the `layout === 'sidebar'` return, add one memoized trailing node used by both
   call sites:

```tsx
  // Stable identity so MessageList's memo actually bails out while typing.
  const confirmCards = useMemo(
    () => chatState.pendingConfirms.map((p) => <ConfirmCard key={p.id} pending={p} onDecide={onConfirm} />),
    [chatState.pendingConfirms, onConfirm],
  );
```

   If the sidebar branch returns before that point, declare `confirmCards` next to the other
   hooks near the top of the component instead — hooks must not sit after a conditional
   return.
4. Replace the inline `trailing={chatState.pendingConfirms.map(...)}` in both call sites
   (~line 758 and ~line 898) with `trailing={confirmCards}`.

- [ ] **Step 3: Make the other two call sites stable**

- `ProjectsTab.tsx:1360`: hoist `taskMessagesToChatItems(taskMessages, agentLabels)` into a
  `useMemo` keyed on `[taskMessages, agentLabels]`, declared with the component's other
  hooks, and pass the memoized value. If `agentLabels` is itself built inline on each
  render, memoize it too (or fold its computation into the same `useMemo`) — otherwise the
  dependency changes every render and nothing is gained.
- `SchedulerTab.tsx:282`: turn `const activeRunChatItems = activeRun ? reconstructChatItems(activeRun.messages || []) : [];`
  into a `useMemo` keyed on `[activeRun]`.

- [ ] **Step 4: Verify**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: build clean, all webview tests PASS, typecheck clean. If typecheck complains
about hook deps or an unstable `postMessage`, fix the deps — do not silence with
`eslint-disable`.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/MessageList.tsx packages/webview-ui/src/App.tsx packages/webview-ui/src/ProjectsTab.tsx packages/webview-ui/src/SchedulerTab.tsx
git commit -m "perf(webview): memoize the message list so typing no longer re-renders the thread"
```

---

### Task 3: Mount collapsed tool bodies only when open

**Files:**
- Modify: `packages/webview-ui/src/MessageList.tsx` (`Item`, `tool` case ~line 152)

**Interfaces:**
- Consumes: Task 2's memoized `Item`.
- Produces: nothing consumed later.

- [ ] **Step 1: Gate the body on the open state**

A closed `<details>` still mounts its children in React — the browser only hides them. Tool
results are the largest payloads in a long session, so this is DOM and parse work for
content nobody is looking at. Extract the `tool` case into its own small component so it can
hold state (a `case` block cannot call hooks), and render the body only while open:

```tsx
function ToolItem({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  // A closed <details> still mounts its children in React; tool results are the
  // biggest strings in a long conversation, so keep them out of the DOM (and out
  // of the markdown parser) until the user actually opens the block.
  const [open, setOpen] = useState(false);
  const summary = toolSummary(item.args);
  const fullArgs = prettyArgs(item.args);
  return (
    <details className="tool" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="tool__header">
        {/* unchanged: icon, name, args summary, status, chevron */}
      </summary>
      {open && (
        <div className="tool__body">
          {fullArgs && <pre className="tool__args-full">{fullArgs}</pre>}
          {/* ponytail: '' result = no stored result (autonomous task tool calls); render args only */}
          {item.result !== null && item.result !== '' && (
            <div className="tool__result">
              <span className="tool__arrow"><ResultArrowIcon size={13} /></span>
              <div className="tool__result-content">
                <MarkdownText content={item.result} />
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
```

Keep the existing `<summary>` markup byte-for-byte (icon, `item.name`, `summary`, the
spinner / `resultMetric(item.result)` status, chevron). In `Item`, the `tool` case becomes
`return <ToolItem item={item} />;`. Add `useState` to the React import. `ChatItem`'s tool
member is exported as `ToolItem` from `App.tsx` — if that name is already imported here,
name the component `ToolBlock` instead and use the existing type.

- [ ] **Step 2: Verify**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: clean. React 19 dispatches `onToggle` on `<details>` natively, so no manual
listener is needed.

- [ ] **Step 3: Commit**

```bash
git add packages/webview-ui/src/MessageList.tsx
git commit -m "perf(webview): render tool block bodies only while expanded"
```

---

### Task 4: Measure on a real long conversation, escalate only if needed

**Files:**
- Possibly modify: `packages/webview-ui/src/styles.css` (`.tool` ~line 597, `.thinking` ~line 1238)

**Interfaces:**
- Consumes: Tasks 1–3 as shipped.
- Produces: the numbers to quote in Task 5's report, and at most the CSS change below.

- [ ] **Step 1: Get a long session in front of you**

Use the real store (the dev web server defaults to `~/.caretaker`):

```bash
ls -S ~/.caretaker/sessions/*/*.jsonl | head -3
du -h $(ls -S ~/.caretaker/sessions/*/*.jsonl | head -1)
```

If the largest file is well under ~1 MB, inflate a copy instead of hunting for the bug's
original session — same agent dir, new session id, first line (the meta record) kept as-is
and its `id` rewritten, assistant/tool lines duplicated until the file is a few MB. A short
throwaway node script under `/tmp` is fine; do **not** commit it and do **not** touch the
original file.

- [ ] **Step 2: Record the numbers**

```bash
pnpm -F @hyperwindmill/caretaker-cli dev web
```

Open `http://127.0.0.1:3000`, select the agent, open that session. In devtools →
Performance, record ~5 s while typing a sentence continuously in the composer, and note the
longest task in ms. Then check the same session with the pre-fix bundle if you want a
before/after pair (`git stash` the working tree is not needed — the commits are already in;
use `git stash`-free comparison via `git worktree`? simpler: just report the after-numbers
plus whether typing is subjectively instant). Record what you measured either way.

Also do one live turn against a real provider and confirm: the streaming caret animates,
text grows smoothly, tool blocks appear collapsed and expand on click with their result,
thinking blocks still render, and the view stays pinned to the bottom while scrolled down
but not when scrolled up.

- [ ] **Step 3: Only if typing still stutters or scrolling is janky — add the CSS**

```css
/* Let the browser skip layout/paint for off-screen tool and thinking blocks: a long
   conversation keeps hundreds of them mounted. Not applied to .bubble — its fadeInUp
   animation would replay on reveal, and bubbles are the cheap blocks. */
.tool,
.thinking {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}
```

Then re-verify that stick-to-bottom still lands exactly at the bottom on a long session
(the placeholder sizing makes `scrollHeight` an estimate). If it visibly overshoots or
undershoots, drop this step — Tasks 1–3 are the fix and this is an optimization.

If typing is instant after Tasks 1–3, **skip this step** and say so in the report. Do not add
`react-window`: that is a separate decision with a new dependency, and it is not justified
unless measurement here proves the DOM itself is the bottleneck.

- [ ] **Step 4: Commit (only if Step 3 was applied)**

```bash
git add packages/webview-ui/src/styles.css
git commit -m "perf(webview): skip off-screen layout for tool and thinking blocks"
```

---

### Task 5: Docs, changeset, full verification

**Files:**
- Modify: `CLAUDE.md` (new short subsection after §6 Voice Mode, before "### Tool sandbox")
- Create: `.changeset/chat-render-perf.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Document the invariant in `CLAUDE.md`**

Add a subsection — the point is that a future inline prop silently reintroduces the freeze:

```md
### 7. Chat rendering (shared by every surface)

`packages/webview-ui` renders the whole thread eagerly — there is no virtualization, on
purpose. What keeps that affordable on a 200k-token session:

- **Markdown is parsed once per distinct string.** `src/markdown.ts` owns `marked` +
  the HTML sanitizer behind a 2000-entry LRU (`renderMarkdown`); `MarkdownText` is a
  `memo` component on top. Parsing in the render body — the original behaviour — cost
  O(whole conversation) on every render.
- **`MessageList` and `Item` are `memo`'d, and that only works if callers keep props
  reference-stable.** The composer draft lives in `App` state (voice dictation writes
  into it), so every keystroke re-renders `App`; the list bails out only because
  `items` and `trailing` come from `useMemo` (`App`'s `confirmCards`, `ProjectsTab`'s
  task items, `SchedulerTab`'s active-run items). Passing a freshly-built array or
  closure inline re-freezes the UI on long conversations — this is the one thing to
  check when touching those call sites.
- **Collapsed tool bodies are not mounted.** A closed `<details>` still renders its
  children in React, and tool results are the largest strings in a session, so the body
  is gated on the open state.

Escalation path if a conversation ever outgrows this: `content-visibility: auto` on the
heavy blocks, then coalescing `chunk` messages in the hosts, and a windowing library only
after measurement demands it.
```

If Task 4 Step 3 was applied, mention the `content-visibility` rule as done rather than as
escalation.

- [ ] **Step 2: Create the changeset**

`.changeset/chat-render-perf.md`:

```md
---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
'caretaker-vscode': patch
'caretaker-desktop': patch
'caretaker-types': patch
---

Fix the chat UI freezing on long conversations (around 200k tokens) in the web GUI, the
desktop app and the VSCode sidebar. Markdown is now parsed once per message and cached,
the message list and its items are memoized so typing in the composer no longer re-renders
the whole thread, and collapsed tool blocks no longer mount their (often very large)
results until expanded.
```

No `README.md` change: this is a fix with no new user-facing affordance.

- [ ] **Step 3: Full verification**

```bash
pnpm build
pnpm test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: every package builds, all tests PASS, typecheck clean.

Then the VSCode surface, which is where the bug was reported:

```bash
pnpm -F caretaker-vscode build
```
Launch the extension (F5 per `packages/vscode-extension/README.md`), open the same long
session in the sidebar, and confirm typing is responsive and a live turn streams correctly.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .changeset/chat-render-perf.md
git commit -m "docs: record the chat rendering performance invariants"
```

- [ ] **Step 5: Report**

State plainly: the measured longest-task numbers from Task 4, whether the
`content-visibility` step was applied or skipped and why, which surfaces were verified
manually (web, VSCode) and which were not (desktop — it forks the same web server, so it
inherits the fix), and that virtualization was deliberately not added.
