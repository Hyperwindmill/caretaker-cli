# caretaker (app)

Sottoprogetto sperimentale: in-process agent harness, TUI (Ink) + API HTTP, persistenza su file JSON.

Isolato dal resto del repo (proprio `package.json`, proprie deps). Estraibile a repo a sé in qualsiasi momento.

## Quick start

```bash
cd app
npm install
npm run dev
```

## Override path dati

```bash
CARETAKER_HOME=/path/to/dir npm run dev
```

## Scope (primo step)

- Harness in-process per provider OpenAI-compatibili
- Settings su `~/.caretaker/caretaker.json`, agenti su `~/.caretaker/agents.json`
- TUI con onboarding (crea primo agent al primo avvio)
- API HTTP (Hono) per integrazioni esterne

Niente DB, niente auth, niente multi-utente.
