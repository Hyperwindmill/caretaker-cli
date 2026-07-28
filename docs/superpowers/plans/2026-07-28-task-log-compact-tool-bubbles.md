# Task log — compact tool bubbles — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autonomous task **log** more compact. Replace the full-width
`<details>` tool blocks with left-aligned, content-width "bubbles" (pills) showing a
shortened preview; the full args expand in a clip-safe floating popover on
hover/focus (preview) and on click (pinned, scrollable). Scope the change to the
task log only — main chat and scheduler keep the existing block.

**Architecture:** Add an internal `compact?: boolean` prop to `MessageList`, threaded
to `Item`. In `Item`'s `'tool'` case, `compact` selects a new `ToolBubble`
(chip + fixed popover); otherwise the existing `ToolBlock` (unchanged). Only
`TaskLogView` passes `compact`. The popover is `position: fixed` because `.messages`
(`overflow-y: auto`) clips both axes — an in-flow/absolute popover near the edge
would be clipped. The one bit of real logic (clamp + flip placement) is a pure
`popoverPosition()` helper in `toolFormat.ts`, unit-tested.

**Tech Stack:** TypeScript ESM, React, esbuild, Node built-in test runner via tsx,
pnpm workspaces, Changesets.

**Spec:** `docs/superpowers/specs/2026-07-28-task-log-compact-tool-bubbles-design.md`

## Global Constraints

- **Scope discipline:** do NOT restyle `ToolBlock` or touch the main chat
  (`App.tsx`) / scheduler (`SchedulerTab.tsx`) tool rendering. They show persisted
  results and keep click-to-expand. Only the task log opts into `compact`.
- **Clip constraint:** the hover/pin popover MUST be `position: fixed` (viewport
  anchored). Do NOT implement it as an absolutely-positioned child of the chip — it
  would be clipped by `.messages`' both-axis overflow.
- **TDD:** the only extractable logic is `popoverPosition()` — write its test first
  and watch it fail (Strict TDD). `ToolBubble` itself is presentational DOM wiring
  with no extractable logic; no component test (the file has none and there is
  nothing pure to assert), consistent with prior UI-only plans. Verified by
  typecheck + build + manual e2e.
- Conventional commits, **no** Co-Authored-By / AI attribution.
- Tests: Node built-in runner via tsx, co-located `*.test.ts`, run from repo root.
  `pnpm -F webview-ui test` runs webview tests; also run
  `pnpm -F @hyperwindmill/caretaker-cli typecheck` (the CLI project typechecks the
  workspace types) and `pnpm -F webview-ui build`.
- Every change needs a changeset (`.changeset/*.md`, five-package fixed group;
  this one: `patch`).
- Docs (`CLAUDE.md` §7, `README.md`) updated in the same unit of work.

---

### Task 1: Pure helper — `popoverPosition` (TDD)

**Files:**
- Modify: `packages/webview-ui/src/toolFormat.ts` (append at end)
- Create: `packages/webview-ui/src/toolFormat.test.ts`

**Interfaces:**
- Produces: `popoverPosition(rect, vw, vh, gap?, width?)` → `{ left, top?, bottom?, maxWidth }`.
  Consumed by `ToolBubble` in Task 2.

- [ ] **Step 1: Write the failing test**

