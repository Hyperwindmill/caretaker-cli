# Chat composer autofocus — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Strict TDD is active: write the failing test first and watch it fail before implementing.

**Goal:** Autofocus the chat composer `<textarea>` when it becomes usable again
(turn finished, tool confirmation resolved, or an agent is selected) and on initial
mount when it is already usable — **without stealing focus** from the editor or
another window (the VSCode sidebar case).

**Architecture:** The composer (`packages/webview-ui/src/Composer.tsx`) has no focus
logic today; its `<textarea>` is `disabled` during streaming / pending confirms / no
agent (`composerDisabled`, `App.tsx:551`) and is never re-focused when re-enabled.
Add a pure predicate `shouldFocusComposer(prevDisabled, disabled, documentHasFocus)`
(new `composer_utils.ts`, unit-tested) and wire it into `Composer` via a `textarea`
ref + a `prevDisabled` ref (seeded `true`) + a `useEffect` on `[disabled]`. The
`document.hasFocus()` guard means we **restore** focus without **stealing** it:
inside the webview iframe `document.hasFocus()` is true only when focus is already in
the webview, so a turn finishing while the user is in the VSCode editor does not yank
the caret. Both `<Composer>` render sites already pass `disabled`, so every surface
inherits the behaviour with no contract change.

**Tech Stack:** TypeScript ESM, React, esbuild, Node built-in test runner via tsx,
pnpm workspaces, Changesets.

**Design spec:** `docs/superpowers/specs/2026-07-28-chat-autofocus-design.md`

## Global Constraints

- **Scope discipline:** touch only the composer focus behaviour. Do NOT change the
  `ComposerProps` contract, the two call sites in `App.tsx`, or any unrelated
  composer behaviour (send, attachments, drag/drop, voice).
- **Focus-steal rule:** every `focus()` call MUST be guarded by `document.hasFocus()`.
  Do NOT gate autofocus by `layout` — the live focus guard is surface-agnostic and
  strictly better (see design spec "The focus-steal question").
- **TDD (Strict):** the only extractable logic is `shouldFocusComposer` — write its
  test first and watch it FAIL before implementing. The `useEffect`/ref wiring is
  presentational glue with no pure logic to unit-test (consistent with prior UI-only
  plans); verified by typecheck + build + manual e2e.
- Conventional commits, **no** Co-Authored-By / AI attribution.
- Tests: Node built-in runner via tsx, colocated `*.test.ts`, run from repo root.
  `pnpm -F webview-ui test` runs webview tests; also run
  `pnpm -F @hyperwindmill/caretaker-cli typecheck` (the CLI project typechecks the
  workspace) and `pnpm -F webview-ui build`.
- Every change needs a changeset (`.changeset/*.md`, five-package fixed group; this
  one: `patch`).
- Docs (`CLAUDE.md` §7) updated in the same unit of work.

---

### Task 1: Pure predicate — `shouldFocusComposer` (TDD)

**Files:**
- Create: `packages/webview-ui/src/composer_utils.ts`
- Create: `packages/webview-ui/src/composer_utils.test.ts`

**Interfaces:**
- Produces: `shouldFocusComposer(prevDisabled, disabled, documentHasFocus) => boolean`.
  Consumed by `Composer` in Task 2.

- [ ] **Step 1: Write the failing test**

