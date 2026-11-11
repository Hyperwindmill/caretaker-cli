---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
---

API access for other programs: the web server can serve its REST routes on a second port that requires an `Authorization: Bearer <token>` header on every request. Set the port and create or revoke tokens in Settings → API (or pass `--api-port` / `--api-host` to `caretaker-cli web`). The main port is unchanged.
