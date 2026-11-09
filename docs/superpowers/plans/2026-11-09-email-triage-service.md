# Email Triage Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cron-scheduled `email_triage` service that triages all unread mail of one `email` account in one agent run, delivers the markdown report by SMTP, and marks the mail read only after delivery.

**Architecture:** Host-side IMAP helpers in `lib/email.ts` (list envelopes / peek-read one / mark seen) feed a dependency-injected orchestrator in `cli/web/scheduler/email_triage.ts`; the agent is run once through `harness.run` with a new read-only `mcp__email__email_read` tool (native) or a bridge token restricted to that tool (claude-code / ACP). The webview Services form gains the new type.

**Tech Stack:** TypeScript ESM, imapflow, nodemailer, marked, Node test runner via tsx, React (webview-ui).

**Spec:** `docs/superpowers/specs/2026-11-09-email-triage-service-design.md`

## Global Constraints

- All code, comments, docs in English. Shipped instructions generic: no customer names, domains, business terms.
- Tests co-located `*.test.ts`, `node:test` + `node:assert/strict`, run via tsx. `CARETAKER_HOME` set at **file scope**, never inside a `describe`.
- `pnpm test` does not typecheck: every task ends with `pnpm -F @hyperwindmill/caretaker-cli typecheck` (and `pnpm -F webview-ui typecheck` if it touched webview-ui) green.
- After touching `packages/types`, run `pnpm -F caretaker-types build` before typechecking siblings.
- INBOX only. `triageMaxEmails` default 50, clamped to `MAX_FETCH` (50). Envelope scan window `MAX_SCAN` (200). Body cap `MAX_BODY_CHARS` (8000).
- Wall-clock budget per triage run: `CLAUDE_CODE_DEFAULT_RUN_SECONDS` (900 s) for every provider type.
- Report recipients bypass the account's `allowedRecipients`. The host never removes tools from the agent's configured toolset; it only adds `email_read`.
- `\Seen` is set only on included UIDs, only after SMTP succeeded, only if `uidValidity` is unchanged.
- An empty mailbox (zero allowed envelopes) produces no agent call and no log entry.
- Never rewrite commits; one commit per task (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer).

## Review Focus

- A user's service prompt says "write in Italian" and the model translates the headers (`## IMPORTANTE`): every run is rejected and retried each cron match, burning tokens. The shipped instructions must say headers are literal and never translated → test in Task 4 (`buildTriagePrompt` contains the literal-headers rule).
- The agent opens a body with `email_read` and that mail ends up `\Seen` before the report goes out → GreenMail test in Task 1 (`readMessage` leaves the message unseen).
- A mail that arrives while the agent is running is marked read without ever being in a report → test in Task 4 (only the included UIDs reach `markSeen`).
- A cron match fires while the previous triage of the same service is still running and the mailbox is triaged twice → test in Task 4 (second `executeTriageRun` returns `skipped` while the first is in flight).
- Recipients typed as `Ada <ada@example.com>, bob@example.com` or one per line reach SMTP as two clean addresses → test in Task 4 (`parseRecipients`).

---

### Task 1: IMAP helpers and account id in `lib/email.ts`

**Files:**
- Modify: `packages/cli/src/lib/email.ts`
- Modify: `packages/cli/src/lib/email.test.ts`
- Create: `packages/cli/src/lib/email_imap.test.ts` (GreenMail-gated)

**Interfaces:**
- Produces:
  - `EmailAccount.id: string` (the service record id), filled by `emailAccounts()`.
  - `type TriageEnvelope = { uid: number; from: string; subject: string; date: string }` (`date` ISO via `isoDate`).
  - `listUnseenEnvelopes(account: EmailAccount, max: number, signal?: AbortSignal): Promise<{ envelopes: TriageEnvelope[]; refused: number; uidValidity: string }>` — UNSEEN, oldest first, window `MAX_SCAN`, ENVELOPE only, `allowedSenders` applied host-side, at most `clampLimit(max)` envelopes. Never fetches bodies, never sets flags.
  - `readMessage(account: EmailAccount, uid: number, signal?: AbortSignal): Promise<InboundMessage | null>` — `null` when the UID does not exist **or** the sender is outside `allowedSenders`. Fetches the source with peek semantics (must not set `\Seen`).
  - `markSeen(account: EmailAccount, uids: number[], expectedUidValidity: string, signal?: AbortSignal): Promise<'marked' | 'uidvalidity-changed'>`.
  - `markdownToHtml` also styles tables inline (`border-collapse` on `<table>`, `border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top` on `th`/`td`, `border="1"` attribute on `<table>` for old Outlook).