Create `packages/webview-ui/src/composer_utils.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFocusComposer } from './composer_utils.js';

test('focuses on a disabled -> enabled transition when the webview has focus', () => {
  assert.equal(shouldFocusComposer(true, false, true), true);
});

test('does NOT focus when the webview does not have focus (no steal)', () => {
  // e.g. turn finished while the user is in the VSCode editor
  assert.equal(shouldFocusComposer(true, false, false), false);
});

test('does NOT focus when the field is still disabled', () => {
  assert.equal(shouldFocusComposer(true, true, true), false);
});

test('does NOT focus when there was no transition (already enabled)', () => {
  // steady enabled state (e.g. a re-render that did not toggle disabled)
  assert.equal(shouldFocusComposer(false, false, true), false);
});

test('does NOT focus on an enabled -> disabled transition', () => {
  assert.equal(shouldFocusComposer(false, true, true), false);
});

test('initial mount already enabled + focused (prevDisabled seeded true) focuses', () => {
  assert.equal(shouldFocusComposer(true, false, true), true);
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
pnpm -F webview-ui exec tsx --test packages/webview-ui/src/composer_utils.test.ts
```
Expected: FAILS (`shouldFocusComposer` is not exported → import/TypeError).

- [ ] **Step 3: Implement the predicate**

Create `packages/webview-ui/src/composer_utils.ts`:

