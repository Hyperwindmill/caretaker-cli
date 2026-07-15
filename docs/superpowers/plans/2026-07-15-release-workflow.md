# Release Workflow (Electron deb/nsis + VSIX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new GitHub Actions workflow, `.github/workflows/release.yml`, that builds Linux `.deb` and Windows `.exe` Electron installers plus a VSCode `.vsix`, and attaches all three to a GitHub Release when a `vX.Y.Z` tag is pushed.

**Architecture:** Four independent-then-converging jobs in one workflow file: `build-linux`, `build-windows`, and `build-vsix` run in parallel on tag push (or manual `workflow_dispatch`), each uploading its artifact via `actions/upload-artifact`. A final `publish-release` job (`needs: [build-linux, build-windows, build-vsix]`) downloads all three and calls `softprops/action-gh-release` to create/update the GitHub Release for that tag with the three files attached.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `softprops/action-gh-release@v2`), pnpm workspaces, electron-builder (already configured in `packages/desktop/electron-builder.json`), `vsce` (already wired via the `caretaker-vscode` package script).

## Global Constraints

- pnpm version: `10` (pinned via `pnpm/action-setup@v4`, matches `.github/workflows/ci.yml:19`).
- Node version: `22` (matches `.github/workflows/ci.yml:24`).
- Install command: `pnpm install --frozen-lockfile` (matches `ci.yml:28`) — never a bare `pnpm install` in CI.
- No code signing: Windows/Linux builds are unsigned. Do not add signing steps or certificate secrets.
- No macOS job: out of scope for this plan.
- No Marketplace publish: the `.vsix` is built and attached to the Release only; do not add `vsce publish` or a `VSCE_PAT` secret.
- Every job must run `pnpm build` before its packaging step, because `packages/desktop/electron-builder.json` bundles `../cli/dist`, `../cli/assets`, `../webview-ui/dist` from disk, and `caretaker-vscode`'s `package` script runs `pnpm -w run build` (its `vscode:prepublish`) but calling `pnpm build` explicitly in the job keeps all three jobs symmetric and avoids relying on an implicit prepublish hook ordering under `--no-dependencies`.
- Since there is no unit-test framework applicable to a CI workflow file, "tests" in this plan are: (a) YAML syntax validation via `python3 -c "import yaml; yaml.safe_load(open(...))"`, and (b) structural greps confirming required keys/steps are present. Final end-to-end validation is a manual `workflow_dispatch` run, per Task 5.

---

### Task 1: Workflow skeleton + `build-linux` job

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: a workflow named `Release` triggered on `push: tags: ['v*']` and `workflow_dispatch`, containing job `build-linux` (runs on `ubuntu-latest`) that uploads an artifact named `deb-package` containing `packages/desktop/release/*.deb`.

