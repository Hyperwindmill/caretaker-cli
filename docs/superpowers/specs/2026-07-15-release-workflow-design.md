# Release workflow (Electron deb/nsis + VSIX) — design

**Date:** 2026-07-15
**Status:** design approved, awaiting implementation plan

## Goal

Add a GitHub Actions workflow that, on pushing a version tag, builds distributable packages for two of the five monorepo surfaces and publishes them as GitHub Release assets:

- `packages/desktop` (Electron): Linux `.deb` and Windows `.exe` (nsis) installers.
- `packages/vscode-extension`: `.vsix` package.

This is separate from the existing `.github/workflows/ci.yml`, which continues to run build/typecheck/test on every push/PR and is untouched by this change.

## Non-goals (this iteration)

- macOS builds (dmg/zip) — not requested, and no Apple signing identity is configured.
- Code signing for Windows or Linux artifacts — no certificates are configured; builds are unsigned. Windows SmartScreen / unknown-publisher warnings are an accepted consequence, not a bug.
- Publishing the `.vsix` to the VS Code Marketplace (`vsce publish`) — this workflow only builds and attaches the file to the GitHub Release. Marketplace publishing would need a `VSCE_PAT` secret and is a separate, later concern.
- Tag/version automation — this repo has no existing mechanism that creates tags from Changesets (`git tag -l` is empty, `.changeset/config.json` has no linked tag-push action). Cutting a release means a human runs `pnpm version-packages`, commits, and pushes a `vX.Y.Z` tag by hand. That process is unchanged; this workflow only reacts to the tag.
- Gating the release workflow on `ci.yml` passing first — declined; the release workflow runs its own build/install steps independently on tag push.

## Trigger

```yaml
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
```

`workflow_dispatch` is included so the pipeline can be re-run manually (e.g. to test changes to the workflow itself, or to re-attempt a failed platform build) without needing to push a new tag.

## Jobs

Four jobs. The three build jobs are independent and run in parallel; the release job depends on all three and only runs once they all succeed.

### `build-linux` (runs on `ubuntu-latest`)

1. Checkout, pnpm 10 setup, Node 22 setup (same versions as `ci.yml`).
2. `pnpm install --frozen-lockfile`
3. `pnpm build` — builds `caretaker-types`, `caretaker-cli`, and `webview-ui` first; `packages/desktop/electron-builder.json` bundles `../cli/dist`, `../cli/assets`, and `../webview-ui/dist` directly, so those must exist before electron-builder runs.
4. `pnpm -F caretaker-desktop exec electron-builder --linux deb`
5. Upload the produced `.deb` from `packages/desktop/release/` as a job artifact (consumed by the release job).

### `build-windows` (runs on `windows-latest`)

Same steps 1–3 as `build-linux`, then:

4. `pnpm -F caretaker-desktop exec electron-builder --win nsis`
5. Upload the produced `.exe` from `packages/desktop/release/`.

### `build-vsix` (runs on `ubuntu-latest`)

1. Checkout, pnpm 10 setup, Node 22 setup.
2. `pnpm install --frozen-lockfile`
3. `pnpm build`
4. `pnpm -F caretaker-vscode package` — existing script, runs `vsce package --no-dependencies`.
5. Upload the produced `.vsix` from `packages/vscode-extension/`.

### `publish-release` (runs on `ubuntu-latest`, `needs: [build-linux, build-windows, build-vsix]`)

1. Download all three artifacts.
2. Use `softprops/action-gh-release@v2` to create (or update, on re-run via `workflow_dispatch`) the GitHub Release for the pushed tag, attaching the `.deb`, the Windows installer, and the `.vsix`. Uses the default `GITHUB_TOKEN` — no additional secrets required.

## Error handling

No special handling beyond default Actions behavior: if any build job fails, `publish-release` is skipped (via `needs`) and no partial release is published. A failed run is re-triggered with `workflow_dispatch` after a fix, or by deleting and re-pushing the tag.

## Testing

This is CI configuration, not application code — there is no unit-test surface. Verification is: push a test tag (e.g. `v0.0.0-test`) to a fork or trigger via `workflow_dispatch` on a branch, confirm all three artifacts build and attach correctly, then delete the test tag/release. Documented as a manual verification step in the implementation plan rather than an automated test.
