---
"@hyperwindmill/caretaker-cli": minor
"caretaker-desktop": minor
"caretaker-vscode": minor
"webview-ui": minor
"caretaker-types": minor
---

Add voice mode (dictation and hands-free conversation) using OpenAI-compatible speech services.
The Voice settings tab can read the endpoint's installed models to turn the model and voice
fields into pick-lists, including each synthesis model's own voices labelled by language, and a
speaking-rate multiplier for voices that read too slowly.
`docker-compose.voice.yml` starts a local Speaches backend so nothing leaves your machine.
