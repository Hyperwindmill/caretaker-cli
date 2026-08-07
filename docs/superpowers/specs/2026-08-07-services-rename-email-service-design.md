# Scheduler → Services + Email (IMAP) service type — design

**Date:** 2026-08-07
**Task:** caretaker task #29
**Status:** approved for implementation

## Problem

Two things, one unit of work:

1. The settings surface called **Scheduler** no longer describes what it holds. Of its
   two entry kinds only `heartbeat` is actually cron-scheduled; `telegram` is a poller.
   With a third kind arriving that neither polls nor ticks, "Scheduler" is wrong as a
   user-facing name for the *collection*.
2. We need a place to store **IMAP account credentials** so a later task can give agents
   an email tool. Today there is no such place.

## Scope

**In:**
- Rename the user-facing concept and the shared type: `Scheduler` → `Services`,
  `ScheduledTaskConfig` → `ServiceConfig`.
- A third service `type: 'email'` holding IMAP connection + auth fields, encrypted at
  rest by the existing `saveConfig` path. N instances, each with its own name.

**Out (explicitly, do not build):**
- Any runtime behaviour for `email`. No IMAP client, no poller, no strategy, no UID
  state, no agent invocation. The record is inert configuration.
- The `mcp__*` / builtin tool that lets an agent read or use a configured email service.
  Separate task.
- Renaming the daemon, its module tree, its log dir, or the `caretaker.json` key.

The task's original agent-generated checklist contained an IMAP poller
(`scheduler/email.ts`, UID dedupe, message → agent run). That is out of scope per the
objective's second OUT OF SCOPE line and has been dropped from the plan.

## Decisions

### 1. Rename the surface and the type; keep every internal `scheduler` identifier

Renamed:

| From | To |
| --- | --- |
| `ScheduledTaskConfig` (caretaker-types) | `ServiceConfig` (+ deprecated alias, see below) |
| `SchedulerTab.tsx` / `SchedulerTab` | `ServicesTab.tsx` / `ServicesTab` |
| `SettingsPanel` `TabId` `'scheduler'`, tab label "Scheduler" | `'services'`, "Services" |
| In-tab strings ("Scheduled Tasks", "Add Task", "Task Name", "Task Type", …) | Service wording |
| unstyled class `scheduler-tab` | `services-tab` (no CSS rule exists for either) |

Kept, deliberately:

- `CaretakerConfig.scheduler.tasks` — the JSON key. Renaming it means a migration for
  every existing `caretaker.json` (and a compat read path for older ones) to buy a nicer
  key name. Not worth it. The key is not user-visible.
- `cli/web/scheduler.ts`, `cli/web/scheduler/**`, `startBackgroundScheduler()`,
  `runSchedulerTick()`, `scheduler-logs/`, `getTaskRuns` bridge messages.
  **The daemon is still a scheduler** — it ticks every 15 s and drives cron heartbeats
  plus the autonomous-task heartbeat. "Services" names the *configuration collection*,
  not the daemon. Renaming internals would be a large diff with zero user-visible effect.

`ServiceConfig` reaches external consumers through the published CLI's `./types` entry
point, so the old name stays as a deprecated alias:

```ts
/** @deprecated Renamed to ServiceConfig. */
export type ScheduledTaskConfig = ServiceConfig;
```

One line, no breakage. All in-repo usages move to `ServiceConfig`.

### 2. Email is inert: no strategy, no registration

`runSchedulerTick()` dispatches through `strategies.get(task.type)` and skips a task
whose type has no entry. Adding `'email'` to the type union therefore needs **no**
scheduler change at all: an email service is never ticked, by construction. No
`scheduler/email.ts` is created.

### 3. Field shape — the minimum that authenticates against an IMAP server

Added to `ServiceConfig` (all optional, only meaningful when `type === 'email'`):