- [ ] **Step 1: Write the failing unit tests** in `email.test.ts`:
  - `emailAccounts carries the service id` — `emailAccounts([email({ id: 'svc_9' })])[0].id === 'svc_9'`.
  - `markdownToHtml styles tables inline` — input `'| a | b |\n|---|---|\n| 1 | 2 |'`; assert `/<table border="1"[^>]*style="[^"]*border-collapse/`, `/<th style="[^"]*border:1px solid/`, `/<td style="[^"]*border:1px solid/`.
- [ ] **Step 2: Write the GreenMail-gated tests** in `email_imap.test.ts`. At file top probe `127.0.0.1:3143` with `net.connect` (500 ms); every test gets `{ skip: !reachable && 'GreenMail not running (docker compose -f docker-compose.mail.yml up -d)' }`. Use a fresh mailbox per test (`user-<random>@example.com`), deliver with `sendEmail` via SMTP `127.0.0.1:3025` (secure false, no auth), account IMAP `127.0.0.1:3143`, `imapSecure: false`. Tests:
  - `listUnseenEnvelopes returns allowed envelopes oldest first and counts refused` — deliver from `a@ok.com`, `x@bad.com`, `b@ok.com`; `allowedSenders: '*@ok.com'` → envelopes `[a, b]` by from, `refused === 1`, `uidValidity` non-empty.
  - `listUnseenEnvelopes caps at max` — 3 delivered, `max 2` → 2 envelopes.
  - `listUnseenEnvelopes leaves everything unseen` — call it, then call again → same count.
  - `readMessage does not set \Seen` — read one UID, then `listUnseenEnvelopes` still includes it.
  - `readMessage returns null for a refused sender and for a missing uid` — both `null`.
  - `markSeen marks only the given uids` — 2 delivered, mark first → next listing has only the second.
  - `markSeen refuses on a different uidValidity` — pass `'0'` → `'uidvalidity-changed'`, listing unchanged.
- [ ] **Step 3: Run** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/email.test.ts` → the two new unit tests FAIL. Start GreenMail (`docker compose -f docker-compose.mail.yml up -d`) and run `email_imap.test.ts` → FAIL (functions missing).
- [ ] **Step 4: Implement.** Factor the connect / `armAbort` / `getMailboxLock('INBOX')` / logout block of `fetchInbox` into a private `withInbox<T>(account, signal, fn: (client: ImapFlow) => Promise<T>): Promise<T>` and rewrite `fetchInbox` on top of it (behaviour unchanged — existing tests stay green). `uidValidity` from `client.mailbox.uidValidity` as `String(...)`. For `readMessage`, fetch ENVELOPE first (allowlist), then `fetchOne(String(uid), { source: true, internalDate: true }, { uid: true })`; verify in imapflow's source that `source: true` requests `BODY.PEEK[]` — if it does not, request the peek explicitly; the GreenMail test is the proof. Build the `InboundMessage` with the same code `fetchInbox` uses (extract a private `toInbound(uid, parsed, internalDate)`). Add `id: s.id` in `emailAccounts`. Table styling: post-process the `marked` output with string replaces on `<table>`, `<th>`, `<td>` (marked emits `<th>`/`<td>` possibly with `align` attributes — match `<th` / `<td` tag openings, not the exact string).
- [ ] **Step 5: Run** both test files → PASS (with GreenMail up). Run `pnpm -F @hyperwindmill/caretaker-cli test` → everything green (IMAP tests skip when GreenMail is down). Typecheck green.
- [ ] **Step 6: Commit** `feat(email): host-side IMAP helpers for envelope listing, peek read and mark seen`.

---

### Task 2: `mcp__email__email_read` tool

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/email_tools.ts`
- Modify: `packages/cli/src/harness/tools/builtin/index.ts` (register + export list, next to `emailFetchTool`)
- Modify: `packages/cli/src/harness/tools/builtin/email_tools.test.ts`
- Modify: `packages/cli/src/lib/email_imap.test.ts` (one gated end-to-end)

