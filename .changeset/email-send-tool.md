---
'@hyperwindmill/caretaker-cli': minor
---

Give agents a working email capability — **send and read** — on top of the `email` service record.

`ServiceConfig` gains the outbound half of an account — `smtpHost`/`smtpPort`/`smtpSecure`/
`smtpFrom`, optional `smtpUser`/`smtpPassword` when the SMTP credentials differ from the IMAP
ones — plus the two glob allowlists `allowedSenders`/`allowedRecipients` and the `allowedAgents`
scope. `smtpPassword` is AES-256-GCM encrypted at rest by `saveConfig`, like `imapPassword`. Each
half is independently optional: an account can be send-only, read-only, or both, which
`email_list_accounts` reports.

Three new builtins let an agent list the configured accounts, pick one by name, send a plain-text
message (nodemailer) and read the oldest unread ones (imapflow + mailparser, HTML converted with the
already-present turndown): `mcp__email__email_list_accounts`, `mcp__email__email_send`,
`mcp__email__email_fetch`. Passwords are never returned by `email_list_accounts`.

Reading needs **no new configuration and no scheduler strategy**: an inbound workflow is a
`heartbeat` service whose prompt tells the agent to call `email_fetch`, and "already handled" is the
IMAP `\Seen` flag rather than a stored UID cursor. Two treatments of one mailbox are two heartbeats.

Three host-side boundaries, none of them the model's choice — and all three unrestricted when empty:
`allowedAgents` decides which agents may use an account at all (a scoped account is *invisible* to
the others: unlisted, and naming it reads as "unknown account"), `allowedRecipients` is checked on
every `to`/`cc`/`bcc` address before any connection is opened, and `allowedSenders` is checked on a
cheap ENVELOPE pass so mail the agent may not read is never downloaded — refused messages are
counted, reported, and left unread. Per-call ceilings (50 messages, 200 envelopes scanned, 8000
characters of body) live in the tool, and both network operations honour `ctx.signal` plus a
60 s timeout by closing the connection — the harness loop only checks the signal between turns, so
otherwise a Pause or a task's wall-clock budget could not interrupt a wedged IMAP/SMTP session. Sender filtering is deliberately host-side only: measured
against GreenMail, IMAP `SEARCH FROM` is not the substring match the spec implies and `OR` returns
nothing, so a server-side prefilter would silently drop everything on some servers.

The per-run bridge token now carries the agent id, because a claude-code agent speaks MCP over HTTP
and has no other way to identify itself — without it the per-agent scoping would be bypassed on
exactly the surface that matters most, the autonomous task run.

The tools reach every MCP surface the `mcp__task__*` tools already reach — the stdio
`caretaker-cli mcp` subcommand and the per-task HTTP bridge — because both are built from one
shared builder and one prefix filter (`buildTaskMcpServer` is renamed `buildBuiltinMcpServer`
accordingly). Native agents opt in with `mcp__email__*` in `allowedTools`; the hardcoded
`mcp__task__*` wildcard in `resolveAgentTools` is generalized to any `mcp__<ns>__*`. The planner
role cannot send mail on either path (native denylist + claude-code `disallowedTools`); reading is
read-only and stays available to it.

The Services settings form gains the SMTP fields, the two address allowlists and the per-agent
picker; CLAUDE.md and README are updated — the `email` service type is no longer inert
configuration.