Create `packages/webview-ui/src/toolFormat.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popoverPosition } from './toolFormat.js';

test('popoverPosition opens below the chip when it is in the upper viewport', () => {
  const p = popoverPosition({ top: 100, left: 40, bottom: 120 }, 1000, 800);
  assert.equal(p.top, 126); // bottom + gap(6)
  assert.equal(p.bottom, undefined);
  assert.equal(p.left, 40);
});

test('popoverPosition flips above when the chip is in the lower ~40% of the viewport', () => {
  const p = popoverPosition({ top: 600, left: 40, bottom: 620 }, 1000, 800);
  // 600 > 800 * 0.6 → open upward, anchored by `bottom`
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, 800 - 600 + 6); // vh - rect.top + gap
});

test('popoverPosition clamps left into the viewport', () => {
  const wide = popoverPosition({ top: 100, left: 950, bottom: 120 }, 1000, 800, 6, 480);
  // maxWidth = min(480, 1000-16) = 480; left clamped to 1000 - 8 - 480 = 512
  assert.equal(wide.maxWidth, 480);
  assert.equal(wide.left, 512);

  const off = popoverPosition({ top: 100, left: -50, bottom: 120 }, 1000, 800);
  assert.equal(off.left, 8); // never less than 8
});

test('popoverPosition shrinks maxWidth on a narrow viewport', () => {
  const p = popoverPosition({ top: 100, left: 10, bottom: 120 }, 300, 800, 6, 480);
  assert.equal(p.maxWidth, 300 - 16); // min(480, vw-16)
  assert.equal(p.left, 8); // min(10, 300-8-284)=10 → but clamped to >=8; 10 stays? see impl note
});
```

> Impl note for the last assertion: with `vw=300`, `maxWidth=284`, the upper clamp is
> `300 - 8 - 284 = 8`, so `left = max(8, min(10, 8)) = 8`. Keep the test asserting `8`.

- [ ] **Step 2: Run the test — verify it fails**

```bash
pnpm -F webview-ui exec tsx --test packages/webview-ui/src/toolFormat.test.ts
```
Expected: FAILS (`popoverPosition` is not exported → import/TypeError).

- [ ] **Step 3: Implement the helper**

Append to `packages/webview-ui/src/toolFormat.ts`:

