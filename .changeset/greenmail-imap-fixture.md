---
'@hyperwindmill/caretaker-cli': patch
---

chore: add `docker-compose.mail.yml`, a local IMAP server for exercising the **Email (IMAP)**
service type. One `greenmail/standalone` container publishing SMTP 3025 / IMAP 3143 / IMAPS 3993
on loopback, with authentication disabled so any user/password logs in and the mailbox is created
on first use. Mail is injected over SMTP and nothing is persisted, so `down` resets the fixture.
No runtime change — a development fixture only.
