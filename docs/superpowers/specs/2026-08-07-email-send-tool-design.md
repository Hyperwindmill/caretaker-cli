# Agent-facing email send tool — design

**Date:** 2026-08-07
**Status:** approved for implementation
**Follows:** [2026-08-07-services-rename-email-service-design.md](2026-08-07-services-rename-email-service-design.md),
which created the `email` service type as inert configuration and explicitly deferred
"the tool that lets an agent use a configured email service" to a separate task. This is
that task.

## Problem

An `email` service record stores IMAP credentials and does nothing. Agents cannot send
mail. The primary use is inside autonomous tasks — notably the hosted/Docker
configuration, where the agent has no other way to reach a human — so the tool must be
available to claude-code agents through MCP, not only to native agents.

Two gaps block it:

1. **No SMTP configuration.** The record has `imapHost/imapPort/imapUser/imapPassword/imapSecure`
   and nothing about sending.
2. **No SMTP client.** Node ships none, and there is nothing reusable in the repo.

## Scope

**In:**

- SMTP + allowlist fields on the existing `email` `ServiceConfig`, encrypted at rest on
  the same path as `imapPassword`.
- `lib/email.ts`: account listing/resolution, recipient allowlist matching, send.
- Two builtins: `mcp__email__email_list_accounts`, `mcp__email__email_send`.
- Exposure on every MCP surface the task tools already reach (stdio subcommand +
  per-task HTTP bridge), plus `mcp__email__*` opt-in for native agents.
- Planner-role exclusion on both the native and the claude-code path.
- Web UI fields for the new config, docs, changeset.

**Out (explicitly, do not build):**

- Any IMAP reading tool. `allowedSenders` is stored and surfaced now because we are
  already touching these fields, but nothing enforces it yet.
- Attachments, HTML bodies, templates, a queue, retries, per-agent account scoping,
  rate limiting. Security boundaries beyond the recipient allowlist are a separate
  discussion the user has explicitly deferred.
- A `telegram`-style poller or any scheduler strategy for `email`. Still no strategy;
  the record is still never ticked.

## Decisions

### 1. SMTP lives on the same `email` service record

Rejected: a separate `smtp` service type (two records per mailbox, and the agent must
know that "Work-IMAP" and "Work-SMTP" are one thing); deriving the SMTP host from the
IMAP host (`imap.x` → `smtp.x` guesses wrong on many providers and cannot express
GreenMail, where IMAP and SMTP share a host on different ports).

New optional fields on `ServiceConfig`:

```ts
smtpHost?: string;         // e.g. smtp.example.com
smtpPort?: number;         // 587 STARTTLS, 465 implicit TLS, 3025 GreenMail
smtpSecure?: boolean;      // implicit TLS. Unset/false = plain or STARTTLS-if-offered
smtpFrom?: string;         // envelope + header From. Default: imapUser
smtpUser?: string;         // default: imapUser
smtpPassword?: string;     // default: imapPassword. Encrypted at rest
allowedSenders?: string;   // comma/newline-separated globs. Stored, not yet enforced
allowedRecipients?: string;// comma/newline-separated globs. Enforced by email_send
```

One record = one account, inbound and outbound, one name for the agent to pick.

`smtpPassword` joins `imapPassword` in the `saveConfig` encryption branch
(`store/json.ts`), with the same "do not double-encrypt an already-encrypted value"
guard and a matching test.

### 2. The allowlists are separate and only one of them is enforced now

`allowedRecipients` is checked against every `to`/`cc`/`bcc` address before any
connection is opened. Empty/unset = no restriction: retro-compatible with the records
that already exist, and the wider boundary question is deferred by decision.

`allowedSenders` means "who may write **to** us" — inbound semantics, for the future
IMAP tool. It is deliberately **not** cross-checked against `smtpFrom`: a user who fills
it with `*@client.com` (the correct inbound meaning) would otherwise find outbound
sending broken.

Matching: one glob syntax, `*` only, case-insensitive, applied to the whole address.
`*@example.com`, `*`, `me@example.com`. Implemented by escaping regex metacharacters and
expanding `*` to `.*` — no dependency, one pure function, unit-tested.

### 3. nodemailer for SMTP

nodemailer 9.0.5 has **zero runtime dependencies** and handles STARTTLS, AUTH
PLAIN/LOGIN, MIME, non-ASCII encoding and dot-stuffing. `@types/nodemailer` goes in
`devDependencies` (the package ships no types).

Rejected: hand-rolling SMTP on `node:net`/`node:tls` (~100–150 lines of protocol dialog,
base64 auth, quoted-printable headers, dot-stuffing). Fewer dependencies, but a protocol
parser to maintain, and an edge-case bug means rejected or corrupted mail. Correctness on
an auth-carrying network path outranks dependency count.

### 4. Tool names mirror the task tools; one shared prefix filter lights every surface

Registry names: `mcp__email__email_list_accounts`, `mcp__email__email_send` — exactly the
shape the task tools already use (`mcp__task__task_complete`), so the generic strip
`/^mcp__[a-z]+__/` exposes them over MCP as `email_list_accounts` / `email_send`.

