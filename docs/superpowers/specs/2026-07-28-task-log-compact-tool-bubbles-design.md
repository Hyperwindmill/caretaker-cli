# Task log — compact tool bubbles — design

**Status:** proposed
**Date:** 2026-07-28
**Scope:** `packages/webview-ui` only (shared UI, consumed by web GUI, Electron desktop, VSCode sidebar).

## 1. Problem

The autonomous task **log** (`TaskLogView` in `ProjectsTab.tsx`) renders each tool
call as a full-width, padded `<details>` block (`ToolBlock` in `MessageList.tsx`):
a 3px accent border, a card background, a drop shadow, ~10px padding. A cycle that
reads/greps a dozen files produces a dozen of these stacked full-width cards, so the
log is dominated by tool-call chrome and the actual assistant/plan/review prose is
pushed far down. The objective: **make the task log more compact** — replace the
full-line tool blocks with left-aligned "bubbles" (content-width chips) showing a
shortened preview, expanding on hover to reveal the full text.

## 2. Key constraints discovered

1. **`MessageList` / `ToolBlock` is shared** across the main chat (`App.tsx`), the
   scheduler active-run view (`SchedulerTab.tsx`), and the task log
   (`ProjectsTab.tsx`). A global restyle would regress the first two.
2. **Task-log tool calls carry no result.** `taskMessagesToChatItems` sets
   `result: ''` for stored `tool_call` messages (results are not persisted). So in
   the task log the only content worth showing is the tool **name + args** — a
   full-width block that reserves room for a result body is pure waste. The main
   chat and scheduler DO show persisted results, where click-to-expand is valuable.
3. **The scroll container clips both axes.** `.messages` sets `overflow-y: auto`;
   per CSS, an `overflow-y` other than `visible`/`clip` forces the default
   `overflow-x: visible` to compute to `auto`, so the container clips **both**
   axes. A hover popover implemented as an absolutely-positioned child of a chip
   near the container's edge would be clipped and unusable. The reveal must escape
   the clip.
4. **The task thread re-renders every 3 s** (`startThreadPolling`). `chatItems` is
   `useMemo`'d and `Item` is index-keyed and memoized; the list is append-only, so
   existing component instances persist across polls and any local UI state
   (hover/pinned) survives — same property the current `ToolBlock` `open` state
   already relies on.

## 3. Decision

### 3.1 Scope the change with a `compact` prop, do not restyle globally

Add an optional `compact?: boolean` to `MessageListProps`, thread it to `Item`, and
in `Item`'s `'tool'` case pick the renderer:

- `compact` → new **`ToolBubble`** (left-aligned chip + fixed hover/pin popover).
- otherwise → the existing **`ToolBlock`** (`<details>`, unchanged).

Only `TaskLogView` passes `compact`. Main chat and scheduler are untouched — no
result-visibility regression, minimal blast radius.

**Rejected alternative:** globally replacing `ToolBlock`. Rejected because the main
chat and scheduler show real tool results where the full-width click-to-expand block
is the right affordance; a hover popover for a large result is worse there and
breaks on touch.

### 3.2 "Float left" = content-width chip via `align-self: flex-start`

`.messages` is `display: flex; flex-direction: column`. The current tool block
spans full width. The compact bubble's wrapper sets `align-self: flex-start` so it
shrinks to its content and sits at the left edge — the "floats left" the objective
describes (not literal `float:left`). The chip is a rounded pill: tool icon + mono
tool name + a truncated one-line arg summary (`toolSummary`) + a status hint
(spinner while running, else nothing in the task log since there is no result).

### 3.3 "Expand on hover" = clip-safe **fixed-position** popover

Because the scroll container clips both axes (§2.3), the reveal is a
`position: fixed` popover anchored to the chip's measured `getBoundingClientRect()`,
so it renders relative to the viewport and is never clipped by `.messages`.

- **Hover / keyboard focus → preview.** `pointer-events: none`, capped height
  (`max-height`), shows the full args (`prettyArgs`). Non-interactive, so there is
  no hover-bridge problem (the pointer never needs to travel into it).
- **Click / Enter / Space → pin.** `pointer-events: auto`, scrollable
  (`overflow: auto`), for long args and for touch/keyboard users who cannot hover.
  Dismissed by Escape, an outside click, or toggling the chip again.
- The anchor rect is **re-measured on scroll (capture phase) and resize** while the
  popover is open, so it stays glued to the chip as the log scrolls.
- Placement flips **above** the chip when it sits in the lower ~40% of the viewport
  (so a chip near the bottom doesn't open a popover off-screen). This clamp/flip is
  the one piece of real logic and is extracted as a pure function (§3.4).
- The popover renders the same content the expanded `ToolBlock` body would: the
  pretty-printed args, and — for reuse safety, though the task log never has one —
  the result via `MarkdownText` when `item.result` is a non-empty string.

**Rejected alternative:** in-place vertical accordion (expand the chip downward on
hover). Clip-safe and simpler, but it shifts every message below on hover, does not
"float," and reads as jumpy in a live-polling log. The floating preview matches the
objective's mental model and keeps the log stable.

**Rejected alternative:** native Popover API + CSS anchor positioning. The top layer
would escape the clip, but CSS anchor positioning is not yet reliable across the web
GUI's possible browsers (Firefox/Safari), and positioning still needs JS. The
`position: fixed` + measured-rect approach works uniformly on every surface.

### 3.4 Extracted pure helper (the only unit-tested piece)

`popoverPosition(rect, vw, vh)` in `toolFormat.ts` returns
`{ left, top? , bottom?, maxWidth }`: clamps `left` into the viewport, and returns a
`top` (open below) or a `bottom` (flip above) depending on the chip's vertical
position. Pure, deterministic, unit-tested. The rest of `ToolBubble` is
presentational DOM wiring with no extractable logic — verified by typecheck, build,
and a manual end-to-end check, consistent with prior UI-only plans (e.g.
`2026-07-27-task-edit-title-objective`, Task 3).

## 4. Files

- `packages/webview-ui/src/MessageList.tsx` — `compact` prop; `ToolBubble` component;
  `Item` renderer switch.
- `packages/webview-ui/src/toolFormat.ts` — `popoverPosition` pure helper.
- `packages/webview-ui/src/toolFormat.test.ts` — new test file for `popoverPosition`
  (co-located, Node built-in runner via tsx).
- `packages/webview-ui/src/ProjectsTab.tsx` — pass `compact` to `MessageList` in
  `TaskLogView` (one line).
- `packages/webview-ui/src/styles.css` — `.tool-bubble*` styles + light-theme
  overrides.
- `CLAUDE.md` §7 (Chat rendering) — document the compact task-log variant and the
  clip-safe fixed popover.
- `README.md` — one sentence in the task-log/UI description.
- `.changeset/*.md` — `patch` (UI refinement, no public API change; `compact` is an
  internal prop, not a `webview-ui` public export).

## 5. Non-goals

- No change to what the task log stores or fetches (results still not persisted).
- No change to the main chat or scheduler tool rendering.
- No flowing of multiple chips onto one line (would require restructuring the flat
  `MessageList` item stream) — out of scope; the content-width pill already delivers
  the compactness win.
