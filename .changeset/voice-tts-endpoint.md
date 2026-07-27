---
'@hyperwindmill/caretaker-cli': minor
'caretaker-types': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'webview-ui': minor
---

Add an optional separate synthesis endpoint (`ttsEndpoint` + `ttsApiKey`) to voice mode, so synthesis can be routed to a different host than transcription — e.g. a local openai-edge-tts container for Microsoft Neural voices while Speaches handles transcription. The transcription key is never sent to the synthesis host. The managed local backend is now parameterized over a target (`stt` / `tts`) with a two-entry spec table: `GET /api/voice/backend` returns `{ stt, tts }` and the start/stop/delete routes take `?target=stt|tts`. The voice catalogue fetcher now accepts `{"models": [...]}` (not just `{"data": [...]}`) and falls back to `/voices/all` when no TTS model carries its own voices, with voice ids read from the `"name"` key. The Voice settings tab now shows synthesis endpoint/key fields, an "Use Microsoft Edge voices" prefill button, and renders one managed-backend block per container.