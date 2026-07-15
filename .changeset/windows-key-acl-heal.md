---
"caretaker-cli": patch
---

Heal Windows installs whose encryption key predates the owner-only ACL: the
ACL is now re-applied once per process when an existing key is loaded, so
keys created before the previous release get locked down on next launch
without regenerating the key (which would orphan all existing ciphertext).
