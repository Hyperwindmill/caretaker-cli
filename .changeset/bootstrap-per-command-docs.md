---
"webview-ui": patch
---

Clarify that `bootstrapCommands` is a list of independent shell invocations, not
a single script. Each entry runs as its own shell (`docker exec … sh -lc` under
Docker, otherwise `/bin/sh -c`) with the working dir fixed, so a `cd` in one
entry does not carry to the next — dependent steps must be chained inside a
single entry with `&&`. Documented the footgun in the project settings form
legend, `README.md`, and `CLAUDE.md`. No behavior change.
