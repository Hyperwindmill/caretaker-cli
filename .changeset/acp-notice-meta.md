---
"@hyperwindmill/caretaker-cli": patch
---

ACP runner: claude-agent-acp harness notices are now detected via the upstream `_meta.claudeCode.kind === 'informational'` marker (claude-agent-acp#1042, landed in PR #1055) — including `info`-level chunks that carry no visible text prefix. The `**Notice:**` whole-chunk prefix heuristic remains as fallback for older pinned adapter versions.
