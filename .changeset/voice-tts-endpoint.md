---
'@hyperwindmill/caretaker-cli': minor
'caretaker-types': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'webview-ui': minor
---

Add an optional separate synthesis endpoint (`ttsEndpoint` + `ttsApiKey`) to voice mode, so synthesis can be routed to a different host than transcription — e.g. a local openai-edge-tts container for Microsoft Neural voices while Speaches handles transcription. The transcription key is never sent to the synthesis host.