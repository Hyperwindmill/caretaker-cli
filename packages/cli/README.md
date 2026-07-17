# caretaker-cli

Caretaker — an in-process AI agent harness with a TUI, a local web GUI, headless runs, and a scheduler. Bring your own OpenAI-compatible key (or use a `claude-code` provider). File-based state under `~/.caretaker/`, no database.

## Install

```bash
npm install -g @hyperwindmill/caretaker-cli
```

## Usage

```bash
caretaker-cli                 # launch the TUI
caretaker-cli web             # local web GUI on http://127.0.0.1:3000
caretaker-cli run "…" --agent <name>   # headless run
```

State (providers, agents, sessions, plugins, MCP, scheduler) lives under `~/.caretaker/` (override with `CARETAKER_HOME`).

## License

[FSL-1.1-MIT](./LICENSE) — Functional Source License, converts to MIT.

Source, issues, and full docs: <https://github.com/Hyperwindmill/caretaker-cli>
