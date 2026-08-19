/**
 * Authoritative validation for project ids (slugs).
 *
 * Same contract as validateRepositoryUrl (lib/repo_url.ts): the webview may
 * keep a copy of the regex for form feedback, but every write path into
 * caretaker.json — POST /api/projects, the web server's saveConfig websocket
 * handler, and the VSCode sidebar's saveConfig handler — must call THIS one,
 * because clients can send any payload.
 *
 * The slug is embedded verbatim in docker container/image names, git ref
 * names, and filesystem paths under ~/.caretaker/ (a trust boundary: the
 * charset is what makes `..` and `/` unrepresentable). It must start AND end
 * alphanumeric — the docker image reference grammar
 * `[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*` rejects a component ending in a hyphen,
 * so `foo-` would make `caretaker-project-foo-:latest` an invalid reference.
 *
 * Slugs are immutable after creation by construction: the two forms never
 * change the id of an existing project and POST /api/projects only creates.
 * A changed id arriving via saveConfig is indistinguishable from a
 * delete+create, so it cannot be rejected here; the web handler additionally
 * refuses to drop a project that still has tasks (Task 4).
 */
export const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export function validateProjectSlug(id: string): string | null {
  if (!PROJECT_SLUG_RE.test(id)) {
    return 'Project id must be 1-39 characters of a-z, 0-9 and hyphens, starting and ending with a letter or digit.';
  }
  return null;
}

export function validateProjectIds(incoming: Array<{ id: string; name: string }>): string | null {
  const seen = new Set<string>();
  for (const p of incoming) {
    const err = validateProjectSlug(String(p.id));
    if (err) return `Project "${p.name}": ${err}`;
    if (seen.has(p.id)) return `Duplicate project id "${p.id}".`;
    seen.add(p.id);
  }
  return null;
}
