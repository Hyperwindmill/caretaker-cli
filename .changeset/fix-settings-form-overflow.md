---
"@hyperwindmill/caretaker-cli": patch
---

fix(webview): settings edit forms no longer overflow their frame on short viewports

Settings edit forms (Providers, Projects, Plugins, Scheduler) used to put all fields
and the Save/Cancel actions directly inside `.glass-form` with no scroll wrapper, so
when the fields exceeded the fixed `max-height: 85vh` cap they overflowed the form's
border. The `85vh` cap was also a fixed viewport fraction rather than the real
available height, which broke in the VSCode sidebar where the form sits below the
header and tab bar.

- `.glass-form` now fills its content slot (`flex: 1 1 auto; min-height: 0;
  max-height: 100%`) instead of a fixed `85vh` cap, so it vertically adapts to the
  available height on any surface.
- `.glass-form__body` gets `min-height: 0` + `flex: 1 1 0` (the standard flexbox
  scroll recipe) so `overflow-y: auto` actually engages.
- The four flat-form tabs (Projects, Providers, Plugins, Scheduler) now wrap their
  fields in `.glass-form__body` and keep `.form-actions` as a sibling after it,
  matching the already-working Agents/MCP pattern: the field list scrolls inside the
  form, Cancel/Save stay pinned at the bottom.
- Defensive `min-width: 0` on `.form-row > .form-group` and the Projects tri-state
  row's inner divs prevents horizontal overflow at narrow sidebar widths.

No behaviour, data, or field changes — pure layout/markup fix.