**Interfaces:**
- Consumes: `readMessage` (Task 1), `listEmailAccounts`, `findAccount`, `canRead`.
- Produces: `export const emailReadTool: Tool` named `mcp__email__email_read`, args `{ account: string, uid: number }` (both required), not `dangerous`. Result JSON: `{ account, message: InboundMessage }`, or `{ error }`. A refused sender and a missing UID both return exactly `{ error: 'No message with uid <uid> in "<account>".' }`.

- [ ] **Step 1: Write failing tests** in `email_tools.test.ts` (no network — reuse the `service()` fixture):
  - `email_read rejects a non-integer uid` — `uid: 'x'` and `uid: 1.5` → `error` mentions `uid`.
  - `email_read hides an account scoped to another agent` — `allowedAgents: ['other']`, `ctx.callerAgent = { id: 'me' }` → `error` matches `/Unknown email account/`.
  - `email_read refuses an account without IMAP` — `imapHost: ''` → `/cannot be read/`.
  - Add to `email_imap.test.ts`: `email_read returns the body and leaves it unseen` (tool executed against a saved GreenMail account).
- [ ] **Step 2: Run** the test file → FAIL (`emailReadTool` not exported).
- [ ] **Step 3: Implement** `emailReadTool` mirroring `emailFetchTool`'s account resolution and error wording; description states it does **not** mark the message read and returns `null`-equivalent "No message" for mail the account may not show. Register in `index.ts`.
- [ ] **Step 4: Run** → PASS; full CLI test + typecheck green. Confirm `builtinMcpTools()` now includes `mcp__email__email_read` (served prefix), so the stdio server exposes it with no further change.
- [ ] **Step 5: Commit** `feat(email): add read-only email_read tool`.

---

### Task 3: Bridge token restricted to named tools

**Files:**
- Modify: `packages/cli/src/cli/web/mcp_bridge.ts`
- Modify: `packages/cli/src/cli/web/mcp_bridge.test.ts`

**Interfaces:**
- Produces: `issueBridgeToken(agentId?: string, opts?: { exec?; execOnly?; only?: string[] })`. When `only` is set the served tools are `builtinMcpTools().filter(t => only.includes(t.name))` (full `mcp__…` names), and `exec` is ignored.

