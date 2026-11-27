---
"@hyperwindmill/caretaker-cli": patch
---

A plugin marketplace that lists a remote plugin (`"source": { "source": "url", … }`, valid in Claude Code marketplaces) no longer fails as a whole with `The "paths[1]" argument must be of type string`: the remote entry is skipped and the local plugins load (#2).