```ts
  /** email only: IMAP server host, e.g. imap.gmail.com */
  imapHost?: string;
  /** email only: IMAP port. 993 for implicit TLS, 143 for plaintext/STARTTLS. */
  imapPort?: number;
  /** email only: account/login name. */
  imapUser?: string;
  /** email only: password or app password. Encrypted at rest (encrypt() blob). */
  imapPassword?: string;
  /** email only: implicit TLS. Unset/true = TLS. */
  imapSecure?: boolean;
```

Skipped on purpose: `mailbox`, `fetchLimit`, OAuth/XOAUTH2, SMTP-side fields. The task
that adds the agent-facing tool knows what it needs to read and can add fields then;
guessing now produces config the UI must render and nothing consumes. `INBOX` is a
client-side default, not configuration.

### 4. `cron`, `prompt` and `agentId` stay required in the type

They are required today and are read unconditionally by `heartbeat.ts` and by the list
card. Making them optional for the sake of `email` would ripple into both for no gain.
Instead the email branch of the form fills placeholders — exactly what the telegram
branch already does (`finalPrompt = 'Telegram Poller'`, `finalCron = '* * * * *'`):

```ts
finalPrompt = 'Email (IMAP) credentials';
finalCron = '';
```

and `agentId` is left `''` with the "select an agent" validation skipped, because a
credentials-only record has no agent to run. The list card renders email like telegram
(type badge, no cron/prompt line, no logs button) rather than showing an agent.

### 5. Password storage: the telegram-token pattern verbatim

`store/json.ts:saveConfig` already walks `c.scheduler.tasks` and encrypts
`telegramBotToken` when `!isEncrypted(...)`. One more branch in the same loop covers
`imapPassword`. No new crypto path, no new module.

Consequence, accepted: the **encrypted blob** round-trips to the webview in the config
payload and back on save, where `isEncrypted()` stops double encryption. This is
identical to `telegramBotToken` today. A write-only/redacted field would need a
sentinel-preserve path on save and would make the email field behave differently from
every other secret in the same form — inconsistency for no security gain, since what
travels is ciphertext, not the password. Not built. (If secret redaction is ever wanted,
it is one change applied to *all* config secrets, not to this field.)

The MCP OAuth store (`oauthState`) is **not** reused: it is a DCR/PKCE token blob for a
different protocol. Only the `encrypt()`/`isEncrypted()` blob-at-rest convention is
shared, and that already lives in `lib/encryption.ts`.

## Verification

- `saveConfig` behaviour is the only logic where data can be lost or leaked, so it gets
  the test: a new `packages/cli/src/store/json_services.test.ts` (naming follows
  `json_voice.test.ts` / `json_projects.test.ts`) covering encrypt-on-save,
  no-double-encrypt, `decrypt()` round-trip, and non-email tasks untouched.
  `CARETAKER_HOME` is set at **file scope** (a temp dir), never per-`describe` — a local
  env setup inside a describe clobbers the developer's real store.
- No scheduler test is added: there is no email strategy to test, and asserting "the
  strategies map has no `email` key" tests a fact the map's own contents already state.
- Everything else is a mechanical rename plus a form branch: covered by
  `pnpm -F @hyperwindmill/caretaker-cli typecheck`, `pnpm -F webview-ui build`, the
  existing suites, and a manual pass in the web GUI (create/edit/delete an email
  service, confirm the ciphertext lands in `caretaker.json` and the scheduler log stays
  silent about it).

## Files

- `packages/types/src/index.ts` — rename + alias + email fields.
- `packages/cli/src/store/json.ts` — one encryption branch.
- `packages/cli/src/store/json_services.test.ts` — new.
- `packages/cli/src/cli/web/scheduler/{strategy,telegram,heartbeat}.ts` — type import rename only.
- `packages/webview-ui/src/SchedulerTab.tsx` → `ServicesTab.tsx` — rename, labels, email branch.
- `packages/webview-ui/src/SettingsPanel.tsx` — tab id, label, import.
- `README.md`, `CLAUDE.md`, `.changeset/*.md`.