- [ ] **Step 1: Write failing test** `a token restricted with only serves exactly those tools` — `issueBridgeToken('', { only: ['mcp__email__email_read'] })`, list tools through the existing `client(token)` helper → names deep-equal `['email_read']`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the `only` field on `TokenInfo` and the branch in the request handler.
- [ ] **Step 4: Run** → PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(mcp-bridge): tokens restricted to named tools`.

---

### Task 4: Triage orchestrator (types, pure helpers, DI core)

**Files:**
- Modify: `packages/types/src/index.ts` (`ServiceConfig`)
- Create: `packages/cli/src/cli/web/scheduler/email_triage.ts`
- Create: `packages/cli/src/cli/web/scheduler/email_triage.test.ts`

**Interfaces:**
- Consumes: Task 1 (`EmailAccount.id`, `TriageEnvelope`, `emailAccounts`, `canRead`, `canSend`, `markdownToHtml`, `OutgoingMail`, `clampLimit`), `runningTasks` (`scheduler/locks.ts`), `CLAUDE_CODE_DEFAULT_RUN_SECONDS` (`scheduler/task_roles.ts`).
- Produces:
  - `ServiceConfig.type` gains `'email_triage'`; new optional fields `triageAccountId?: string`, `triageRecipients?: string`, `triageMaxEmails?: number`, `triageSubjectPrefix?: string`. Doc comment: `email_triage` is cron-scheduled; `prompt` holds optional extra triage instructions.
  - `TRIAGE_INSTRUCTIONS: string` (exported constant).
  - `buildTriagePrompt(p: { accountName: string; extra: string; envelopes: TriageEnvelope[] }): string`
  - `extractReport(messages: MessageRecord[], stop: 'done' | 'max_turns' | 'aborted'): string | null`
  - `triageSubject(prefix: string, count: number, now: Date): string`
  - `parseRecipients(raw: string | undefined): string[]`
  - `resolveTriageAccount(services: ServiceConfig[], service: ServiceConfig, agentId: string): { account: EmailAccount } | { error: string }`
  - `type TriageDeps = { load(): Promise<{ agents: AgentConfig[]; config: CaretakerConfig }>; listEnvelopes(account, max, signal): ReturnType<typeof listUnseenEnvelopes>; runAgent(i: TriageAgentInput): Promise<{ messages: MessageRecord[]; stop: 'done' | 'max_turns' | 'aborted' }>; send(account, mail: OutgoingMail, signal): Promise<string>; markSeen(account, uids, uidValidity, signal): Promise<'marked' | 'uidvalidity-changed'>; saveRun(serviceId: string, run: unknown): Promise<void>; now(): Date }`
  - `type TriageAgentInput = { agent: AgentConfig; provider: ProviderConfig; prompt: string; account: EmailAccount; workingDir: string; signal: AbortSignal }`
  - `type TriageOutcome = { kind: 'skipped' } | { kind: 'failure'; error: string } | { kind: 'success'; included: number; refused: number; marked: boolean; warning?: string }`
  - `executeTriageRun(service: ServiceConfig, deps: TriageDeps): Promise<TriageOutcome>` — the `runningTasks` guard (`skipped` when held), the 900 s `AbortController` timer, the whole spec run flow, logging via `deps.saveRun`.

**Behaviour the tests pin (spec "Run flow"):**
- Order: load → resolve agent + provider → `resolveTriageAccount` → `listEnvelopes` → (0 envelopes ⇒ `skipped`, no `saveRun`) → `runAgent` → `extractReport` → `send` → `markSeen` → `saveRun`.
- `extractReport`: `null` unless `stop === 'done'`; takes the **last assistant message with non-empty `content`**; returns the text from the first line matching `/^## IMPORTANT\s*$/m` to the end, trimmed; `null` if no such line.
- `resolveTriageAccount` errors (distinct wording each): no record with that id; record not `type: 'email'`; record disabled; `allowedAgents` non-empty without `agentId`; `!canRead`; `!canSend`; empty `from`.
- Failure (`saveRun` with `status: 'failure'`, `error`, no `send`, no `markSeen`): agent/provider missing, account error, `listEnvelopes` throws, `runAgent` throws, `extractReport` null (error says which: stop reason or missing `## IMPORTANT`), `send` throws.
- `send` called once with `to: parseRecipients(service.triageRecipients)`, `subject: triageSubject(prefix ?? '[Email Triage]', included, now)`, `body: report`, `html: markdownToHtml(report)`. No allowlist check.
- `markSeen` throws or returns `'uidvalidity-changed'` ⇒ outcome `success` with `marked: false` and a `warning`; the log is `success`.
- Log record shape = heartbeat's (`runId`, `timestamp`, `status`, `error?`, `messages` mapped like `executeTaskRun`), plus a final assistant message `Triage: <included> included, <refused> refused by sender allowlist, <marked ? 'marked read' : 'not marked read: ' + warning>`.
- `TRIAGE_INSTRUCTIONS` = the spec's "Shipped triage instructions", plus the sentence: headers, bucket names and the table header row are literal and must never be translated, whatever language the rest of the report is written in.
- Prompt order: `[UNATTENDED RUN]` notice (same text as `heartbeat.ts`), `TRIAGE_INSTRUCTIONS`, `extra` (omitted when blank), `Account: <name> — pass it as the account argument of email_read.`, then `Unread emails (UID | From | Subject | Date):` and one `- uid | from | subject | date` line per envelope.

