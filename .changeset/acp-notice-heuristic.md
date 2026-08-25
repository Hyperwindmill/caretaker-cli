---
"@hyperwindmill/caretaker-cli": patch
---

ACP runner: claude-agent-acp harness notices (hook output emitted as `**Notice:** …` agent text) are demoted to the thinking channel instead of polluting the persisted/spoken reply — whole-chunk heuristic, temporary until claude-agent-acp#1042 provides a `_meta` marker.
