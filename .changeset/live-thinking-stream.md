---
"caretaker-cli": patch
"caretaker-vscode": patch
"webview-ui": patch
---

Fix: model "thinking"/reasoning blocks now appear live during streaming, not only after reloading a past conversation. The harness loop already emitted `onThinking` and persisted the parts, but the surfaces (web server, VSCode sidebar) never forwarded the event and the bridge contract had no `thinking` message, so live turns silently dropped it. Added a `thinking` event to the `HostToView` contract and wired it through both surfaces and the webview reducer.
