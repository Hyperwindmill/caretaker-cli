---
'@hyperwindmill/caretaker-cli': minor
---

Rename the **Scheduler** settings surface to **Services** and add an **Email (IMAP)**
service type. `ScheduledTaskConfig` is renamed to `ServiceConfig` (old name kept as a
deprecated alias) and widened with `imapHost`/`imapPort`/`imapUser`/`imapPassword`/`imapSecure`.
The `caretaker.json` key stays `scheduler.tasks`, so existing configs load unchanged.
`imapPassword` is AES-256-GCM encrypted at rest by `saveConfig`, same as `telegramBotToken`.
The webview settings tab is renamed from Scheduler to Services (`ServicesTab`, tab id `services`).
The Services form now supports creating/editing an `email` service (IMAP host/port/user/password/TLS),
with its own validation and list-card rendering; it requires no agent and is never ticked by the scheduler.
