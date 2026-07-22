---
"@hyperwindmill/caretaker-cli": patch
---

feat(cli): add `-v` / `--version` flag

`caretaker-cli --version` and `caretaker-cli -v` now print the CLI version (read from
`package.json`) and exit cleanly, instead of erroring with "unknown option". The commander
program never registered a version flag; it now does, with lowercase `-v` (overriding
commander's default `-V`).