- [ ] **Step 1: Types.** Add the `ServiceConfig` fields; `pnpm -F caretaker-types build`.
- [ ] **Step 2: Write failing tests** in `email_triage.test.ts` (file-scope `CARETAKER_HOME` temp dir; fake `TriageDeps` recording calls):
  - pure: `extractReport` — returns from `## IMPORTANT` dropping a preamble; uses the last non-empty assistant message; `null` on `max_turns`, on `aborted`, without the header.
  - pure: `triageSubject('[Email Triage]', 3, new Date(2026, 10, 9, 8, 5))` → `'[Email Triage] 3 emails triaged — 2026-11-09 08:05'`.
  - pure: `parseRecipients('Ada <ada@example.com>, bob@example.com\ncy@example.com;')` → `['Ada <ada@example.com>', 'bob@example.com', 'cy@example.com']`.
  - pure: `buildTriagePrompt` includes each envelope line, the account name, `extra` when given, and the literal-headers sentence; omits the extra block when `extra` is blank.
  - pure: `resolveTriageAccount` — one test per error case above, plus the happy path.
  - core: `empty mailbox → skipped, no runAgent, no saveRun`.
  - core: `happy path sends once and marks exactly the included uids` — envelopes uids `[4, 7]`; assert `markSeen` got `[4, 7]` and the stored `uidValidity`; a uid the fake "adds" later is never passed.
  - core: `agent throws → failure logged, no send, no mark`.
  - core: `max_turns → failure, no send, no mark`.
  - core: `report without ## IMPORTANT → failure, no send, no mark`.
  - core: `smtp failure → failure logged, no mark`.
  - core: `markSeen throws → success with warning, log status success`.
  - core: `uidvalidity changed → success, marked false`.
  - core: `account disabled → failure before listEnvelopes`.
  - core: `second run while the first is in flight → skipped` (first `listEnvelopes` awaits a deferred promise).
  - core: `the run is aborted after the budget` — use `mock.timers` (`node:test`) to advance 900 s; `runAgent` receives an aborted `signal`.
- [ ] **Step 3: Run** `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/email_triage.test.ts` → FAIL.
- [ ] **Step 4: Implement** `email_triage.ts` (no `harness` import in this file — the agent runner arrives through `deps.runAgent`).
- [ ] **Step 5: Run** → PASS; full CLI tests + typecheck green.
- [ ] **Step 6: Commit** `feat(scheduler): email triage orchestrator`.

---

### Task 5: Agent runner wiring and strategy registration

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/email_triage_agent.ts`
- Create: `packages/cli/src/cli/web/scheduler/email_triage_agent.test.ts`
- Modify: `packages/cli/src/cli/web/scheduler/email_triage.ts` (add `EmailTriageStrategy` + `realTriageDeps`)
- Modify: `packages/cli/src/cli/web/scheduler.ts` (register the strategy)

**Interfaces:**
- Consumes: `TriageDeps`, `TriageAgentInput`, `executeTriageRun` (Task 4); `issueBridgeToken({ only })` (Task 3); `emailReadTool` (Task 2); `listUnseenEnvelopes`, `sendEmail`, `markSeen` (Task 1); `claudeCodeTaskExtras` (`harness/claude_code_runner.ts`), `acpTaskExtras` (`harness/acp_policy.ts`), `getTaskBridgeUrl`/`revokeBridgeToken` (`mcp_bridge.ts`), `saveTaskRun` (`scheduler/logs.ts`), `matchesCron` (`scheduler/heartbeat.ts`).
- Produces:
  - `triageTools(agent: AgentConfig, registry: ToolRegistry): Promise<Tool[]>` — `resolveAgentTools(agent, registry)` plus `mcp__email__email_read` if absent; nothing removed.
  - `runTriageAgent(i: TriageAgentInput): Promise<{ messages: MessageRecord[]; stop }>` — `harness.run` with `agent: { ...agent, permissionMode: 'bypassPermissions' }`, `history: []`, `confirmTool: async () => 'once'`, `signal: i.signal`, messages collected from `onMessage`. claude-code: `claudeCode = claudeCodeTaskExtras({ planning: false, sdd: false, bridge })`; acp: `acp = acpTaskExtras({ planning: false, sdd: false, bridge })` (gives `mode: 'unattended'`); bridge token `issueBridgeToken(agent.id, { only: ['mcp__email__email_read'] })`, revoked in `finally`; missing bridge URL ⇒ `console.warn` and run without it.
  - `realTriageDeps: TriageDeps`.
  - `EmailTriageStrategy: SchedulerStrategy` with `type: 'email_triage'`; `tick` = heartbeat's per-minute dedupe + `matchesCron(service.cron, now)` then `void executeTriageRun(service, realTriageDeps)`.

- [ ] **Step 1: Write failing tests** in `email_triage_agent.test.ts` (file-scope `CARETAKER_HOME`, a registry built like the builtin one):
  - `triageTools adds email_read to an agent that did not pick it`.
  - `triageTools keeps the agent's configured tools, email_send included` — agent `allowedTools: ['mcp__email__*', 'bash']` → result contains `mcp__email__email_send` and `bash` and exactly one `mcp__email__email_read`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `email_triage_agent.ts`, `realTriageDeps`, `EmailTriageStrategy`; register in `scheduler.ts` `strategies`.
