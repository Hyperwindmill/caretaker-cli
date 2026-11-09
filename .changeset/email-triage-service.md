---
"@hyperwindmill/caretaker-cli": minor
---

Add the `email_triage` service: on a cron schedule it lists an email account's unread mail (honouring the allowed-senders list), has one agent classify it into IMPORTANT / INFORMATION / TRASH, emails the report to the configured recipients and only then marks the messages read, so a failed run is retried. Includes a read-only `mcp__email__email_read` tool (peek, never marks read), bridge tokens restricted to named tools, and an "Email triage" form in the Services tab.
