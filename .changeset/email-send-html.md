---
'@hyperwindmill/caretaker-cli': minor
---

feat(cli): `mcp__email__email_send` accepts an optional `html` body

`body` stays required as the plain-text part (the fallback clients without HTML
rendering show, and the part whose absence spam filters penalise); when `html` is
also given, nodemailer sends both as a `multipart/alternative`. Attachments are
still out of scope.
