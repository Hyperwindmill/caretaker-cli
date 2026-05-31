# caretaker-cli

## 0.2.4

### Patch Changes

- Updated dependencies [287021a]
  - webview-ui@0.2.4
  - caretaker-types@0.2.4

## 0.2.3

### Patch Changes

- 7f7b33e: Fix Hono web server to respect and apply the agent-specific working directory in chat sessions instead of falling back blindly to the server's launch folder.
- 1a3ecbd: Integrate visual filesystem directory picking (FolderPicker component on frontend, /api/fs/ls Hono route on backend) for intuitive project and local plugin path selection.
- Updated dependencies [1a3ecbd]
  - webview-ui@0.2.3
  - caretaker-types@0.2.3

## 0.2.2

### Patch Changes

- 77d3d8a: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
- Updated dependencies [77d3d8a]
  - caretaker-types@0.2.2
  - webview-ui@0.2.2

## 0.2.1

### Patch Changes

- 254fba9: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
- 2da7533: Established automated cross-package versioning and changelog tracking across the monorepo using Changesets.
- Updated dependencies [254fba9]
  - caretaker-types@0.2.1
  - webview-ui@0.2.1
