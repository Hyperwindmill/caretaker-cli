---
"@hyperwindmill/caretaker-cli": patch
---

Fix task Docker containers dying mid-bootstrap when the image defines its own
`ENTRYPOINT`. The keep-alive is now passed as `--entrypoint sleep` (arg
`infinity`) instead of as the container CMD: a CMD only overrides the image's
CMD, so a product runtime image whose entrypoint boots services (apache,
supervisord, sshd, …) and never `exec "$@"`s would swallow the `sleep infinity`,
run its service stack — which fails to setuid to root under `--user` and exits
non-zero — and let the container die, killing every in-flight `docker exec`
(bootstrap, the agent) with it. Overriding the entrypoint makes PID 1 be
`sleep infinity` regardless of the image, so caretaker can use any runtime image
as an isolated `docker exec` shell target. Fixes bootstrap commands aborting
with a truncated, error-less output (e.g. `composer install` cut off partway).
