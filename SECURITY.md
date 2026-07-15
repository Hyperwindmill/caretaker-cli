# Security Policy

Caretaker is a bring-your-own-key, multi-surface AI agent harness. It runs
agents that you configure, with the tools, plugins, and MCP servers you
enable, using API keys you supply, entirely on your own machine. This document
explains how to report a vulnerability and — just as importantly — what the
project does and does not defend against, so you can operate it safely.

## Reporting a Vulnerability

Please report security issues **privately**. Do not open a public GitHub issue
for a vulnerability — public disclosure before a fix is available puts other
users at risk.

Two private channels are available:

- **GitHub Security Advisories** (preferred):
  <https://github.com/Hyperwindmill/caretaker-cli/security/advisories/new>
- **Email**: hyperwindmill@gmail.com

Please include enough detail to reproduce the issue: affected version, surface
(TUI, web server, VSCode sidebar, or headless `run`), configuration, and a
minimal set of steps or a proof of concept.

This is a small personal project, so acknowledgement is **best-effort**. We aim
to confirm receipt within a few days and will keep you updated as we
investigate. We appreciate coordinated disclosure and will credit reporters who
want it once a fix ships.

## Supported Versions

Only the **latest released version** receives security fixes. Releases are
managed with Changesets; the current supported line is **0.3.x**. There are no
backports to older lines — if you are behind, upgrading to the newest release is
the fix.

## Security Model & Non-Goals

Caretaker is a tool for running agents you trust, on your behalf, on your own
hardware. Its protections are designed to prevent everyday accidents, not to
contain an adversary. Understanding that distinction is essential to using it
safely.

### Agents run with your privileges

Agents execute tools — shell (`bash`), filesystem reads and writes, network
`fetch`, MCP server calls — as the **same operating-system user that launched
Caretaker**, with that user's full privileges. There is no OS-level
sandbox, container, or privilege drop. An agent can do anything you can do at a
terminal.

Because of this, **you are responsible for which tools, plugins, and MCP
servers you enable for each agent**. New agents start with zero tools and you
opt in one at a time; plugins are pulled from git repositories or local paths
that you add. Treat a plugin or MCP server the way you would treat any code you
are about to run on your machine: only enable sources you trust, and give each
agent the narrowest toolset it needs.

### The filesystem sandbox is a soft jail, not a boundary

The filesystem tools (`harness/tools/sandbox.ts`) reject paths outside the
agent's working directory and refuse to follow symlinks out of it, and `write`
enforces read-before-write. This is a **convenience guardrail** that stops the
boring, common accidents — an agent wandering into your home directory or
clobbering an unrelated file. It is **not** an adversarial security boundary.
It does not constrain the `bash` tool, which can reach anywhere your user
account can, and it should not be relied on to contain untrusted or actively
hostile input.

### The confirm gate is a guardrail, not a sandbox

Tools can be set to `[!]` (confirm-each-call), which prompts you before every
invocation with _Run once_, _Always (this session)_, or _Reject_. This puts a
human in the loop for sensitive actions, and "Always" resets on restart. It is a
**deliberate speed bump**, not a containment mechanism — it depends on you
reading each prompt and deciding correctly. Unattended runs (the scheduler's
heartbeat strategy) auto-approve all tool calls by design, so the confirm gate
provides no protection there.

### Secrets at rest

Secrets are encrypted at rest with **AES-256-GCM** (`lib/encryption.ts`). This
covers plugin-source auth tokens, MCP server credentials, and scheduler Telegram
bot tokens. The encryption key is stored on disk in a file with mode `0600`
(owner read/write only). Note the implication: the key lives next to the data it
protects, so this defends against casual disclosure (a config file pasted into a
chat, a backup skimmed for tokens) — **not** against an attacker who already has
read access to your user account, who can read both the key and the ciphertext.
Your provider API key(s) and other agent configuration are stored as plain JSON
under `~/.caretaker/`; protect that directory with normal filesystem
permissions.

### The Telegram scheduler's only access boundary is the chat whitelist

The web server's Telegram scheduler strategy polls for incoming messages and
routes them to an agent as an interactive conversation. Its **only** access
control is the optional **Allowed Chat IDs** whitelist. Without it configured,
**anyone who knows or obtains the bot token can drive every tool the agent has
enabled** — including `bash` and filesystem writes — with your privileges. If
you use the Telegram strategy, set the whitelist, and treat the bot token as a
high-value secret. The scheduler itself only runs while the `caretaker-cli web`
process is up.

### Out of scope

The following are explicitly **not** goals of the current design:

- Containing malicious agents, prompts, plugins, or MCP servers.
- Protecting data from an attacker who already has access to your OS user
  account or the `~/.caretaker/` directory.
- Isolating tool execution from the host (no OS sandbox, container, or
  privilege separation).
- Auditing or vetting third-party plugins and MCP servers you choose to add.
- Network exposure hardening — the web server binds locally and is intended for
  loopback use; do not expose it to untrusted networks.

If you need adversarial isolation, run Caretaker inside a VM or container that
you control, as an unprivileged user, with only the tools and network access
that agent actually requires.
