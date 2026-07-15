# webview-ui

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.6

### Patch Changes

- 219ade5: Web UI: tool use blocks are now collapsed by default. The compact header shows the tool name, a smart one-line arg preview (basename for path-like args such as read/write, the command for shell tools, else truncated JSON), a neutral outcome hint (spinner while running, then line count or byte size of the result), and a chevron. Clicking expands the full pretty-printed args and result. Reuses the existing `<details>` accordion pattern; no bridge/harness changes.
- 59d3703: VSCode sidebar no longer exposes the Projects (autonomous tasks) entry point. Projects is scheduler-driven, and the VSCode surface never boots the scheduler, so the button was misleading there. It's now gated to the sidebar layout (web/desktop) only — the same gating already applied to the Scheduler settings tab.
- 08126cf: Fix: model "thinking"/reasoning blocks now appear live during streaming, not only after reloading a past conversation. The harness loop already emitted `onThinking` and persisted the parts, but the surfaces (web server, VSCode sidebar) never forwarded the event and the bridge contract had no `thinking` message, so live turns silently dropped it. Added a `thinking` event to the `HostToView` contract and wired it through both surfaces and the webview reducer.
- cf07a9d: Replace emoji icons with lucide-react across the whole webview UI (chat surface + all settings/scheduler/projects tabs). Icons are SVG that inherit `currentColor`, so they follow the theme (light/dark) and render consistently across platforms — unlike the previous OS-dependent emoji. Icon choices are centralized in a single `icons.ts` module. Also removed the now-unused `@vscode/codicons` dependency from the VSCode extension (it was a dead CSS import; the extension renders the shared webview UI), so the whole product uses one icon system. Icon-button colors were adjusted so the new SVG glyphs stay legible on dark cards.

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.5

## 0.2.4

### Patch Changes

- 287021a: Improve FolderPicker UX: center and constrain max height to 50vh, increase z-index to 999999 for proper panel layering, and integrate FolderPicker on the Agent settings working directory input.

## 0.2.3

### Patch Changes

- 1a3ecbd: Integrate visual filesystem directory picking (FolderPicker component on frontend, /api/fs/ls Hono route on backend) for intuitive project and local plugin path selection.

## 0.2.2

### Patch Changes

- 77d3d8a: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.

## 0.2.1

### Patch Changes

- 254fba9: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
