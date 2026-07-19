---
"@hyperwindmill/caretaker-cli": patch
---

Move the pnpm dependency `overrides` (security version pins) from
`package.json`'s `pnpm` field to `pnpm-workspace.yaml`. pnpm 10+ no longer reads
settings from `package.json#pnpm` (it warned and ignored them); the pins now live
in their supported home. Resolution is unchanged — the lockfile already carried
the pins — this only silences the warning and future-proofs the config.
