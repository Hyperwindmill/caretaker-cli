---
"@hyperwindmill/caretaker-cli": patch
"caretaker-desktop": patch
"webview-ui": patch
"caretaker-vscode": patch
---

Security: remediate GitHub Dependabot alerts.

- Add `pnpm.overrides` pinning patched versions of transitive deps (undici, form-data, tmp, lodash-es, markdown-it, linkify-it, qs, js-yaml, esbuild) and bump direct `hono` to `^4.12.25`; bump direct `esbuild` to `^0.28.1` in webview-ui and vscode-extension — clears the transitive/direct alerts, no code changes.
- Replace `xlsx` (SheetJS) with `exceljs` for `.xlsx` reading in `read_document`/`read_attachment`. SheetJS had two unpatched HIGH advisories (ReDoS, prototype pollution) with no npm fix available. **Behavior change:** legacy binary `.xls` is no longer supported (exceljs reads `.xlsx`/`.csv` only); `.xls` now returns an "unsupported format" message suggesting conversion.
- Wrap a `Buffer` in `Uint8Array` at the desktop tray-icon fallback write to satisfy the refreshed `@types/node` typing.
