---
'@hyperwindmill/caretaker-cli': minor
---

Rename the **Scheduler** settings surface to **Services** and add an **Email (IMAP)**
service type. `ScheduledTaskConfig` is renamed to `ServiceConfig` (old name kept as a
deprecated alias) and widened with `imapHost`/`imapPort`/`imapUser`/`imapPassword`/`imapSecure`.
The `caretaker.json` key stays `scheduler.tasks`, so existing configs load unchanged.
