# caretaker-app — Roadmap & state

> Checkpoint per riprendere in sessione successiva. Il subproject `app/` vive
> sul branch `feat/app-subproject-scaffold` (25 commit ahead di `main`).

---

## Stato

**Branch:** `feat/app-subproject-scaffold` · 158 test verdi · typecheck + build clean.

**Cosa fa oggi caretaker-app**

- Subproject isolato (proprio `package.json`, proprie deps, ESM, TypeScript).
- File store: `~/.caretaker/caretaker.json` (port + providers), `~/.caretaker/agents.json` (agents).
  Override path via env `CARETAKER_HOME`.
- Session store JSONL one-file-per-session a `~/.caretaker/sessions/<agentId>/<sessionId>.jsonl`
  (append-only, retitle via temp+rename atomico, list per mtime).
- Harness in-process per provider OpenAI-compatibili: streaming SSE, multi-turn replay,
  tool dispatch, abort, usage tracking, `safeEmit` per persistenza best-effort.
- Tool registry production-ready (sandbox + readPaths + dangerous flag) con:
  `read_file`, `write`, `edit`, `multiedit`, `glob`, `grep`, `fetch`, `bash`.
- TUI Ink: menu Agents/Providers/Quit, CRUD per provider/agent (con tool-picker
  multi-select, provider select, model auto-fetch da `/v1/models`), workingDir
  per-agent, chat persistente con resume + transcript, Esc back/abort, title
  generator post-primo-turn (con cleanup on unmount).
- Prelude system-prompt sempre attivo: identità CARE (Goal/Environment/Project
  con Boy Scout rule) + 4 convenzioni harness (function-calling, no JSON envelopes,
  fs sandbox, output caps).
- Context files loader: walk-up `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` + globals,
  caps 100 KB/file 250 KB total. `@<file>` refs nel system prompt risolti single-pass.
- maxTurns=0 → unlimited.

**Decisioni di design importanti** (per evitare di rivisitare):

- "Caretaker" name → quello che cresce in `app/` è il futuro caretaker (desktop).
  L'attuale repo principale rimarrà come "caretaker server" se servirà mantenerlo;
  per ora coesistono.
- Niente codice condiviso con caretaker server: si **porta** (manualmente),
  non si importa. Il path A (MCP adapter) resta una possibile evoluzione futura.
- Tool naming: flat (`read_file`, `bash`), non `mcp__*`.
- Sandbox attivo (assertWithinRoot, niente symlink-following = soft jail).
- Read-before-write guard solo su `write`. `edit`/`multiedit` si affidano al
  match di `oldString` come check implicito (server-faithful).
- `dangerous: true` sui tool → solo hint visivo nel picker; il gate vero
  è guidato da `AgentConfig.confirmTools` (scelta esplicita per agente).

---

## Backlog (ordinato per valore)

### ~~1. Confirm gate per tool sensibili~~ — DONE
Spedito in due commit: `feat(app): tri-state tool picker` + `feat(app):
runtime confirm gate for tool calls`. La scelta non si appoggia più al flag
`dangerous`: il picker dell'agente cicla `inactive → active → active+confirm`
e persiste `AgentConfig.confirmTools`. Il loop espone
`RunCallbacks.confirmTool`; il chat TUI mostra un prompt giallo
`Run once | Always (this session) | Reject` per ogni tool nel set, con set
in-memory mutato solo da "always". Una gate che lancia eccezione viene
trattata come reject (fail-safe). Esc durante il prompt rifiuta la singola
chiamata senza abortire il run.

### ~~2. Plugin / skill system~~ — DONE
Sistema plugin completo prod-ready, portato dal server (non condiviso, file
store invece di DB):
- `PluginSource` (git/path) + `PluginRecord` discovered, persistiti in
  `~/.caretaker/plugins.json` (chmod 0600, auth token cifrato AES-256-GCM)
