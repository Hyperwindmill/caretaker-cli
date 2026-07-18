# Settings Form Overflow — Hardened, Vertically-Adaptive Layout

**Date**: 2026-07-18
**Status**: Approved design, pre-implementation
**Task**: #14 — *Visual bug in settings: "The settings frames (ex. edit project) let fields overflow the wrapper. Harden the layout making it vertically adapt."*

## Goal

Make every settings edit form (Providers, Projects, Agents, Plugins, MCP, Scheduler) fit its
container instead of overflowing its border. The form must **vertically adapt** to the available
viewport height: on a tall window the form grows to fill it; on a short VSCode sidebar (or a
narrow desktop window) the form caps at the real available height and the field list scrolls
**inside** the form, with the Cancel/Save actions pinned at the bottom.

## Symptom & root cause

Each editable settings tab renders a `.glass-form` — a flex column with
`max-height: 85vh` and **no `overflow`** rule — containing the form fields and a `.form-actions`
row (Cancel/Save). The host, `.settings-panel__content`, is `flex:1; overflow-y:auto;
display:flex; flex-direction:column`, and `.tab-pane` is `height:100%` flex column.

Two markup patterns coexist, and only one scrolls:

| Pattern | Tabs | Has `.glass-form__body`? | Outcome |
|---|---|---|---|
| Scroll body + pinned actions | `AgentsTab`, `McpTab` | ✅ (fields in `.glass-form__body`, actions sibling after) | Body scrolls, actions pinned — **works** |
| Flat form, no scroll body | `ProjectsTabSettings`, `ProvidersTab`, `PluginsTab`, `SchedulerTab` | ❌ (all fields + actions directly in `.glass-form`) | When fields exceed `max-height:85vh`, nothing clips → **fields overflow the form border** (the reported bug) |

The `85vh` cap is itself a second problem: it is a fixed fraction of the *viewport*, not the
real available height. In the VSCode sidebar the form sits below the panel header + tab bar, so
`85vh` is larger than the space the form actually has — the form is taller than its slot and
overflows even when the fields would fit. In the centered (web/desktop) layout `85vh` happens to
leave room for the header/tabs, so it reads as "about right" — but it is a coincidence, not a
constraint derived from the layout.

A latent flexbox issue compounds both: `.glass-form__body` is `flex:1; overflow-y:auto` but has
no `min-height:0`. In a flex column the default `min-height:auto` prevents an item from shrinking
below its content size, which silently defeats `overflow-y:auto`. The two tabs that use the body
only scroll because the parent's `max-height:85vh` caps the whole form — i.e. they ride on the
same broken cap. Fixing the cap without adding `min-height:0` would break their scroll too.

## Non-goals

- **No behaviour or data change.** No field is added, removed, renamed, or reordered; no
  validation, save, or postMessage logic changes. This is a layout/markup fix only.
- **No new components.** Reuse the existing `.glass-form` / `.glass-form__body` / `.form-actions`
  vocabulary; do not introduce a `SettingsForm` wrapper component.
- **No horizontal-layout changes.** The bug is vertical overflow; the three-across tri-state row
  in `ProjectsTabSettings` (planning/review/sdd) keeps its `flex` row. (A small `min-width:0` /
  `flex-wrap` defensive tweak is allowed where a flex child currently risks horizontal overflow,
  but the focus is vertical.)
- **No TUI / CLI-host changes.** This is `packages/webview-ui` only (one CSS file + five TSX
  files). No server, harness, store, or types changes.
- **No new CSS variables or design tokens.** Use the existing spacing/radius vars.

## Design

### 1. Make `.glass-form` fill — not cap — its slot

Drop the fixed `max-height: 85vh`. Instead the form fills the available content height and caps
at it, so it never exceeds its wrapper:

```css
.glass-form {
  /* was: max-height: 85vh; (fixed viewport fraction) */
  flex: 1 1 auto;
  min-height: 0;          /* allow shrinking inside the flex column so the body can scroll */
  max-height: 100%;       /* never taller than the content slot, whatever its real height is */
  /* keep: background, border, backdrop-filter, border-radius, padding, display:flex,
     flex-direction:column, gap, box-shadow, animation */
}
```

`flex:1 1 auto` + `min-height:0` makes the form grow to fill `.settings-panel__content` (which
is already `flex:1; overflow-y:auto; min-height:0`-equivalent via its parent) and shrink when
the slot is short; `max-height:100%` is the hard ceiling so the form's border is always inside
the wrapper. On a tall window the form fills the panel; on a short sidebar the form is exactly as
tall as the slot and the fields scroll inside it.

