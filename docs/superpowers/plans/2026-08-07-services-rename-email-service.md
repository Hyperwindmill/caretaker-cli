# Scheduler → Services + Email (IMAP) service type — implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Task 2 is
> strict TDD (failing test first). The rest is a mechanical rename plus one form branch,
> verified by typecheck/build/manual pass.

**Goal:** rename the user-facing **Scheduler** settings surface (and the shared type) to
**Services**, and add a third service `type: 'email'` that stores IMAP connection +
credentials, encrypted at rest. The email service has **no runtime behaviour** — it is
configuration a later task will consume.

**Design spec:** `docs/superpowers/specs/2026-08-07-services-rename-email-service-design.md`

**Tech Stack:** TypeScript ESM strict, React + esbuild (webview-ui), Node built-in test
runner via tsx, pnpm workspaces, Changesets.

## Global Constraints

- **Do NOT build an IMAP client, poller, strategy, UID state, or agent invocation for
  email.** The original task checklist asked for it; the objective removed it. No
  `packages/cli/src/cli/web/scheduler/email.ts`. No entry in the `strategies` map in
  `packages/cli/src/cli/web/scheduler.ts` — an unregistered type is skipped by
  construction, which is exactly the wanted behaviour.
- **Do NOT rename internals:** keep `cli/web/scheduler.ts`, `cli/web/scheduler/**`,
  `startBackgroundScheduler`, `runSchedulerTick`, `scheduler-logs/`, the `getTaskRuns`
  bridge messages, and above all the `caretaker.json` key `scheduler.tasks`. The daemon
  is still a scheduler; only the settings collection is renamed. Renaming the config key
  would require a migration for zero user-visible gain.
- **Do NOT invent a new crypto path.** `saveConfig` + `lib/encryption.ts` only.
- **Do NOT add a redaction/write-only path for `imapPassword`** — it round-trips as an
  `encrypt()` blob exactly like `telegramBotToken` (see design spec §5).
- **Do NOT make `cron` / `prompt` / `agentId` optional** on the type. The email branch
  fills placeholders, like the telegram branch already does.
- Scope discipline: no drive-by refactors of `SchedulerTab`'s existing heartbeat/telegram
  behaviour, the execution-console drawer, or `SettingsPanel`'s `layout` gating.
- Conventional commits, no Co-Authored-By / AI attribution. Commit after each task.
- One changeset (`minor` — new service type + type rename with alias).
- Docs (`CLAUDE.md`, `README.md`) updated in the same unit of work.

---

### Task 1: Types — rename + email fields

**Files:** Modify `packages/types/src/index.ts`

- [ ] **Step 1: Rename the type, widen the union, add the email fields**

Replace the current `ScheduledTaskConfig` block (lines 12–23) with:

```ts
/** One entry in the **Services** settings collection (persisted under the
 *  `scheduler.tasks` key in caretaker.json — the key is kept for backward
 *  compatibility, see docs/superpowers/specs/2026-08-07-services-rename-email-service-design.md).
 *
 *  Only `heartbeat` is cron-scheduled. `telegram` is a poller. `email` is inert
 *  configuration: it stores IMAP credentials for a future agent-facing email
 *  tool and is never ticked (no strategy is registered for it). */
export type ServiceConfig = {
  id: string;
  name: string;
  type: 'heartbeat' | 'telegram' | 'email';
  enabled: boolean;
  /** Agent that runs this service. Empty for `email` — a credentials-only
   *  record has nothing to run. */
  agentId: string;
  /** 5-field cron. Meaningful for `heartbeat` only; the form fills a
   *  placeholder for the other types. */
  cron: string;
  workingDir?: string;
  /** Periodic instructions. `heartbeat` only; placeholder otherwise. */
  prompt: string;
  telegramBotToken?: string;
  telegramAllowedChats?: string;
  // ─── email (IMAP) ───────────────────────────────────────────────────
  /** IMAP server host, e.g. imap.gmail.com */
  imapHost?: string;
  /** IMAP port. 993 for implicit TLS, 143 for plaintext/STARTTLS. */
  imapPort?: number;
  /** Account/login name. */
  imapUser?: string;
  /** Password or app password. Encrypted at rest by saveConfig
   *  (encrypt() blob, see lib/encryption.ts). */
  imapPassword?: string;
  /** Implicit TLS. Unset/true = TLS. */
  imapSecure?: boolean;
};

/** @deprecated Renamed to {@link ServiceConfig}. Kept because the type is
 *  re-exported from the published CLI's `./types` entry point. */
export type ScheduledTaskConfig = ServiceConfig;
```