- Fetcher git via `isomorphic-git` (shallow single-branch + cache per source
  in `~/.caretaker/plugin-cache/<uuid>`); fetcher path con guard absolute
- Manifest discovery: `cc-marketplace`, `cc-plugin`, `skill-glob` — stessa
  semantica del server (path-traversal guard, dedupe by name)
- Source manager: add/patch/delete/refresh con `inFlight` dedup, failure
  preserva i plugin del refresh precedente
- Skill loader: rende `<skill name="…">…</skill>` con header passive-context
  (cap 100 KB/file, skip silenzioso) — appended al system prompt dopo
  prelude + agent prompt, come il server
- AgentConfig.plugins persistito; picker multi-select nel form agente
- `refreshOnStart: true` per source → refresh background al boot della TUI
- 10 commit, 158 test verdi (54 nuovi sul subsistema plugin)

### 3. MCP adapter (Path A)  · stimato 4-6h
Aggiungere `@modelcontextprotocol/sdk` come dep, scrivere `harness/tools/mcp/adapter.ts`
con `mountMcpServer({name, url, secret})` che restituisce `Tool[]` adatti.
Permette di riusare gli MCP server del caretaker full (kb, youtrack, gitlab, task,
git, telegram, email, agent) senza riscrittura. Configurazione in `caretaker.json`
sotto `mcpServers: [{name, url, secret}]`.

### 4. Self-introspection tool  · stimato 2h
Port di `mcp__self__get_agent_context` dal server. Espone live token usage +
identity. Richiede `model_limits.ts` (mappa model → context window). Util per
"quanto contesto ho usato?".

### 5. Think tag splitter  · stimato 1h
Per modelli che emettono `<think>...</think>` nel content invece che in
`reasoning_content` (DeepSeek e simili). Server: [src/runner/think_tag_splitter.ts].
Solo se vuoi usare quei modelli.

### 6. Tool-emission `safeEmit` test  · stimato 30min
Gap noto dal code review: il test della containment esercita solo la persistenza
del messaggio assistant; non c'è prova di analoga containment sul path tool.
Aggiungere un test con tool call + onMessage che lancia su `role==="tool"`.

---

## Esplicitamente NON fare

- Tool integrazioni native: gitlab, youtrack, kb, telegram, email, task, agent
  (passano via MCP adapter quando arriva il path A).
- Runtime esterni Hermes/OpenClaw (sono CLI subprocess, fuori dal "in-process only").
- Server-side: DB, scheduler, OIDC, web UI.
- Repo separato per `app/` (per ora vive qui; estraibile via `git filter-repo`
  in qualsiasi momento — design già pulito).

---

## Open questions per la prossima sessione

- Le piste #1 (confirm gate) e #2 (plugin) sono entrambe "alto valore" ma diverse
  per natura. Confirm gate è un tassello di sicurezza completo in 1-2h. Plugin è
  più strutturale. Probabilmente confirm gate prima.
- Il sistema TUI ha pre-esistenze segnalate dal code review (es. `maxTurns` che
  resta in stato `(pending)` perché il form si chiude prima di passare alla
  visualizzazione "completed" — non un regression, ma se una volta vuoi pulire
  il form va sistemato).
- Il branch è 25 commit avanti su main. A un certo punto si decide: PR + merge,
  oppure rebase + squash, oppure semplicemente continuiamo a vivere sul branch.
  Nessuna fretta — è del tutto pulito e testato.

---

## Come riprendere

```bash
cd /mnt/a341655b-7af5-403e-a435-792e0e283f08/Dev/caretaker-agents-platform
git checkout feat/app-subproject-scaffold
cd app
npm test         # 89 verdi
npm run typecheck
```

Per sviluppare la TUI:
```bash
cd app && CARETAKER_HOME=/tmp/ct-test npm run dev
```

Per smoke-test con un agent reale:
```bash
cd app && CARETAKER_HOME=~/.caretaker npm run dev
# Agents → seleziona uno con allowedTools popolato → New chat → testa
```