### 2. Make `.glass-form__body` actually scroll

Add the missing `min-height:0` so `overflow-y:auto` can engage once the parent no longer imposes
a viewport-fraction cap:

```css
.glass-form__body {
  flex: 1 1 0;
  min-height: 0;          /* NEW — without this, flex:1 won't shrink below content size */
  overflow-y: auto;
  /* keep: display:flex, flex-direction:column, gap, padding-right */
}
```

`flex:1 1 0` (basis 0) + `min-height:0` is the standard flexbox scroll-recipe: the body takes all
leftover space and yields it to overflow when the form is capped. This is what makes the
flat-form tabs work once they adopt the body wrapper.

### 3. Pin `.form-actions` outside the scroll body

`.form-actions` stays a **direct child of `.glass-form`**, placed *after* `.glass-form__body`.
Because the form is a flex column and the body is `flex:1`, the actions row sits at the bottom
and never scrolls away. The existing `.form-actions` rule (`border-top`, `padding-top`,
`justify-content:flex-end`) already reads as a footer — no change needed beyond *where* it sits
in the markup.

### 4. Normalize the four flat-form tabs to the scroll-body pattern

The two working tabs (`AgentsTab`, `McpTab`) already have:

```tsx
<div className="glass-form">
  <h4>…</h4>
  <div className="glass-form__body">
    {/* all form-group / form-row fields */}
  </div>
  <div className="form-actions"> … </div>
</div>
```

The four broken tabs (`ProjectsTabSettings`, `ProvidersTab`, `PluginsTab`, `SchedulerTab`)
currently put every field — including `.form-actions` — directly in `.glass-form` with no body.
The fix is a pure structural refactor: wrap the scrollable fields in `<div className="glass-form__body">…</div>`
and move `.form-actions` to be a sibling *after* that wrapper. No field is touched, no handler
moves, no label changes.

**Special case — `ProjectsTabSettings` validation banner.** This tab renders the
`validation-error` banner *inside* the form, above the fields. It stays inside `.glass-form__body`
(above the fields) so it scrolls with the form rather than pinning a transient error above the
actions. (Pinning it would push actions up only on error; keeping it in-body is consistent with
the other tabs and avoids layout shift.)

### 5. Defensive: flex children must be willing to shrink

Any flex child that can be wider than its share (the three-across tri-state row, the
`.form-row`s, `.input-with-action`) already relies on `flex:1` children with intrinsic `min-width:auto`.
This is not the reported bug, but while we're hardening the layout we add `min-width:0` to
`.form-row > .form-group` and the tri-state row's inner `div`s (via the existing inline styles →
swap to `min-width:0` too) so a long label or select never forces horizontal overflow of the form
border. This is additive and risk-free.

## Verification

- **Repro the bug first**, then confirm the fix: open the web GUI (`caretaker-cli web`) and the
  VSCode sidebar; in each, open Settings → Projects → Edit (the form with the most fields),
  shrink the window height until the fields exceed the slot. Before the fix: fields overflow the
  form border. After: the body scrolls inside the form, Cancel/Save stay pinned.
- Repeat for Providers (claude-code + openai variants), Plugins, MCP, Scheduler edit forms —
  each must scroll internally, actions pinned.
- Tall window: the form fills the panel (no dead space below it); actions sit at the bottom of
  the form, not the middle.
- Existing working tabs (Agents, MCP) must not regress: they still scroll, actions still pinned.
- No horizontal overflow: the tri-state row and `.form-row`s stay within the form border at the
  narrowest sidebar width.

## Files touched

- `packages/webview-ui/src/styles.css` — `.glass-form`, `.glass-form__body`, `.form-row > .form-group` (§1, §2, §5).
- `packages/webview-ui/src/ProjectsTabSettings.tsx` — wrap fields in `.glass-form__body`, move `.form-actions` after it (§4).
- `packages/webview-ui/src/ProvidersTab.tsx` — same (§4).
- `packages/webview-ui/src/PluginsTab.tsx` — same (§4).
- `packages/webview-ui/src/SchedulerTab.tsx` — same (§4).
- `AgentsTab.tsx` / `McpTab.tsx` — **no markup change** (already correct); they benefit from the CSS fix (§1/§2) for free.

No `CLAUDE.md` / `README.md` update is required: this is a visual bug fix with no change to
architecture, state machine, public contract, or user-facing behaviour — the settings forms
still collect and save the same fields. (If we wanted to be thorough we could note "settings
forms now scroll internally on short viewports" in the CHANGELOG via Changeset, which the
implementation plan includes.)