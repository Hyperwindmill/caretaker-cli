# Chat composer autofocus — design

## Problem

The chat composer (`packages/webview-ui/src/Composer.tsx`) has **no focus logic
at all**. The `<textarea>` is `disabled` while a turn is streaming, while a tool
confirmation is pending, and when no agent is selected
(`composerDisabled` in `App.tsx:551`). A disabled element loses focus (the browser
blurs it to `document.body`), and when the field re-enables — turn finished,
confirmation resolved, agent selected — it is **never re-focused**. The user has to
click back into the field before every message. Because the app does not implement
message queueing into an in-flight turn, this re-enable moment is the natural point
to hand the keyboard back to the user.

## Goal

Focus the composer textarea when it becomes usable again, and on initial mount when
it is already usable — **without stealing focus** from the editor or another window
on surfaces where that would be disruptive (the VSCode sidebar in particular).

## The focus-steal question (VSCode)

The objective raises: *"focusing on VSCode could steal focus or not?"*

Answer: we make it a non-issue by **only restoring focus, never stealing it**, and
we do that with a single surface-agnostic guard — `document.hasFocus()`.

The webview UI runs inside an iframe on every surface (web, desktop, VSCode
sidebar). `document.hasFocus()` inside an iframe is `true` **only when focus is
already somewhere inside that iframe's document**. Therefore:

- User just sent a message from the composer, or is interacting inside the webview →
  the webview document has focus → `document.hasFocus()` is `true` → we re-focus the
  textarea. (While the field is disabled mid-turn the browser blurs it to
  `document.body`, which is still inside the webview, so focus is retained by the
  webview and correctly restored on completion.)
- User clicked into the VSCode code editor (or another window) during the turn → the
  sidebar iframe no longer has focus → `document.hasFocus()` is `false` → we skip the
  focus call → **no steal**.

This is strictly better than gating by `layout`: it does the right thing on every
surface based on live state rather than a coarse per-surface on/off switch, so
autofocus still works in VSCode when the user is actually working in the sidebar, and
never yanks the caret out of the editor when they are not.

Claude Code stealing focus on load is cited in the objective as evidence that
autofocus-on-load is an accepted pattern; the `document.hasFocus()` guard keeps that
behaviour where it is welcome (web/desktop on load, sidebar when focused) and
suppresses it where it would be rude (sidebar while the editor is focused).

## Design

Two moving parts, matching the repo convention of *pure decision logic extracted and
unit-tested, DOM wiring left as thin presentational glue* (cf. `voice_utils.ts` /
`toolFormat.ts` and their tests).

### 1. Pure predicate — `composer_utils.ts`

```ts
/** Decide whether to (re)focus the composer textarea.
 *
 *  Focus only on a disabled -> enabled transition, and only when the webview
 *  document already holds focus. The `document.hasFocus()` guard means we RESTORE
 *  focus (after a turn finishes, a confirmation resolves, or an agent is selected)
 *  without STEALING it from the editor or another window — this is what keeps the
 *  VSCode sidebar from yanking the caret out of the code editor.
 *
 *  Initial mount is modelled as a transition from "disabled" by seeding the caller's
 *  previous-disabled tracker to `true`, so a composer that mounts already enabled
 *  (web/desktop on load) autofocuses, guarded the same way. */
export function shouldFocusComposer(
  prevDisabled: boolean,
  disabled: boolean,
  documentHasFocus: boolean,
): boolean {
  return prevDisabled && !disabled && documentHasFocus;
}
```

### 2. Wiring in `Composer.tsx`

- Add a `ref` to the existing `<textarea>` (`inputRef`).
- Add a `prevDisabled` ref **initialized to `true`** so an already-enabled mount
  counts as a `true -> false` transition (initial autofocus), while a mount that is
  disabled (`true -> true`) does not focus.
- Add a `useEffect` keyed on `[disabled]` that, after commit (so the DOM element is
  already enabled), calls `inputRef.current.focus()` when
  `shouldFocusComposer(prevDisabled.current, disabled, document.hasFocus())` is true,
  then updates `prevDisabled.current = disabled`.

No prop/contract changes: both `<Composer>` render sites in `App.tsx` (sidebar layout
~775, compact/VSCode layout ~914) already pass `disabled={composerDisabled}`, so the
behaviour is inherited by every surface for free.

## Why not other approaches

- **`autoFocus` attribute** — fires once on mount only; does nothing on the
  disabled→enabled re-enable transition, which is the primary complaint. Rejected.
- **Layout gate (`layout !== 'sidebar'`)** — coarser and worse than
  `document.hasFocus()`: it would kill useful autofocus in the sidebar when the user
  *is* working there, and is unnecessary elsewhere. Rejected in favour of the live
  focus guard.
- **Focus from `App.tsx`** — would need a ref threaded through `Composer`'s props for
  no benefit; the transition is entirely observable from `disabled` inside `Composer`.

## Edge cases

| Situation | `disabled` transition | Result |
|---|---|---|
| Turn finishes (web/desktop, webview focused) | `true -> false`, `hasFocus` | focus ✓ |
| Turn finishes, user is in VSCode editor | `true -> false`, `!hasFocus` | no focus (no steal) ✓ |
| Tool confirmation resolved but turn still streaming | stays `true` (streaming keeps it disabled) | no flicker ✓ |
| Agent selected while idle | `true -> false`, `hasFocus` | focus ✓ |
| Mount already enabled (web/desktop load, focused) | seeded `true -> false` | initial focus ✓ |
| Mount disabled (no agent / streaming) | `true -> true` | no focus ✓ |

Note: `composerDisabled = streaming || pendingConfirms.length > 0 || !selectedAgentId`,
so during a turn the field stays disabled continuously — a mid-turn confirmation
appearing/resolving never flips it to enabled, so there is no focus flicker mid-turn.

## Testing

- Unit-test `shouldFocusComposer` (all rows of the table above) in
  `composer_utils.test.ts` — Node built-in runner via tsx, colocated, per repo
  convention.
- The `useEffect`/ref wiring is presentational glue with no extractable pure logic
  (the pure part is the predicate); no component/DOM test — consistent with prior
  UI-only changes in this repo. Verified by typecheck, build, and a manual e2e check
  across surfaces.
```
