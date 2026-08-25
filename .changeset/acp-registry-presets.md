---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

ACP agent census: the provider form (relabeled "External agent (ACP)") offers presets from the official ACP Agent Registry instead of hand-typed commands — npx/uvx agents prefill directly, binary-distributed agents (Google Antigravity, Cursor, goose, …) are downloaded, checksum-verified and installed under ~/.caretaker/acp/ by caretaker. New agent-level `acpMode` pins an ACP agent to one of its own permission modes (session/set_mode) so interactive chats can run auto-approved at the source.
- Provider-type label everywhere: "External agent (ACP)".