```ts
/** Decide whether to (re)focus the composer textarea.
 *
 *  Focus only on a disabled -> enabled transition, and only when the webview
 *  document already holds focus. The `documentHasFocus` guard means we RESTORE
 *  focus (after a turn finishes, a confirmation resolves, or an agent is selected)
 *  without STEALING it from the editor or another window — this is what keeps the
 *  VSCode sidebar from yanking the caret out of the code editor. It is
 *  surface-agnostic: no `layout` gate needed.
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

- [ ] **Step 4: Run the test — verify it passes**

```bash
pnpm -F webview-ui exec tsx --test packages/webview-ui/src/composer_utils.test.ts
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/composer_utils.ts packages/webview-ui/src/composer_utils.test.ts
git commit -m "feat(webview): add shouldFocusComposer autofocus predicate"
```

---

### Task 2: Wire autofocus into `Composer`

**Files:**
- Modify: `packages/webview-ui/src/Composer.tsx`

**Interfaces:**
- Consumes: `shouldFocusComposer` (`composer_utils.js`).
- Produces: nothing (no `ComposerProps` change).

No component test: presentational DOM wiring, no extractable pure logic (the pure
part is Task 1's predicate). Verified by typecheck + build + Task 3 manual check.

- [ ] **Step 1: Add the imports**

At the top of `packages/webview-ui/src/Composer.tsx`, add `useEffect` to the React
import and import the predicate. Current line 1:

```ts
import { useState, useRef, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
```

becomes:

```ts
import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
```

Add after the existing local imports (after the `icons.js` import, ~line 3):

```ts
import { shouldFocusComposer } from './composer_utils.js';
```

- [ ] **Step 2: Add the refs + focus effect**

Inside the `Composer` component body, next to the other refs (near `fileInputRef` /
`dragCounter`, ~line 49-50), add:

```ts
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Seed `true` so a composer that mounts already enabled counts as a
  // disabled -> enabled transition and autofocuses on load (guarded below).
  const prevDisabled = useRef(true);
```

Then add the effect (place it after the ref declarations, before `send`):

```ts
  // Restore focus to the input when it becomes usable again — turn finished,
  // confirmation resolved, or an agent selected — but only when the webview
  // already holds focus, so we never steal the caret from the editor (VSCode
  // sidebar) or another window. See shouldFocusComposer / the design spec.
  useEffect(() => {
    if (shouldFocusComposer(prevDisabled.current, disabled, document.hasFocus())) {
      inputRef.current?.focus();
    }
    prevDisabled.current = disabled;
  }, [disabled]);
```

- [ ] **Step 3: Attach the ref to the textarea**

On the `<textarea className="composer__input" ...>` element (~line 166), add the ref:

```tsx
      <textarea
        ref={inputRef}
        className="composer__input"
        value={value}
        placeholder="Message Caretaker (Drop/paste files/images)..."
        rows={2}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
      />
```

- [ ] **Step 4: Build + typecheck + test**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: build clean, webview tests PASS (incl. Task 1), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/Composer.tsx
git commit -m "feat(webview): autofocus the chat composer when it re-enables"
```

---

### Task 3: Manual end-to-end check

No files. Verify the behaviour on the surfaces the guard is meant to distinguish.

- [ ] **Step 1: Web GUI (web/desktop path — should autofocus)**

```bash
CARETAKER_HOME=/tmp/ct-autofocus pnpm -F @hyperwindmill/caretaker-cli dev web
```
In the web GUI (open http://127.0.0.1:3000, configure a provider + agent if the home
is fresh):
1. On load with an agent selected and the window focused, the composer is focused
   (caret in the field, can type immediately).
2. Type a message, press Enter. While the agent streams, the field is disabled.
   When the turn finishes, the caret returns to the composer automatically — you can
   type the next message without clicking.
3. If a tool confirmation appears mid-turn, resolving it does not flicker focus; focus
   returns only once the whole turn is done.
4. Selecting a different agent (from an idle state) focuses the composer.
5. Click into the browser's URL bar (or another window) during a turn; when the turn
   finishes the composer is NOT force-focused back (no steal) — `document.hasFocus()`
   is false there.

- [ ] **Step 2: VSCode sidebar (focus-steal path — should NOT steal)**

Build the extension and launch the F5 dev host (see
`packages/vscode-extension/README.md`), or `pnpm -F caretaker-vscode build` then run
the extension. In the sidebar:
1. With the sidebar focused, send a message; when the turn finishes the composer is
   re-focused (as in web).
2. Send a message, then immediately click into the code editor and type. When the
   turn finishes, focus STAYS in the editor — the caret is NOT yanked into the
   sidebar. This is the core VSCode acceptance check.

---

### Task 4: Docs + changeset

**Files:**
- Modify: `CLAUDE.md` (§7 Chat rendering)
- Create: `.changeset/chat-autofocus.md`

- [ ] **Step 1: Update `CLAUDE.md` §7**

In §7 "Chat rendering", add a bullet describing the autofocus behaviour:

```
- **The composer autofocuses when it re-enables.** The composer `<textarea>` is
  `disabled` during streaming / pending confirms / no-agent (`composerDisabled`), and
  on a disabled -> enabled transition (turn finished, confirmation resolved, agent
  selected) `Composer` re-focuses it — but only when `document.hasFocus()` is true.
  Inside the webview iframe that is true only when focus is already in the webview, so
  the pure `shouldFocusComposer` predicate (`composer_utils.ts`) RESTORES focus
  without STEALING it: a turn finishing while the user is in the VSCode editor does
  not yank the caret out. A `prevDisabled` ref seeded `true` makes an
  already-enabled mount autofocus on load too. No `layout` gate — the focus guard is
  surface-agnostic.
```

- [ ] **Step 2: Create the changeset**

Create `.changeset/chat-autofocus.md`:

```md
---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
'caretaker-vscode': patch
'caretaker-desktop': patch
'caretaker-types': patch
---

Autofocus the chat composer when it becomes usable again (turn finished, tool
confirmation resolved, or an agent selected) and on initial load. Focus is only
restored when the webview already holds focus, so the VSCode sidebar never steals the
caret out of the code editor.
```

- [ ] **Step 3: Full verification**

```bash
pnpm -F webview-ui test
pnpm -F webview-ui build
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: all PASS/clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .changeset/chat-autofocus.md
git commit -m "docs: document chat composer autofocus"
```

---

## Done when

- The composer autofocuses on a disabled -> enabled transition (turn finished,
  confirmation resolved, agent selected) and on initial mount when already enabled,
  guarded by `document.hasFocus()`.
- The VSCode sidebar does NOT steal focus from the editor when a turn finishes while
  the editor is focused (Task 3 Step 2).
- `shouldFocusComposer` is unit-tested; `pnpm -F webview-ui test`, `build`, and CLI
  `typecheck` are all green.
- `CLAUDE.md` §7 and a `patch` changeset are updated.
```
