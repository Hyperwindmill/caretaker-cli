# caretaker-desktop

## 0.6.0

### Minor Changes

- 61a0d81: Add task archive and delete: archived tasks are hidden by default with a "Show archived" toggle and are excluded from the scheduler heartbeat; delete permanently removes a task and its messages from the store. Both are available as MCP tools (task_archive, task_unarchive, task_delete), REST endpoints, and confirm-gated UI actions. A locked/running task cannot be deleted (409) to avoid zombie resurrection by the heartbeat.

### Patch Changes

- Updated dependencies [95dd100]
- Updated dependencies [61a0d81]
- Updated dependencies [ada15d2]
- Updated dependencies [04c6f3e]
  - webview-ui@0.6.0
  - caretaker-cli@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [97d36f8]
- Updated dependencies [699a67d]
- Updated dependencies [fb5020f]
- Updated dependencies [0704fc5]
- Updated dependencies [06cc49e]
  - caretaker-cli@0.5.0
  - webview-ui@0.5.0

## 0.4.2

### Patch Changes

- Updated dependencies [2656cfc]
  - caretaker-cli@0.4.2
  - webview-ui@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [0d70758]
  - caretaker-cli@0.4.1
  - webview-ui@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [0eac4c4]
  - caretaker-cli@0.4.0
  - webview-ui@0.4.0

## 0.3.6

### Patch Changes

- Updated dependencies [219ade5]
- Updated dependencies [59d3703]
- Updated dependencies [08126cf]
- Updated dependencies [cf07a9d]
  - webview-ui@0.3.6
  - caretaker-cli@0.3.6

## 0.3.5

### Patch Changes

- de68558: fix(desktop): packaged app opened on a white page because the backend crashed on startup with `Cannot find module 'es-object-atoms'`. electron-builder 26.8.1's pnpm node-modules collector dropped 13 transitive leaf dependencies (`es-object-atoms`, `mime-db`, `setprototypeof`, `unpipe`, and others in the Hono HTTP chain) from the asar, so the forked `caretaker-cli web` process died before binding its port and the BrowserWindow loaded a connection-refused page. Upgrading electron-builder to 26.15.6 fixes the collector; verified by unpacking the asar (13 missing → 0 runtime-relevant) and booting the packaged exe end-to-end (HTTP 200 from the embedded server).
- Updated dependencies [f9d9e93]
  - caretaker-cli@0.3.5
  - webview-ui@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [0cd08e4]
  - caretaker-cli@0.3.4
  - webview-ui@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies [254936d]
  - caretaker-cli@0.3.3
  - webview-ui@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [e30955c]
  - caretaker-cli@0.3.2
  - webview-ui@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies
  - caretaker-cli@0.3.1
  - webview-ui@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [a48123e]
- Updated dependencies [f0273f4]
- Updated dependencies [805e0ac]
  - caretaker-cli@0.3.0
  - webview-ui@0.3.0

## 0.2.5

### Patch Changes

- Updated dependencies [7c65a7f]
  - caretaker-cli@0.2.5
  - webview-ui@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [287021a]
  - webview-ui@0.2.4
  - caretaker-cli@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [7f7b33e]
- Updated dependencies [1a3ecbd]
  - caretaker-cli@0.2.3
  - webview-ui@0.2.3

## 0.2.2

### Patch Changes

- Fix Electron packaging for desktop: bundle CLI assets to prevent ENOENT crashes and load application icons compatibly from ASAR.
- Updated dependencies [77d3d8a]
  - webview-ui@0.2.2
  - caretaker-cli@0.2.2

## 0.2.1

### Patch Changes

- 2da7533: Established automated cross-package versioning and changelog tracking across the monorepo using Changesets.
- Updated dependencies [254fba9]
- Updated dependencies [2da7533]
  - webview-ui@0.2.1
  - caretaker-cli@0.2.1