And in `CaretakerConfig` change `tasks: ScheduledTaskConfig[]` to
`tasks: ServiceConfig[]` (keep the `scheduler?: { tasks: … }` shape and key).

- [ ] **Step 2: Move in-repo usages to the new name**

Purely the type import/annotation name in these files (no logic changes):

- `packages/cli/src/cli/web/scheduler/strategy.ts` (3 occurrences)
- `packages/cli/src/cli/web/scheduler/telegram.ts` (lines 16, 178, 394, 481)
- `packages/cli/src/cli/web/scheduler/heartbeat.ts` (lines 7, 83, 201)

Leave `packages/webview-ui/src/SchedulerTab.tsx` alone for now — Task 3 renames that
file wholesale.

- [ ] **Step 3: Verify + commit**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: clean.

```bash
git add packages/types/src/index.ts packages/cli/src/cli/web/scheduler
git commit -m "refactor(types): rename ScheduledTaskConfig to ServiceConfig, add email fields"
```

---

### Task 2: Encrypt `imapPassword` at rest (TDD)

**Files:**
- Create: `packages/cli/src/store/json_services.test.ts`
- Modify: `packages/cli/src/store/json.ts`

- [ ] **Step 1: Write the failing test**

Follow `json_voice.test.ts` / `json_projects.test.ts` for the temp-home pattern, and set
`CARETAKER_HOME` at **file scope** — never inside a `describe`, or the developer's real
`~/.caretaker` gets clobbered.

Create `packages/cli/src/store/json_services.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope: every test in this file shares one throwaway CARETAKER_HOME.
const home = await mkdtemp(join(tmpdir(), 'caretaker-services-'));
process.env.CARETAKER_HOME = home;

const { loadConfig, saveConfig, configPath } = await import('./json.js');
const { decrypt, isEncrypted } = await import('../lib/encryption.js');

after(async () => {
  await rm(home, { recursive: true, force: true });
});

function emailService(imapPassword: string) {
  return {
    id: 'svc_email_1',
    name: 'Work inbox',
    type: 'email' as const,
    enabled: true,
    agentId: '',
    cron: '',
    prompt: 'Email (IMAP) credentials',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'me@example.com',
    imapPassword,
    imapSecure: true,
  };
}

test('saveConfig encrypts a fresh imapPassword', async () => {
  const config = await loadConfig();
  config.scheduler = { tasks: [emailService('s3cret')] };
  await saveConfig(config);

  const onDisk = JSON.parse(await readFile(configPath(), 'utf8'));
  const stored = onDisk.scheduler.tasks[0].imapPassword;
  assert.notEqual(stored, 's3cret');
  assert.equal(isEncrypted(stored), true);
  assert.equal(decrypt(stored), 's3cret');
});

test('saveConfig does not double-encrypt an already-encrypted imapPassword', async () => {
  const first = await loadConfig();
  const blob = first.scheduler!.tasks[0].imapPassword!;
  await saveConfig(first); // re-save the loaded (encrypted) value

  const onDisk = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.equal(onDisk.scheduler.tasks[0].imapPassword, blob);
  assert.equal(decrypt(onDisk.scheduler.tasks[0].imapPassword), 's3cret');
});

test('saveConfig leaves non-secret email fields and other service types alone', async () => {
  const config = await loadConfig();
  config.scheduler = {
    tasks: [
      emailService('s3cret'),
      {
        id: 'svc_hb_1',
        name: 'Morning report',
        type: 'heartbeat' as const,
        enabled: true,
        agentId: 'agent_1',
        cron: '0 9 * * *',
        prompt: 'Report',
      },
    ],
  };
  await saveConfig(config);

  const onDisk = JSON.parse(await readFile(configPath(), 'utf8'));
  const [email, heartbeat] = onDisk.scheduler.tasks;
  assert.equal(email.imapHost, 'imap.example.com');
  assert.equal(email.imapUser, 'me@example.com');
  assert.equal(email.imapPort, 993);
  assert.equal(email.imapSecure, true);
  assert.deepEqual(Object.keys(heartbeat).filter((k) => k.startsWith('imap')), []);
  assert.equal(heartbeat.cron, '0 9 * * *');
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/json_services.test.ts
```
Expected: the first test FAILS (`imapPassword` stored as plaintext `s3cret`).

- [ ] **Step 3: Add the encryption branch**

