---
"caretaker-cli": patch
---

ci: stop adding `[skip ci]` to changesets version commits (`skipCI: "add"` in `.changeset/config.json`). The marker on RELEASING commits prevented tag-push-triggered workflows (the release pipeline) from ever running when the tag pointed at the version commit; it now remains only on `changeset add` commits.
