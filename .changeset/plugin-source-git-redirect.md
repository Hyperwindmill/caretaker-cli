---
"@hyperwindmill/caretaker-cli": patch
---

A git plugin source whose URL lacks the `.git` suffix no longer fails with `422 Unprocessable Entity` on GitLab (#2): the redirect the server sends for the repository is applied to the whole sync, within the same host only.
