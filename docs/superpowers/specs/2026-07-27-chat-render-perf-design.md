# Chat Rendering Performance on Long Conversations — Design

**Date:** 2026-07-27
**Task:** #27 — "Investigare freeze rendering conversazioni lunghe (200k+ token) in VSCode e web app"
**Status:** design, ready for implementation

## Problem

At roughly 200k tokens of conversation the chat UI stops responding: the user cannot
type in the composer. Reported in the VSCode sidebar, suspected in the web GUI too.

## Investigation

All surfaces (web GUI, Electron desktop, VSCode sidebar) render the same
`packages/webview-ui` bundle through the same components, and both hosts push the same
*incremental* messages (`{ type: 'chunk', text }` — `cli/src/cli/web/server.ts:962` and
`vscode-extension/src/sidebar.ts:567`). No host resends the whole history per chunk.
So the defect is entirely in the shared render path, and it is present on **every**
surface. VSCode merely feels worse: its webview shares a renderer process with the
editor and has less headroom.

Four compounding causes, measured against the code as of `82347da`:

### C1 — Composer draft state lives in `App`, above the message list

`App.tsx:326` holds `composerDraft` and passes it down (`App.tsx:782`, `App.tsx:922`) as
`value`/`onValueChange`. `Composer` supports its own internal state, but the props win
when present, so **every keystroke dispatches a state update on `App`** and re-renders
the entire subtree, `MessageList` included. This is the direct cause of "cannot type":
it is not related to streaming at all — an idle 200k-token session freezes on typing.

The lifting was introduced for voice dictation (transcription writes into the box), so
the state has to stay lifted; what must change is that a keystroke stops re-rendering
the thread.

### C2 — Markdown is re-parsed for every item on every render

`MarkdownText` (`MarkdownText.tsx:28`) calls `marked.parse()` plus three regex passes
over the produced HTML **in the render body**, with no memoization, and `Item` is not
memoized either. Every render therefore re-parses the whole conversation: ~1 MB of
markdown at 200k tokens, several hundred items. Cost is O(total conversation) per
render, paid once per keystroke (C1) and once per streaming chunk — i.e. O(N²) over a
turn.

### C3 — Collapsed `<details>` bodies are fully mounted

The `tool` case (`MessageList.tsx:152`) renders `<details className="tool">` closed, but
React still creates the children: the full `prettyArgs` `<pre>` and the tool result
rendered through `MarkdownText`. Tool results are the largest payloads in a long session
(file reads, greps — tens of KB each). They are parsed and mounted into the DOM even
though the browser never shows them. This inflates both the per-render parse cost (C2)
and the steady-state DOM size.

### C4 — Unbounded DOM + a forced reflow per render

`MessageList` renders every item (no virtualization) and its scroll effect
(`MessageList.tsx:33-51`, deps `[items, trailing, isStreaming]`) reads
`container.scrollHeight`, forcing a synchronous layout of a very large DOM on every
render pass — again once per keystroke and once per chunk.

Note the `trailing` prop is a freshly-built array on every `App` render
(`App.tsx:758`, `App.tsx:898`), and `ProjectsTab.tsx:1360` / `SchedulerTab.tsx:282`
build their `items` array inline as well, so any `memo` on `MessageList` needs stable
props to actually bail out.

## Decision

Fix C1–C3 first; they remove the O(conversation) work per keystroke/chunk, which is the
freeze. Treat C4's DOM weight as a separate, measured question and **do not add
virtualization** (`react-window` or similar) unless measurement after C1–C3 still shows
jank. Rationale: virtualization is a new dependency plus a rewrite of the list, it
fights the stick-to-bottom scroll logic and the streaming caret, and the cheap native
alternative (`content-visibility: auto` on the heavy blocks) buys most of the same
skipped layout/paint for three lines of CSS.

### Changes

1. **`webview-ui/src/markdown.ts` (new)** — move `sanitize()` there and expose
   `renderMarkdown(content)`: `marked.parse` + sanitize behind a module-level LRU
   `Map` (limit 2000 entries). LRU, not a plain cache: every render pass touches every
   visible item, so stable bubbles stay hot while the growing prefixes of the currently
   streaming bubble (a fresh key per chunk) become the least-recently-used entries and
   are the ones evicted. Pure module, `.ts` — testable under the package's
   `src/**/*.test.ts` runner, unlike a `.tsx` component.
2. **`MarkdownText`** — call `renderMarkdown`, wrap in `React.memo`.
3. **`Item`** — wrap in `React.memo`. Props are already reference-stable per item: the
   reducer replaces only the item it changes, keeping every other object identity.
4. **`MessageList`** — wrap in `React.memo`; in `App`, `useCallback` `onConfirm` and
   `useMemo` the `trailing` node so keystrokes no longer invalidate the list. `useMemo`
   the inline `items` arrays in `ProjectsTab` and `SchedulerTab` for the same reason.
   This also kills the per-keystroke forced reflow (C4): the effect stops running.
5. **`Item`, `tool` case** — render the `<details>` body only while open
   (`open` state + `onToggle`; React 19 supports the `toggle` event natively).
   Collapsed tool blocks then cost one summary row each.
6. **Only if step 5's measurement still shows jank** — `content-visibility: auto` +
   `contain-intrinsic-size` on `.tool` and `.thinking` in `styles.css`. Deliberately not
   `.bubble`: it carries a `fadeInUp` animation that would replay on reveal, and the
   bubbles are the light blocks.

### Explicitly not done

- **Virtualized list.** Escalation path if measurement demands it, recorded as a
  `ponytail:` comment on the list render.
- **Truncating oversized tool results.** Change 5 makes unopened results free; an opened
  one is a deliberate user action on a single block.
- **Coalescing `chunk` messages in the hosts** (e.g. a 50 ms flush before
  `webview.postMessage`). Would cut the render count per turn, but after change 1 a
  render is cheap and the streaming caret should stay smooth. Escalation path only.
- **Collapsing old `thinking` blocks by default.** UX change, not a perf fix; change 6
  covers their layout cost.

## Verification

- `markdown.test.ts` (node:test via tsx): markdown renders, `<script>` is stripped
  (`sanitize` had no test at all before), a repeated key does not grow the cache, the
  limit evicts the oldest, and a re-touched key survives eviction. Plus a benchmark
  assertion: 800 synthetic documents parsed then re-parsed from cache, second pass at
  least 5× faster — the check that fails if the cache is ever bypassed.
- Manual, against a real long session (biggest file under `~/.caretaker/sessions/`,
  duplicated if none is large enough): devtools Performance recording while typing,
  longest task before vs after. Then a live turn to confirm streaming, the caret,
  tool blocks opening on click, and stick-to-bottom still work.

## Consequences

- `MessageList`'s props become a contract: anything passed inline (a fresh array or
  closure) re-enables the freeze. Worth stating in `CLAUDE.md` so a future change does
  not silently undo this.
- Roughly 2–3 MB of cached HTML for a 200k-token session, bounded by the LRU limit.