```ts
/** Placement of the compact tool-bubble popover. `.messages` clips both axes
 *  (overflow-y:auto forces overflow-x to auto), so the popover is position:fixed
 *  and this computes its viewport coordinates: clamp horizontally, and flip above
 *  the chip when it sits low enough that opening below would run off-screen. */
export interface PopoverPos {
  left: number;
  top?: number;
  bottom?: number;
  maxWidth: number;
}

export function popoverPosition(
  rect: { top: number; left: number; bottom: number },
  vw: number,
  vh: number,
  gap = 6,
  width = 480,
): PopoverPos {
  const maxWidth = Math.min(width, vw - 16);
  const left = Math.max(8, Math.min(rect.left, vw - 8 - maxWidth));
  const placeAbove = rect.top > vh * 0.6;
  return placeAbove
    ? { left, bottom: vh - rect.top + gap, maxWidth }
    : { left, top: rect.bottom + gap, maxWidth };
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
pnpm -F webview-ui exec tsx --test packages/webview-ui/src/toolFormat.test.ts
```
Expected: all four tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/toolFormat.ts packages/webview-ui/src/toolFormat.test.ts
git commit -m "feat(webview): add popoverPosition helper for compact tool bubbles"
```

---

### Task 2: `ToolBubble` component + `compact` prop threading

**Files:**
- Modify: `packages/webview-ui/src/MessageList.tsx`

**Interfaces:**
- Consumes: `popoverPosition`, `toolSummary`, `prettyArgs`, `resultMetric`
  (`toolFormat.js`); `ToolIcon`, `SpinnerIcon` (`icons.js`); `MarkdownText`.
- Produces: `compact?: boolean` on `MessageListProps`; `ToolBubble` component.
  Consumed by `TaskLogView` in Task 3.

No component test: presentational DOM wiring, no extractable pure logic (the pure
part is Task 1's `popoverPosition`, already tested). Verified by typecheck + build +
Task 4 manual check.

- [ ] **Step 1: Extend the imports + props**

In `packages/webview-ui/src/MessageList.tsx`, add the helper import and the
`useCallback` React hook as needed. Update line 5 to include `popoverPosition`:

```ts
import { prettyArgs, resultMetric, toolSummary, popoverPosition } from './toolFormat.js';
```

Add `compact` to `MessageListProps` (after `agentName`):

```ts
export interface MessageListProps {
  items: ChatItem[];
  sessionId?: string | null;
  trailing?: ReactNode;
  isStreaming?: boolean;
  agentName?: string;
  /** Task log: render tool calls as compact left-aligned bubbles (no persisted
   *  results there), instead of full-width <details> blocks. */
  compact?: boolean;
}
```

Destructure `compact` in the component signature and pass it into the item map:

```tsx
export const MessageList = memo(function MessageList({
  items,
  sessionId = null,
  trailing,
  isStreaming,
  agentName,
  compact = false,
}: MessageListProps) {
```

```tsx
      {items.map((item, i) => (
        <Item key={i} item={item} sessionId={sessionId} compact={compact} />
      ))}
```

- [ ] **Step 2: Thread `compact` through `Item`**

Change the `Item` signature and its `'tool'` case:

```tsx
const Item = memo(function Item({
  item,
  sessionId,
  compact,
}: {
  item: ChatItem;
  sessionId: string | null;
  compact: boolean;
}) {
```

```tsx
    case 'tool':
      return compact ? <ToolBubble item={item} /> : <ToolBlock item={item} />;
```

- [ ] **Step 3: Add the `ToolBubble` component**

Add `useState`, `useEffect`, `useRef` are already imported on line 1. Add
`ToolBubble` right after `ToolBlock` (after line 128):

```tsx
// Compact left-aligned "chip" rendering of a tool call for the task log, where
// results are not persisted so a full-width block per call is pure noise. The
// full args live in a hover/focus PREVIEW and a click-to-PIN popover that must
// escape `.messages`' overflow clip (overflow-y:auto forces overflow-x to auto,
// clipping both axes), so it is position:fixed and anchored to the chip's
// measured rect via popoverPosition().
const ToolBubble = memo(function ToolBubble({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const chipRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const summary = toolSummary(item.args);
  const fullArgs = prettyArgs(item.args);
  const hasResult = item.result !== null && item.result !== '';
  const hasDetail = Boolean(fullArgs) || hasResult;
  const open = hasDetail && (hovering || pinned);

  // Keep the fixed popover glued while open: re-measure the chip on scroll
  // (capture phase, so it catches the inner .messages scroller) and on resize.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (chipRef.current) setRect(chipRef.current.getBoundingClientRect());
    };
    measure();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setHovering(false);
      }
    };
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Dismiss a pinned popover on an outside click.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (chipRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setPinned(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [pinned]);

  const pos = open && rect ? popoverPosition(rect, window.innerWidth, window.innerHeight) : null;

  return (
    <div className="tool-bubble-wrap">
      <div
        ref={chipRef}
        className={`tool-bubble${open ? ' tool-bubble--open' : ''}`}
        tabIndex={hasDetail ? 0 : -1}
        role={hasDetail ? 'button' : undefined}
        aria-expanded={hasDetail ? open : undefined}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        onClick={() => hasDetail && setPinned((p) => !p)}
        onKeyDown={(e) => {
          if (hasDetail && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setPinned((p) => !p);
          }
        }}
      >
        <span className="tool-bubble__icon"><ToolIcon size={12} /></span>
        <span className="tool-bubble__name">{item.name}</span>
        {summary && <span className="tool-bubble__summary">{summary}</span>}
        <span className="tool-bubble__status">
          {item.result === null ? (
            <SpinnerIcon className="tool__spinner" size={12} />
          ) : hasResult ? (
            resultMetric(item.result)
          ) : null}
        </span>
      </div>
      {pos && (
        <div
          ref={popoverRef}
          className={`tool-bubble__popover${pinned ? ' tool-bubble__popover--pinned' : ''}`}
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            maxWidth: pos.maxWidth,
            pointerEvents: pinned ? 'auto' : 'none',
          }}
        >
          {fullArgs && <pre className="tool-bubble__args">{fullArgs}</pre>}
          {hasResult && (
            <div className="tool-bubble__result">
              <MarkdownText content={item.result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
});
```

> Type note: inside the `hasResult` branch `item.result` is a non-empty string, but
> TypeScript won't narrow it from `hasResult`. `resultMetric(item.result)` and
> `<MarkdownText content={item.result} />` may need `item.result as string` (or an
> inline `item.result &&` guard) to satisfy `strict`. Add the cast only if typecheck
> complains.

- [ ] **Step 4: Build + typecheck**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: build clean, webview tests PASS (incl. Task 1), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/MessageList.tsx
git commit -m "feat(webview): add compact tool-bubble renderer with hover/pin popover"
```

---

### Task 3: Wire the task log + styles

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (the `<MessageList>` in `TaskLogView`, ~line 1373)
- Modify: `packages/webview-ui/src/styles.css` (after the Tool Execution Console block, ~line 742)

**Interfaces:**
- Consumes: `compact` prop from Task 2.
- Produces: `.tool-bubble*` styles. Nothing downstream.

- [ ] **Step 1: Pass `compact` in `TaskLogView`**

In `packages/webview-ui/src/ProjectsTab.tsx`, change the task-log render (~line 1373):

```tsx
            <MessageList items={chatItems} sessionId={null} compact />
```

- [ ] **Step 2: Add the styles**

In `packages/webview-ui/src/styles.css`, after the Tool Execution Console section
(after the `.tool__result-content .markdown-body pre` rule, ~line 742), add:

```css
/* --------------------------------------------------------------------------
   6b. Compact tool bubbles (task log)
   Content-width chip that floats left; full args revealed in a clip-safe
   position:fixed popover on hover (preview) / click (pinned, scrollable).
   -------------------------------------------------------------------------- */
.tool-bubble-wrap {
  align-self: flex-start; /* shrink to content and sit at the left edge */
  max-width: 100%;
}

.tool-bubble {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #8c8c8c);
  background: oklch(0.2 0.02 240 / 0.6);
  border: 1px solid var(--glass-border);
  border-left: 2px solid var(--accent-cyan);
  cursor: default;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  animation: fadeInUp 0.24s ease forwards;
}

.tool-bubble:hover,
.tool-bubble--open {
  background: oklch(0.24 0.03 240 / 0.75);
}

.tool-bubble:focus-visible {
  outline: 1px solid var(--accent-cyan);
  outline-offset: 1px;
}

.tool-bubble__icon {
  color: var(--accent-cyan);
  display: inline-flex;
  flex: none;
}

.tool-bubble__name {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--vscode-foreground);
  flex: none;
}

.tool-bubble__summary {
  font-family: var(--font-mono);
  opacity: 0.8;
  min-width: 0;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-bubble__status {
  font-family: var(--font-mono);
  opacity: 0.7;
  flex: none;
}

.tool-bubble__popover {
  z-index: 60;
  padding: 8px;
  max-height: 320px;
  overflow: hidden; /* preview: no scroll, capped */
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: var(--vscode-editorHoverWidget-background, oklch(0.16 0.02 240));
  box-shadow: 0 8px 24px oklch(0 0 0 / 0.35);
}

.tool-bubble__popover--pinned {
  overflow: auto; /* pinned: interactive + scrollable for long args */
}

.tool-bubble__args {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-all;
}

.tool-bubble__result {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed oklch(1 0 0 / 0.08);
  font-size: 11.5px;
}

body.vscode-light .tool-bubble {
  background: oklch(0.96 0.01 240);
  border-color: oklch(0 0 0 / 0.08);
}

body.vscode-light .tool-bubble__popover {
  background: #fff;
}
```

> If any referenced CSS variable is absent (`--glass-border`, `--accent-cyan`,
> `--font-mono`, `--radius-md`, `--transition-fast`, `fadeInUp` keyframe), grep
> `styles.css` first and reuse the exact tokens the existing `.tool` rules use — do
> not invent new ones.

- [ ] **Step 3: Build + typecheck**

```bash
pnpm -F webview-ui build
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: clean.

- [ ] **Step 4: Manual end-to-end check**

```bash
CARETAKER_HOME=/tmp/ct-toolbubbles pnpm -F @hyperwindmill/caretaker-cli dev web
```
In the web GUI: Projects → open a task with an execution log (or create one and let
a cycle run so `tool_call` messages exist). Verify:
1. Tool calls render as small left-aligned pills, not full-width blocks; the log is
   visibly more compact.
2. Hovering a pill shows a floating popover with the full args, correctly positioned
   (below in the upper half, flipped above near the bottom), never clipped by the
   scroll area — including the topmost and bottommost pills.
3. Clicking a pill pins the popover (stays open, scrollable for long args); Escape,
   an outside click, or clicking the pill again dismisses it.
4. Scrolling the log while a popover is open keeps it glued to its pill.
5. Keyboard: Tab to a pill → preview appears on focus; Enter/Space pins/unpins.
6. Open the **main chat** and the **Scheduler** active-run view: tool rendering is
   UNCHANGED (full-width `<details>` blocks with click-to-expand results).
7. Toggle a light theme (if available) and confirm the pill/popover are legible.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/ProjectsTab.tsx packages/webview-ui/src/styles.css
git commit -m "feat(webview): use compact tool bubbles in the task execution log"
```

---

### Task 4: Docs + changeset

**Files:**
- Modify: `CLAUDE.md` (§7 Chat rendering)
- Modify: `README.md` (task-log / UI description)
- Create: `.changeset/task-log-compact-tool-bubbles.md`

**Interfaces:**
- Consumes: the feature as shipped by Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Update `CLAUDE.md` §7**

In the §7 "Chat rendering" section, add a bullet (next to "Collapsed tool bodies are
not mounted") describing the compact variant:

```
- **The task log renders tool calls as compact bubbles, not blocks.** `MessageList`
  takes a `compact` prop (only `TaskLogView` sets it). In compact mode a tool call is
  a left-aligned content-width chip (`ToolBubble`) instead of the full-width
  `<details>` `ToolBlock`; the full args expand in a hover/focus preview and a
  click-to-pin popover. That popover is `position: fixed` on purpose: `.messages` is
  `overflow-y: auto`, which forces `overflow-x` to compute to `auto`, so an
  in-flow/absolute popover near the container edge would be clipped — a fixed,
  viewport-anchored popover (placed by `popoverPosition()`) escapes the clip. The
  main chat and scheduler stay on `ToolBlock` because their tool results are
  persisted and click-to-expand is the right affordance there; task-log tool calls
  carry no result (`result: ''`), so the block would only add chrome.
```

- [ ] **Step 2: Update `README.md`**

Find the section describing the autonomous task log / task view (grep for "task log"
or the task/project UI description) and add one sentence:

```
In the task execution log, tool calls render as compact left-aligned bubbles —
hover (or focus) one for a preview of its full arguments, or click to pin an
expandable popover — keeping the log readable even when a cycle touches many files.
```

If no such section exists, add it to the paragraph that describes the Projects/task
UI. Keep it to one sentence.

- [ ] **Step 3: Create the changeset**

Create `.changeset/task-log-compact-tool-bubbles.md`:

```md
---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
'caretaker-vscode': patch
'caretaker-desktop': patch
'caretaker-types': patch
---

Make the autonomous task execution log more compact: tool calls now render as
left-aligned bubbles with a shortened preview instead of full-width blocks. Hover or
focus a bubble to preview its full arguments; click to pin an expandable, scrollable
popover. The main chat and scheduler views are unchanged.
```

- [ ] **Step 4: Full verification**

```bash
pnpm -F webview-ui test
pnpm -F webview-ui build
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: all PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/task-log-compact-tool-bubbles.md
git commit -m "docs: document compact tool bubbles in the task log"
```

---

## Done when

- Task log tool calls are compact left-aligned bubbles; hover/focus previews and
  click pins a clip-safe fixed popover with the full args.
- Main chat and scheduler tool rendering is byte-for-byte unchanged.
- `popoverPosition` is unit-tested; `pnpm -F webview-ui test`, `build`, and CLI
  `typecheck` are all green.
- `CLAUDE.md` §7, `README.md`, and a `patch` changeset are updated.
