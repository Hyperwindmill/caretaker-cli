---
"caretaker-desktop": patch
---

fix(desktop): packaged app opened on a white page because the backend crashed on startup with `Cannot find module 'es-object-atoms'`. electron-builder 26.8.1's pnpm node-modules collector dropped 13 transitive leaf dependencies (`es-object-atoms`, `mime-db`, `setprototypeof`, `unpipe`, and others in the Hono HTTP chain) from the asar, so the forked `caretaker-cli web` process died before binding its port and the BrowserWindow loaded a connection-refused page. Upgrading electron-builder to 26.15.6 fixes the collector; verified by unpacking the asar (13 missing → 0 runtime-relevant) and booting the packaged exe end-to-end (HTTP 200 from the embedded server).