`mcp/task_server.ts` is a **single builder shared by both** the stdio subcommand
(`cli/mcp.ts`) and the per-task HTTP bridge (`cli/web/mcp_bridge.ts`); the tool set comes
from one prefix filter. Adding `mcp__email__` to that filter therefore serves both
surfaces at once — and *excluding* the bridge would cost an extra parameter. The function
is renamed (`buildTaskMcpServer` → `buildBuiltinMcpServer`) because it no longer serves
only task tools; three call sites plus its test.

Consequences, verified in the code rather than assumed:

- A claude-code agent running a task receives the bridge as MCP server `task`
  (`task_strategy.ts` → `claudeCodeTaskExtras`), so its tools are named
  `mcp__task__email_send` on that side. The Docker and planner allowlists match by the
  `mcp__task` prefix, so **no allowlist entry has to change**.
- An external claude-code session with `caretaker-cli mcp` in `~/.claude` and
  `strictMcp` off gets the same tools in ordinary chat, via the existing documented path.

| tool | arguments | returns |
| --- | --- | --- |
| `mcp__email__email_list_accounts` | — | for each enabled `email` service: name, from address, SMTP host:port, recipient allowlist. **Never a password** |
| `mcp__email__email_send` | `account` (service name), `to`, `cc?`, `bcc?`, `subject`, `body` | provider message id, or a tool error |

`to`/`cc`/`bcc` accept a single address or a list. `body` is plain text; no HTML, no
attachments. Account lookup is by `name`, case-insensitive, `enabled` records only; an
unknown or disabled name returns an error listing the available names.

Validation order inside `email_send`: resolve account → require `smtpHost` → check every
recipient against `allowedRecipients` → only then connect. A rejected recipient fails the
whole call before any network I/O, so there is no partial send.

### 5. Native agents opt in through a generalized wildcard

`resolve.ts` special-cases the literal string `mcp__task__*` in `allowedTools`. That
branch becomes generic: any `mcp__<ns>__*` entry pulls in the registry tools carrying
that prefix. `AgentsTab.tsx` follows with the equivalent one-line change so the picker
offers `mcp__email__*`. This keeps the documented invariant intact — email tools are
gated by `allowedTools` like every other non-introspection builtin, and the `[!]`
confirm-each-call state works on them.

### 6. The planner role cannot send mail

The planning cycle is read-only to keep unreviewed work out of the repo; sending mail is
an *external* side effect, strictly worse than a write. Both paths deny it:

- native: the two tool names join `PLANNER_TOOL_DENYLIST` (`task_roles.ts`);
- claude-code: they join the planner's `disallowedTools` (currently `['Bash']`) in
  `claudeCodeTaskExtras`.

Developer and reviewer cycles keep the tools.

## Files

| file | change |
| --- | --- |
| `packages/types/src/index.ts` | new `smtp*` / `allowed*` fields on `ServiceConfig` |
| `packages/cli/src/store/json.ts` | encrypt `smtpPassword` |
| `packages/cli/src/store/json_services.test.ts` | `smtpPassword` encryption + no-double-encrypt |
| `packages/cli/src/lib/email.ts` *(new)* | account list/resolve, allowlist match, send |
| `packages/cli/src/lib/email.test.ts` *(new)* | pure-logic tests |
| `packages/cli/src/harness/tools/builtin/email_tools.ts` *(new)* | the two tools |
| `packages/cli/src/harness/tools/builtin/email_tools.test.ts` *(new)* | allowlist refusal, unknown account |
| `packages/cli/src/harness/tools/builtin/index.ts` | register + export |
| `packages/cli/src/harness/tools/resolve.ts` | generic `mcp__<ns>__*` wildcard |
| `packages/cli/src/mcp/task_server.ts` | prefix list, generic strip, rename |
| `packages/cli/src/cli/mcp.ts`, `cli/web/mcp_bridge.ts` | renamed import |
| `packages/cli/src/cli/web/scheduler/task_roles.ts` | planner denylist |
| `packages/cli/src/harness/claude_code_runner.ts` | planner `disallowedTools` |
| `packages/webview-ui/src/ServicesTab.tsx` | SMTP + allowlist form fields, list-card summary |
| `packages/webview-ui/src/AgentsTab.tsx` | `mcp__email__*` picker entry |
| `CLAUDE.md`, `README.md`, `.changeset/*` | docs (the "email is inert configuration" paragraph is now wrong), minor bump |

## Testing

Automated, on the parts worth testing:

- allowlist matching: `*@example.com`, bare `*`, exact address, case differences, an
  address that matches none, empty allowlist = allow.
- account resolution: by name case-insensitively, `enabled` filter, `smtpFrom`/`smtpUser`/
  `smtpPassword` defaulting to the `imap*` values.
- `email_send` refuses a recipient outside the allowlist and an unknown account name
  **without opening a connection** (no SMTP stub needed — the guard runs first).

Manual, once: the GreenMail fixture already in `docker-compose.mail.yml` (SMTP on
`127.0.0.1:3025`, no auth, no TLS) — configure an `email` service pointing at it, have an
agent call `email_list_accounts` then `email_send`, and read the message back over IMAP
`3143`.

No test drives a real SMTP dialog; that is nodemailer's own test suite's job.
