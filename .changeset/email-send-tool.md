---
'@hyperwindmill/caretaker-cli': minor
---

Give agents an email **send** capability on top of the `email` service record.

`ServiceConfig` gains the outbound half of an account — `smtpHost`/`smtpPort`/`smtpSecure`/
`smtpFrom`, optional `smtpUser`/`smtpPassword` when the SMTP credentials differ from the IMAP
ones, and two glob allowlists `allowedSenders`/`allowedRecipients`. `smtpPassword` is AES-256-GCM
encrypted at rest by `saveConfig`, like `imapPassword`.

Two new builtins, `mcp__email__email_list_accounts` and `mcp__email__email_send` (nodemailer under
the hood), let an agent list the configured accounts, pick one by name, and send a plain-text
message. `allowedRecipients` is enforced on every `to`/`cc`/`bcc` address before any connection is
opened (empty = unrestricted); `allowedSenders` is stored for the future IMAP read tool and is not
enforced yet. Passwords are never returned by `email_list_accounts`.

The tools reach every MCP surface the `mcp__task__*` tools already reach — the stdio
`caretaker-cli mcp` subcommand and the per-task HTTP bridge — because both are built from one
shared builder and one prefix filter (`buildTaskMcpServer` is renamed `buildBuiltinMcpServer`
accordingly). Native agents opt in with `mcp__email__*` in `allowedTools`; the hardcoded
`mcp__task__*` wildcard in `resolveAgentTools` is generalized to any `mcp__<ns>__*`. The planner
role cannot send mail on either path (native denylist + claude-code `disallowedTools`).

The Services settings form gains the SMTP and allowlist fields; CLAUDE.md and README are updated —
the `email` service type is no longer inert configuration.