- [ ] **Step 1: Write `.github/workflows/release.yml` with the trigger block and the `build-linux` job**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build-linux:
    name: build-linux (deb)
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build workspace
        run: pnpm build

      - name: Build Linux deb
        run: pnpm -F caretaker-desktop exec electron-builder --linux deb

      - name: Upload deb artifact
        uses: actions/upload-artifact@v4
        with:
          name: deb-package
          path: packages/desktop/release/*.deb
          if-no-files-found: error
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo VALID`
Expected: `VALID` printed, no exception.

- [ ] **Step 3: Verify required structure is present**

Run:
```bash
grep -q "tags:" .github/workflows/release.yml && \
grep -q "workflow_dispatch:" .github/workflows/release.yml && \
grep -q "build-linux:" .github/workflows/release.yml && \
grep -q "electron-builder --linux deb" .github/workflows/release.yml && \
echo STRUCTURE_OK
```
Expected: `STRUCTURE_OK` printed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow with linux deb build job"
```

---

### Task 2: `build-windows` job

**Files:**
- Modify: `.github/workflows/release.yml` (add a second job)

**Interfaces:**
- Consumes: same trigger block from Task 1 (no changes to `on:`).
- Produces: job `build-windows` (runs on `windows-latest`) that uploads an artifact named `windows-installer` containing `packages/desktop/release/*.exe`.

- [ ] **Step 1: Add the `build-windows` job below `build-linux` in `.github/workflows/release.yml`**

```yaml
  build-windows:
    name: build-windows (nsis)
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build workspace
        run: pnpm build

      - name: Build Windows installer
        run: pnpm -F caretaker-desktop exec electron-builder --win nsis

      - name: Upload windows artifact
        uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: packages/desktop/release/*.exe
          if-no-files-found: error
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo VALID`
Expected: `VALID` printed, no exception.

- [ ] **Step 3: Verify both jobs are present and distinct**

Run:
```bash
python3 -c "
import yaml
doc = yaml.safe_load(open('.github/workflows/release.yml'))
jobs = doc['jobs']
assert 'build-linux' in jobs
assert 'build-windows' in jobs
assert jobs['build-windows']['runs-on'] == 'windows-latest'
print('JOBS_OK')
"
```
Expected: `JOBS_OK` printed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add windows nsis build job to release workflow"
```

---

### Task 3: `build-vsix` job

**Files:**
- Modify: `.github/workflows/release.yml` (add a third job)

**Interfaces:**
- Produces: job `build-vsix` (runs on `ubuntu-latest`) that uploads an artifact named `vsix-package` containing `packages/vscode-extension/*.vsix`.

- [ ] **Step 1: Add the `build-vsix` job below `build-windows` in `.github/workflows/release.yml`**

```yaml
  build-vsix:
    name: build-vsix
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build workspace
        run: pnpm build

      - name: Package VSCode extension
        run: pnpm -F caretaker-vscode package

      - name: Upload vsix artifact
        uses: actions/upload-artifact@v4
        with:
          name: vsix-package
          path: packages/vscode-extension/*.vsix
          if-no-files-found: error
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo VALID`
Expected: `VALID` printed, no exception.

- [ ] **Step 3: Verify all three build jobs are present**

Run:
```bash
python3 -c "
import yaml
doc = yaml.safe_load(open('.github/workflows/release.yml'))
jobs = doc['jobs']
assert set(['build-linux', 'build-windows', 'build-vsix']).issubset(jobs.keys())
print('THREE_JOBS_OK')
"
```
Expected: `THREE_JOBS_OK` printed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add vsix package build job to release workflow"
```

---

### Task 4: `publish-release` job

**Files:**
- Modify: `.github/workflows/release.yml` (add the final job)

**Interfaces:**
- Consumes: artifacts `deb-package` (Task 1), `windows-installer` (Task 2), `vsix-package` (Task 3).
- Produces: job `publish-release` that creates/updates a GitHub Release for the pushed tag with all three files attached. This is the last job in the workflow.

- [ ] **Step 1: Add the `publish-release` job below `build-vsix` in `.github/workflows/release.yml`**

```yaml
  publish-release:
    name: publish-release
    runs-on: ubuntu-latest
    needs: [build-linux, build-windows, build-vsix]
    permissions:
      contents: write
    steps:
      - name: Download deb artifact
        uses: actions/download-artifact@v4
        with:
          name: deb-package
          path: dist/deb

      - name: Download windows artifact
        uses: actions/download-artifact@v4
        with:
          name: windows-installer
          path: dist/windows

      - name: Download vsix artifact
        uses: actions/download-artifact@v4
        with:
          name: vsix-package
          path: dist/vsix

      - name: Create/update GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/deb/*.deb
            dist/windows/*.exe
            dist/vsix/*.vsix
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo VALID`
Expected: `VALID` printed, no exception.

- [ ] **Step 3: Verify the `needs` dependency and permissions are wired correctly**

Run:
```bash
python3 -c "
import yaml
doc = yaml.safe_load(open('.github/workflows/release.yml'))
job = doc['jobs']['publish-release']
assert set(job['needs']) == {'build-linux', 'build-windows', 'build-vsix'}
assert job['permissions']['contents'] == 'write'
print('RELEASE_JOB_OK')
"
```
Expected: `RELEASE_JOB_OK` printed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish release artifacts to a GitHub Release on tag push"
```

---

### Task 5: Manual end-to-end verification (DEFERRED — user declined the remote push during execution on 2026-07-15; do this before relying on the workflow in production)

**Files:**
- None (verification only; no file changes expected unless a bug surfaces, in which case fix `.github/workflows/release.yml` and repeat the relevant step from Tasks 1–4).

**Interfaces:**
- Consumes: the completed `.github/workflows/release.yml` from Task 4.

- [ ] **Step 1: Push the branch containing the workflow**

```bash
git push origin HEAD
```

- [ ] **Step 2: Push a throwaway test tag to trigger the workflow**

`softprops/action-gh-release` needs a tag ref to attach a Release to, so verification uses a real (throwaway) tag rather than `workflow_dispatch`:

```bash
git tag v0.0.0-test
git push origin v0.0.0-test
```

- [ ] **Step 3: Watch the run and confirm all four jobs succeed**

In the GitHub Actions UI, confirm `build-linux`, `build-windows`, and `build-vsix` all complete successfully, then confirm `publish-release` runs after them and succeeds.

Expected: a Release is created for the tag (e.g. `v0.0.0-test`) with three files attached: a `.deb`, a `.exe`, and a `.vsix`.

- [ ] **Step 4: Clean up the test tag and Release**

```bash
git push --delete origin v0.0.0-test
git tag -d v0.0.0-test
```

Then delete the test Release from the GitHub UI (Releases page → the `v0.0.0-test` entry → Delete).

- [ ] **Step 5: Confirm final state**

Run: `git tag -l` — expect no `v0.0.0-test` tag remaining locally or, per `git ls-remote --tags origin`, remotely.
