---
"caretaker-cli": patch
---

Protect the on-disk encryption key on Windows with an explicit owner-only ACL
(`icacls`). `chmod 0600` only toggles the read-only bit on Windows and leaves
the key readable via inherited ACLs, so the key is now locked to the current
user at creation time — the Windows equivalent of the POSIX 0600 already
applied elsewhere.
