---
'@hyperwindmill/caretaker-cli': patch
'caretaker-types': patch
---

Git plugin sources are now cached under `$CARETAKER_HOME/plugin-cache` instead of `~/.caretaker/plugin-cache`. With `CARETAKER_HOME` on a persistent volume (the `caretaker-web` container), the clones used to live in the container's own home and were lost on every recreate, so plugin MCP servers failed with "Connection closed" until a refresh succeeded. Nothing changes when `CARETAKER_HOME` is unset. When it is set, refresh each git source once (or rely on refresh-on-start) to re-clone into the new location. `PLUGIN_CACHE_DIR` still overrides.