In `packages/cli/src/store/json.ts`, inside the existing `for (const task of
c.scheduler.tasks)` loop in `saveConfig` (currently lines 92–100), add next to the
telegram branch:

```ts
      if (task.type === 'email' && task.imapPassword && !isEncrypted(task.imapPassword)) {
        task.imapPassword = encrypt(task.imapPassword);
      }
```

- [ ] **Step 4: Run it — verify it passes**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/json_services.test.ts
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/store/json.ts packages/cli/src/store/json_services.test.ts
git commit -m "feat(store): encrypt email service imapPassword at rest"
```

---

### Task 3: Rename the UI surface — Scheduler → Services

**Files:**
- Rename: `packages/webview-ui/src/SchedulerTab.tsx` → `packages/webview-ui/src/ServicesTab.tsx`
- Modify: `packages/webview-ui/src/SettingsPanel.tsx`

- [ ] **Step 1: Rename the file (preserve history)**

```bash
git mv packages/webview-ui/src/SchedulerTab.tsx packages/webview-ui/src/ServicesTab.tsx
```

- [ ] **Step 2: Rename the component and its types inside the file**

- `interface SchedulerTabProps` → `ServicesTabProps`
- `export function SchedulerTab(` → `export function ServicesTab(`
- import `ServiceConfig` instead of `ScheduledTaskConfig` from `caretaker-types`, and
  update the 6 annotation sites (lines 88, 92, 107, 197, 251, 270 of the original file).
- `className="tab-pane scheduler-tab"` → `className="tab-pane services-tab"` (no CSS rule
  exists for either name; it is a hook, not a style).

Keep the local variable names (`tasks`, `editingTask`, `taskData`, `deleteTask`, …) and
the `postMessage({ type: 'saveConfig', config: { ...config, scheduler: { tasks } } })`
payload **unchanged** — the config key stays `scheduler`.

- [ ] **Step 3: Rename the user-facing strings in the tab**

| Current | New |
| --- | --- |
| `<h3>Scheduled Tasks</h3>` | `<h3>Services</h3>` |
| `+ Add Task` | `+ Add Service` |
| `Add Scheduled Task` / `Edit Task: {name}` | `Add Service` / `Edit Service: {name}` |
| label `Task Name` (+ `id="task-name"` placeholder text) | `Service Name` |
| label `Task Type` | `Service Type` |
| checkbox label `Active (Run scheduler for this task)` | `Active` |
| `Agent to Execute` (heartbeat/telegram only, see Task 4) | unchanged |
| button `Save Task` | `Save Service` |
| error strings `Task Name is required.` etc. | `Service Name is required.`, `A service named "…" already exists.` |
| empty message `No scheduled tasks configured. Add a heartbeat task to run agents periodically.` | `No services configured. Add a heartbeat to run an agent periodically, a Telegram bot, or email credentials.` |
| icon-button titles `Edit task` / `Delete task` | `Edit service` / `Delete service` |

Type dropdown options become:

```tsx
              <option value="heartbeat">Heartbeat (Scheduled Agent Run)</option>
              <option value="telegram">Telegram Bot (Poller)</option>
              <option value="email">Email (IMAP credentials)</option>
```

- [ ] **Step 4: Update `SettingsPanel.tsx`**

- import: `import { ServicesTab } from './ServicesTab.js';`
- `type TabId = … | 'services' | 'voice'` (replacing `'scheduler'`)
- `case 'services':` rendering `<ServicesTab … />` with the same props
- the `layout === 'sidebar'`-gated tab button: `activeTab === 'services'`,
  `setActiveTab('services')`, label `Services`
- the comment on lines 199–201 mentioning "Projects and Scheduler above" → "Projects and
  Services above"

Do **not** touch the `layout === 'sidebar'` gating itself.

- [ ] **Step 5: Verify + commit**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: clean/PASS. Grep to confirm nothing dangles:
`grep -rn "SchedulerTab\|'scheduler'" packages/webview-ui/src` → no hits.

```bash
git add packages/webview-ui/src
git commit -m "refactor(webview): rename the Scheduler settings tab to Services"
```

---

### Task 4: Email service form + list card

**Files:** Modify `packages/webview-ui/src/ServicesTab.tsx`

- [ ] **Step 1: Extend the form state**

- `const [type, setType] = useState<ServiceConfig['type']>('heartbeat');` (and the
  `onChange` cast becomes `as ServiceConfig['type']`) — three literal unions inline
  would drift.
- Add: `imapHost`, `imapPort` (keep as a `string` in state, parse on save — an
  `<input type="number">` bound to a number makes clearing the field awkward),
  `imapUser`, `imapPassword`, `imapSecure` (boolean, default `true`).
- Seed them in `startEdit` from the task (`task.imapHost || ''`,
  `task.imapPort ? String(task.imapPort) : '993'`, …, `task.imapSecure !== false`) and
  reset them in `startCreate` (`''`/`'993'`/`true`).

- [ ] **Step 2: Validation branch**

In `validateAndSave`, the agent check becomes email-aware:

```ts
    // An email service holds credentials only — there is nothing to run, so no agent.
    if (!agentId && type !== 'email') {
      setErrorMsg('Please select an agent for this service.');
      return;
    }
```

and a third branch after the `telegram` one:

```ts
    } else if (type === 'email') {
      if (!imapHost.trim() || !imapUser.trim() || !imapPassword.trim()) {
        setErrorMsg('IMAP host, user and password are required.');
        return;
      }
      const port = Number(imapPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setErrorMsg('IMAP port must be a whole number between 1 and 65535.');
        return;
      }
      // ponytail: cron/prompt are unused for email — they stay required on the
      // type so heartbeat/telegram keep reading them unconditionally.
      finalPrompt = 'Email (IMAP) credentials';
      finalCron = '';
    }
```

- [ ] **Step 3: Persist the fields**

In the `taskData` object literal, alongside the existing telegram spread:

```ts
      ...(type === 'email'
        ? {
            imapHost: imapHost.trim(),
            imapPort: Number(imapPort),
            imapUser: imapUser.trim(),
            imapPassword: imapPassword.trim(),
            imapSecure,
          }
        : {}),
```

`imapPassword` arrives here either as a newly typed password or as the `encrypt()` blob
loaded from config; `saveConfig` handles both (`isEncrypted` guard from Task 2).

- [ ] **Step 4: Render the email fields**

The form body currently branches `type === 'heartbeat' ? (…) : (…telegram…)`. Turn it
into three branches (`heartbeat` → existing block; `telegram` → existing block;
`email` → new block). Keep the "Agent to Execute" `form-group` out of the email branch —
move it inside the heartbeat/telegram side, or wrap it in `{type !== 'email' && (…)}`.

The email block, using the same `form-group` markup as the telegram fields:

- `IMAP Host` — text, placeholder `e.g. imap.gmail.com`
- `Port` — `type="number"`, value `imapPort`
- `Use TLS (implicit, port 993)` — checkbox bound to `imapSecure`, same inline-checkbox
  markup as `task-enabled`
- `Username` — text, placeholder `e.g. you@example.com`
- `Password / App Password` — `type="password"`
- a `glass-form__help-card` (reuse the telegram card's inline styles) saying: credentials
  are AES-256-GCM encrypted at rest; Gmail/Outlook need an **app password**, not the
  account password; and — explicitly — *this service stores the connection only, nothing
  reads mail yet; the agent-facing email tool arrives in a later task.*

- [ ] **Step 5: List card**

The card currently special-cases `task.type === 'telegram'`. Make the non-heartbeat
subtitle generic so email shows type instead of cron/prompt, e.g.:

```tsx
                    {task.type === 'heartbeat' ? (
                      <>… existing agent + schedule + prompt lines …</>
                    ) : task.type === 'telegram' ? (
                      <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                        <strong>Agent:</strong> {agentName} · <strong>Type:</strong> <code>Telegram Poller</code>
                      </div>
                    ) : (
                      <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                        <strong>Type:</strong> <code>Email (IMAP)</code> · {task.imapUser} @ {task.imapHost}:{task.imapPort}
                      </div>
                    )}
```

The logs button is gated `task.type !== 'telegram'` — change it to
`task.type === 'heartbeat'` so email (which produces no runs) doesn't show it.

- [ ] **Step 6: Verify + commit**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```

```bash
git add packages/webview-ui/src/ServicesTab.tsx
git commit -m "feat(webview): add an Email (IMAP) service type to the Services tab"
```

---

### Task 5: Manual end-to-end check

No files.

- [ ] **Step 1: Create an email service in the web GUI**

```bash
CARETAKER_HOME=/tmp/ct-services pnpm -F @hyperwindmill/caretaker-cli dev web
```

At http://127.0.0.1:3000 → Settings → **Services**:
1. The tab is labelled Services; existing heartbeat/telegram entries still render and
   still save.
2. `+ Add Service` → type **Email (IMAP credentials)**: the cron/prompt/agent fields are
   gone, the IMAP fields appear, and saving without host/user/password is refused.
3. Save a service with host `imap.example.com`, port 993, user `me@example.com`,
   password `s3cret`.
4. `cat /tmp/ct-services/caretaker.json` → `scheduler.tasks[…].imapPassword` is an
   `encrypt()` blob, not `s3cret`; `imapHost`/`imapUser`/`imapPort`/`imapSecure` are
   plaintext.
5. Re-open the service for editing and save again with no changes → the blob in
   `caretaker.json` is byte-identical (no double encryption, no corruption).
6. Watch the server output for ~1 min: the scheduler tick logs nothing about the email
   service (no strategy, never ticked). Existing heartbeat/telegram services keep working.
7. Delete the email service → the entry disappears from `caretaker.json`.

- [ ] **Step 2: VSCode sidebar sanity (compact layout)**

The Services tab is gated to the `sidebar` layout like Projects and Voice — confirm the
compact/VSCode settings panel still renders Providers/Agents/Plugins/MCP with no
console error after the `TabId` rename.

---

### Task 6: Docs + changeset

**Files:** Modify `CLAUDE.md`, `README.md`; create `.changeset/services-rename-email-service.md`

- [ ] **Step 1: `CLAUDE.md`**

- Layer 5: after "The first two are per-agent strategies keyed by `task.type` and
  configured from the Scheduler settings panel", replace "Scheduler settings panel" with
  "**Services** settings panel" and append: a third service type, `email`, is
  **configuration only** — it stores IMAP host/port/user/password (encrypted) for a
  future agent-facing email tool, has **no strategy registered**, and is therefore never
  ticked; only `heartbeat` is cron-scheduled.
- **State on disk** §1: note that `caretaker.json` keeps the `scheduler.tasks` key for
  backward compatibility even though the surface is now called Services, and that
  `ServiceConfig` (formerly `ScheduledTaskConfig`, alias kept) carries the `imap*` fields
  with `imapPassword` encrypted by `saveConfig`.
- §7 bullet listing memoized call sites: `SchedulerTab` → `ServicesTab`.

- [ ] **Step 2: `README.md`**

- Line ~20 ("hosts the **Scheduler** settings tab") → "**Services** settings tab".
- Lines ~22–26 (TUI / VSCode / one-line availability note): keep the daemon called the
  scheduler; where the *UI* is meant, say Services.
- Line ~40 (secrets at rest): add IMAP service passwords to the list.
- `### Scheduler` section: keep the heading (it documents the daemon), and add one line —
  services are configured in the **Services** settings tab; of the three service types
  only `heartbeat` is cron-scheduled, `telegram` polls, and `email` stores credentials
  only (nothing reads mail yet — the agent-facing email tool is a separate task).
- Line ~304 repo tree: leave `scheduler.ts` / `scheduler/` as-is (unrenamed).

- [ ] **Step 3: Changeset**

Create `.changeset/services-rename-email-service.md`:

```md
---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'caretaker-types': minor
---

Rename the **Scheduler** settings surface to **Services** and add an **Email (IMAP)**
service type. Of the three service types only `heartbeat` is cron-scheduled: `telegram`
polls, and `email` stores an IMAP connection (host/port/user/password/TLS) with the
password AES-256-GCM encrypted at rest — nothing reads mail yet, the agent-facing email
tool is a separate change. `ScheduledTaskConfig` is renamed to `ServiceConfig`, with the
old name kept as a deprecated alias; the `caretaker.json` key stays `scheduler.tasks`, so
existing configs load unchanged.
```

- [ ] **Step 4: Full verification**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
pnpm -F webview-ui test
pnpm -F webview-ui build
```
Expected: all clean/PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/services-rename-email-service.md
git commit -m "docs: rename Scheduler to Services and document the email service type"
```

---

## Done when

- Settings shows a **Services** tab; `ServicesTab.tsx` exports `ServicesTab`; no
  `SchedulerTab` / `'scheduler'` tab id remains in `packages/webview-ui/src`.
- `ServiceConfig` is the type name (deprecated `ScheduledTaskConfig` alias kept); the
  `caretaker.json` key is still `scheduler.tasks` and pre-existing configs load unchanged.
- An email service can be created/edited/deleted with N instances, each named;
  `imapPassword` is stored as an `encrypt()` blob and is never double-encrypted.
- No IMAP client, poller, or strategy exists; an email service is never ticked.
- `json_services.test.ts` passes; CLI + webview tests, typecheck, and webview build are
  green; `CLAUDE.md`, `README.md`, and a `minor` changeset are updated.
