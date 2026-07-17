---
"@hyperwindmill/caretaker-cli": minor
---

Publish the CLI to npm as `@hyperwindmill/caretaker-cli`.

The package is no longer `private`: `caretaker-types` and `webview-ui` (both type-only at runtime) move to `devDependencies`, the webview build output is copied into `dist/webview` at build time so `caretaker-cli web` serves standalone from the published package, and release CI publishes to npm via trusted publishing (OIDC) on tag.
