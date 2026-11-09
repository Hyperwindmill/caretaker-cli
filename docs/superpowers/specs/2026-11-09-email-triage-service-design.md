# Email Triage Service — Design

**Date:** 2026-11-09
**Status:** Draft

## Intent

Port the `email_triage` job of the sister project `caretaker-agents-platform`
(`src/scheduler/jobs/email_triage.ts`, spec `docs/superpowers/specs/2026-04-17-email-triage-job-design.md`
there) so a running process that depends on it can move to caretaker-cli and the
old instance can be retired.

One scheduled run triages **all** unread mail of one mailbox in a single agent
invocation and delivers a prioritised markdown report by SMTP to fixed
recipients. The host does every mechanical step (list envelopes, deliver,
mark read); the model only does what needs judgment (classify, summarise,
decide which bodies to open).

### Why a dedicated service and not a `heartbeat`

A heartbeat whose prompt says "fetch, classify, send" was evaluated and works,
but it is worse on the two axes that matter for a recurring job:

- **Cost.** An empty mailbox costs zero model calls here (the host sees no
  unread envelopes and stops); a heartbeat spends at least one turn per cron
  tick. A non-empty run also saves the fetch/send/mark tool turns, each of
  which replays the growing context.
- **Guarantees.** "Mark read only after the report was delivered" is a host
  invariant here, not a prompt instruction the model may skip. Losing the
  report while the inbox is marked processed was explicitly rejected in the
  original design.

This does not contradict the "no `email` scheduler strategy" decision in
`CLAUDE.md` layer 8 / `lib/email.ts`: that decision rejects a *generic inbound
reader* and rejects putting a schedule/prompt/agent on the *credentials
record*. The triage service is its own service type that **references** an
`email` account. Generic inbound workflows stay heartbeats.

## Goals

- New service type `email_triage` in the Services settings collection, cron-scheduled.
- Envelope-only prompt; the agent opens bodies on demand through a new
  read-only tool `mcp__email__email_read`.
- Host-side delivery (multipart HTML + text) and host-side `\Seen` marking,
  strictly after successful delivery.
- Works for native, claude-code and ACP agents (the latter two read bodies
  through the existing MCP bridge).
- Run history in the existing `scheduler-logs/` mechanism, viewable from the
  Services tab like heartbeat logs.

## Non-goals

- On-duty rotation. Recipients are a static list, edited when the turn changes.
- Replies or any agent-originated mail. The triage run never sends.
- Changing `email_fetch` semantics or adding `email_mark_seen` (that was the
  heartbeat alternative; not needed).
- Mailboxes other than `INBOX` (all existing email code is INBOX-only).
- A TUI form (the scheduler is web-server-only; Services are configured from
  the web GUI / desktop).

## Anti-goals (failure even if it "works")

- Mail marked `\Seen` that never appeared in a delivered report.
- Mail from senders outside the account's `allowedSenders` downloaded, shown
  to the model, or marked read.
- The host silently overriding the agent's tool configuration. Decided with
  the user: the tool picker is granular on purpose, and keeping send paths
  (`email_send`, `bash`, `invoke_agent`, an MCP server that can send) away
  from the triage agent is the configurer's job — the same stance as the old
  project. The host strips nothing from the agent's toolset; it only adds the
  run's own channel, `email_read`. The prompt still says not to send, and the
  README recommends a dedicated triage agent with read-only tools, because
  mail bodies are untrusted input.
- Business-specific rubric text (customer names, domains, "customs") shipped
  in the repo — caretaker is open source; the shipped instructions are generic.
- A log entry every cron tick for an empty mailbox.

## Configuration

`ServiceConfig` (`packages/types/src/index.ts`) gains `'email_triage'` in
`type` and these optional fields (only meaningful for this type):

