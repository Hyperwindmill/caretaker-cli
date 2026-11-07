---
'@hyperwindmill/caretaker-cli': minor
'caretaker-types': minor
'webview-ui': minor
'caretaker-desktop': minor
---

Built-in local voice (Pocket TTS on ONNX, runtime and model downloaded from Settings → Voice), streaming playback for every synthesis engine, and a per-language pronunciation dictionary.

Listing voice models from the settings form no longer sends the stored API key to an endpoint typed but not yet saved: the stored key only goes to the host it was saved for.

Streamed speech waits for an adjustable playback buffer (Settings → Voice, default 500 ms) before starting and after a stall, instead of stuttering.