- [ ] **Step 4: Run** → PASS; full CLI tests + typecheck green.
- [ ] **Step 5: Commit** `feat(scheduler): run the email triage service on its cron`.

---

### Task 6: Services form

**Files:**
- Create: `packages/webview-ui/src/services_form_utils.ts`
- Create: `packages/webview-ui/src/services_form_utils.test.ts`
- Modify: `packages/webview-ui/src/ServicesTab.tsx`

**Interfaces:**
- Consumes: `ServiceConfig` triage fields (Task 4).
- Produces: `triageFormError(f: { agentId: string; cron: string; accountId: string; recipients: string; maxEmails: string }, accounts: ServiceConfig[]): string | null` and `triageAccountOptions(services: ServiceConfig[]): ServiceConfig[]` (enabled `email` records with both `imapHost` and `smtpHost`).

- [ ] **Step 1: Write failing tests**: `triageFormError` → message for missing agent, cron not 5 fields, no account, account id not in `accounts`, no recipient, `maxEmails` not an integer 1–50; `null` for a valid form. `triageAccountOptions` drops disabled, send-only, read-only and non-email services.
- [ ] **Step 2: Run** `pnpm -F webview-ui exec tsx --test src/services_form_utils.test.ts` → FAIL.
- [ ] **Step 3: Implement** the utils, then the form in `ServicesTab.tsx`: type option "Email triage"; fields agent, cron, account `<select>` from `triageAccountOptions(tasks)`, recipients textarea (one per line), max emails (default `50`), subject prefix (placeholder `[Email Triage]`), optional instructions textarea bound to `prompt`, working dir as heartbeat. `handleSave` uses `triageFormError`; the saved record carries the four `triage*` fields and `prompt` as typed (may be empty). `startEdit` loads them. List card subtitle: `Agent: <name> · Schedule: <cron> · Account: <account name or "missing"> · <n> recipient(s)`. Show the logs button for `email_triage` as for `heartbeat`.
- [ ] **Step 4: Run** the utils test → PASS; `pnpm -F webview-ui test` and `pnpm -F webview-ui typecheck` green; `pnpm -F webview-ui build` succeeds.
- [ ] **Step 5: Commit** `feat(webview): email triage service form`.

---

### Task 7: Docs, changeset, end-to-end check

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `packages/cli/src/lib/email.ts` (the "no `email` scheduler strategy" comment above `MAX_FETCH`)
- Create: `.changeset/email-triage-service.md`

- [ ] **Step 1: CLAUDE.md** — layer 5: "runs **four** loops" stays about the always-on loops; add `email_triage` next to heartbeat/telegram as a per-agent cron strategy (flow, mark-after-delivery, 900 s budget, report extraction rule, bridge `only` token). Layer 8: reword "No `email` scheduler strategy…" to say a generic inbound reader stays a heartbeat while the triage service references an account; add `email_read` to the tool list (read-only, peek, refused = not found). Layer 2: three served namespaces sentence mentions `email_read`. State on disk: `ServiceConfig` triage fields. Mention that the host never strips the agent's tools.
- [ ] **Step 2: README** — user-facing "Email triage" section: what it does, the fields, that mail is marked read only after the report is delivered, recommendation of a dedicated triage agent with read-only tools (mail bodies are untrusted input), put rubric/language in the instructions field, headers stay literal.
- [ ] **Step 3: Comment** in `lib/email.ts` aligned with Step 1.
- [ ] **Step 4: Changeset** — `minor` for the fixed group (`"@hyperwindmill/caretaker-cli": minor`), one paragraph.
- [ ] **Step 5: End-to-end against GreenMail** — `docker compose -f docker-compose.mail.yml up -d`; `CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev web`; create an email account (IMAP 3143 / SMTP 3025, TLS off) and a triage service with cron `* * * * *`; deliver 3 mails with the compose file's python snippet; within ~1 minute: a report mail arrives in the recipient mailbox, the 3 source mails are `\Seen`, the run appears in the service logs. Deliver nothing for a minute: no new log entry. Report what was observed.
- [ ] **Step 6: Commit** `docs: email triage service` (changeset included).