| Field | Meaning |
|---|---|
| `agentId` (existing) | Agent that triages. Required. |
| `cron` (existing) | 5-field cron, evaluated by `matchesCron` like `heartbeat`. Required. |
| `prompt` (existing) | **Optional** extra triage instructions appended after the shipped ones: business rubric, output language. Empty = shipped instructions only. |
| `workingDir` (existing) | Same meaning as heartbeat (falls back to agent's). |
| `triageAccountId` | `id` of an `email` service record (stable across renames). Required. |
| `triageRecipients` | Report recipients, comma/newline separated (same parsing as `allowedRecipients`, no globs). At least one. |
| `triageMaxEmails` | Max envelopes per run. Default 50, clamped to `MAX_FETCH` (50). |
| `triageSubjectPrefix` | Default `[Email Triage]`. |

Decided with the user: **report recipients bypass the account's
`allowedRecipients`.** They are user configuration, deterministic, not chosen
by a model; `allowedRecipients` bounds what an *agent* may send.

Validation is **client-side only**, in `ServicesTab.tsx` `handleSave`, where
every other service check lives: account selected, ≥1 recipient, cron
non-empty. No server-side check in `saveConfig` (*designer's call*): the
settings form saves the whole config in one message, so a server rejecting a
dangling `triageAccountId` would block every unrelated settings save. An
account that is later disabled or deleted is caught at run time instead (run
flow step 1) — it logs one failure per cron match, which is the user's own
cadence, and the account can be deleted freely.

## Run flow

Strategy `scheduler/email_triage.ts`, registered next to heartbeat/telegram
in `cli/web/scheduler.ts`. `tick` mirrors `HeartbeatStrategy` (per-minute
dedupe + `matchesCron`) and launches `executeTriageRun(service)`
fire-and-forget, guarded by `runningTasks` on the service id.

1. **Resolve.** Agent + provider (as `executeTaskRun`), account by
   `triageAccountId`. `EmailAccount` has no `id` today and `emailAccounts()`
   drops disabled records: add `id` to `EmailAccount`, and look the raw
   service up first so a missing, non-`email`, or **disabled** account fails
   with a distinct readable error (a disabled account is not a valid target —
   *designer's call*). Do *not* go through `visibleAccounts`; if the account's
   `allowedAgents` is non-empty and does not include the triage agent, fail
   the run with a readable error (the user scoped the mailbox away from that
   agent; `email_read` would refuse anyway). Fail if `!canRead`, `!canSend`
   or no From address (preflight — before any IMAP state change or token
   spent).
2. **List envelopes.** One IMAP connection: `SEARCH UNSEEN` in INBOX, oldest
   first, scan window `MAX_SCAN`, ENVELOPE-only fetch, apply
   `allowedSenders` (refused ones counted, never fetched further, never
   marked). Keep up to `triageMaxEmails` allowed envelopes:
   `uid | from | subject | date`. Record the mailbox `uidValidity`. Close the
   connection — it is **not** held open across the agent run (minutes long;
   servers drop idle sessions).
3. **Nothing to do** (zero allowed envelopes) → return silently. No agent
   call, no log entry. (The refused count alone does not produce a log.)
4. **Run the agent once** via `harness.run`, unattended exactly like
   `executeTaskRun` (`confirmTool: 'once'`, `permissionMode:
   'bypassPermissions'`). Prompt = `[UNATTENDED RUN]` notice + shipped triage
   instructions + service `prompt` (if any) + account name (so the agent can
   call `email_read`) + envelope list. Toolset:
   - native: `resolveAgentTools(agent)` **plus** `mcp__email__email_read`
     (injected regardless of the picker, like the memory tool is gated by
     config rather than the picker — it is the run's own channel, not a
     capability the agent opted into). Nothing is removed: the agent's
     configured tools are honoured as-is (see Anti-goals);
   - claude-code / ACP: bridge injected the same way `task_strategy.ts` does
     for task runs (`issueBridgeToken(agentId, …)`, `extraMcpServers`, revoke
     in `finally`), but the token is **restricted to `email_read` only** — a
     new token option generalising the existing `execOnly` (e.g.
     `only: string[]` of tool names). The bridge serves the run's channel
     only — no task tools, no `email_send`; whatever the agent's own config
     (its `mcpServers`, `~/.claude` when `strictMcp` is off) brings is left
     alone. If the bridge URL is missing, run anyway with a warning (the
     agent triages from envelopes only). ACP runs must pass
     `acp: { mode: 'unattended', … }` explicitly — `executeTaskRun` passes no
     `acp` extras today, so copying it would leave ACP on the interactive
     policy.
   **Wall-clock budget** (*designer's call*): an `AbortController` aborts the
   run after 900 s for every provider type (`CLAUDE_CODE_DEFAULT_RUN_SECONDS`
   class; a 50-envelope triage that opens bodies can exceed the native 120 s
   default). Needed because `maxTurns` only bounds native runs and
   `executeTaskRun` passes no signal: a hung external runner would otherwise
   hold `runningTasks` forever and the mailbox would never be triaged again
   until restart.
5. **Decide whether there is a report** (*designer's call*). The report is
   the text of the **last assistant message** captured via `onMessage` — not
   `RunResult.text`, which concatenates every turn. Failure (log `failure`,
   no send, no mark — mail stays unread, next cron match retries) when:
   the run throws; `stop` is `max_turns` or `aborted` (a truncated run's last
   message may be "let me read uid 42"); or the last message does not contain
   a line starting with `## IMPORTANT`. When it does, anything before that line
   is dropped (tolerates a stray preamble instead of failing and re-spending
   tokens on every retry).
6. **Deliver.** `sendEmail(account, { to: recipients, subject, body: report,
   html: markdownToHtml(report) })`, no allowlist check (see Configuration).
   Subject: `<prefix> <N> emails triaged — YYYY-MM-DD HH:mm` (local time),
   N = envelopes included. SMTP failure → log `failure`, no mark.
7. **Mark read.** New connection; if the mailbox `uidValidity` differs from
   step 2, skip marking with a warning in the log. Otherwise
   `\Seen` on exactly the included UIDs. A failure here is a **warning, not a
   failure**: the report is out, worst case the same mail is triaged again.
8. **Log** `success` with the run messages via `saveTaskRun` (same shape as
   heartbeat), plus a short host summary line (included / refused / marked).

Steps 2 and 7 honour a run-level `AbortSignal` / `NET_TIMEOUT_MS` like
`fetchInbox` does.

## Shipped triage instructions

Ported from the old `buildPrompt`, made generic and English. Buckets:

- **IMPORTANT** — needs action soon: outages, blocked users/customers,
  failures, direct requests with a deadline.
- **INFORMATION** — worth knowing, no immediate action.
- **TRASH** — noise: automated notifications without a decision, time
  tracking, routine bot chatter. Count only, not listed.

Exact output shape (each bucket header always present, empty-state line
`_No important emails._` / `_No information emails._` when empty):

```markdown
## IMPORTANT
| From | Subject | Category | Summary | Suggested Action |

## INFORMATION
| From | Subject | Category | Summary | Suggested Action |

## TRASH
N emails classified as trash (not listed).
```

Guidelines kept from the original: envelopes only, open a body with
`email_read` only when the subject is not enough; cluster related
notifications into one row; other configured tools (e.g. an issue tracker
MCP) may be used to understand a reference; do not send mail — the final
message is delivered automatically and must contain only the report, starting
with `## IMPORTANT`.

The user's own rubric and "write in Italian" go into the service `prompt`
field, not into the repo.

## New tool: `mcp__email__email_read`

In `harness/tools/builtin/email_tools.ts`, registered like its siblings and
therefore also served by the builtin MCP server (stdio and bridge) and
offered in the pickers for ordinary use.

- Args: `account` (name), `uid` (number).
- Account resolution and `allowedAgents` scoping identical to `email_fetch`.
- Fetches the envelope first; if the sender is outside `allowedSenders`,
  returns the same "not found" error as a missing UID (do not leak that it
  exists).
- Returns `{ uid, from, to, subject, date, body, truncated?, attachments }`
  (same `InboundMessage` shape and `MAX_BODY_CHARS` cap as `email_fetch`).
- **Never sets `\Seen`** (peek fetch — verify imapflow's `source` fetch uses
  `BODY.PEEK[]`, add an explicit test against GreenMail or a mock).
- Read-only: not `dangerous`, not denied to the planner.

Factor the shared connect/lock/allowlist code in `lib/email.ts` rather than
duplicating `fetchInbox`.

## UI (webview `ServicesTab.tsx`)

- Type selector gains "Email triage".
- Form: agent, cron, account picker (only `email` services that can read and
  send), recipients textarea, max emails (number), subject prefix, optional
  instructions textarea (the `prompt` field), working dir as heartbeat.
- List card subtitle: agent · schedule · account name · recipients count.
- Logs button shown for `email_triage` as for `heartbeat` (same viewer, same
  `scheduler-logs/<id>` files).

## Docs and release

- `CLAUDE.md`: layer 5 gains the fifth loop; layer 8's "no `email` scheduler
  strategy" paragraph is reworded to say what it still rejects and points at
  the triage service; `email_read` added to the tool list.
- `README.md`: user-facing section on the triage service, including the
  recommendation of a dedicated triage agent with read-only tools.
- `ServiceConfig` doc comment updated (`email_triage` is cron-scheduled).
- Changeset: **minor**.

## Testing

- Strategy core with injected IMAP/SMTP/harness dependencies (the
  `accumulateAndFlush` pattern in `telegram.ts`), covering: empty mailbox → no
  agent call and no log; agent failure → no send, no mark; empty output → no
  send, no mark; `max_turns` / `aborted` stop → no send, no mark; last
  message without `## IMPORTANT` → no send, no mark; preamble before
  `## IMPORTANT` stripped; only the last assistant message is delivered;
  disabled / deleted account → failure before IMAP; SMTP failure → no mark; mark failure → success with warning;
  `uidValidity` change → no mark; only included UIDs marked; refused senders
  never included; `triageMaxEmails` cap; account scoped away from the agent →
  failure before IMAP.
- Toolset composition: for native runs `email_read` is present regardless of
  the agent's picker, and the agent's configured tools are otherwise unchanged.
- Bridge: a token restricted to `email_read` serves exactly that tool.
- `email_read`: allowlist refusal indistinguishable from missing UID; does not
  set `\Seen`.
- Prompt builder: snapshot of the envelope list + instructions + optional
  service prompt.
- Manual end-to-end against `docker-compose.mail.yml` (GreenMail).

## Left to the builder

- Module boundaries inside `scheduler/email_triage.ts` and how the shared
  IMAP helpers are factored in `lib/email.ts`.
- Exact wording of the shipped instructions, within the shape above.
- Whether the host summary line is a separate log message or part of the run
  record.
- Form layout details.
