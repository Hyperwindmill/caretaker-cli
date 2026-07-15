---
"webview-ui": patch
"caretaker-vscode": patch
---

Replace emoji icons with lucide-react across the whole webview UI (chat surface + all settings/scheduler/projects tabs). Icons are SVG that inherit `currentColor`, so they follow the theme (light/dark) and render consistently across platforms — unlike the previous OS-dependent emoji. Icon choices are centralized in a single `icons.ts` module. Also removed the now-unused `@vscode/codicons` dependency from the VSCode extension (it was a dead CSS import; the extension renders the shared webview UI), so the whole product uses one icon system. Icon-button colors were adjusted so the new SVG glyphs stay legible on dark cards.
