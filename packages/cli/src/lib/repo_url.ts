/**
 * Authoritative validation for a project's `repositoryUrl`.
 *
 * The webview has its own copy of this rule for form feedback, but that one is
 * UX only — every write path into `caretaker.json` must call THIS one, because
 * the client can send any payload it likes over the settings websocket.
 *
 * Returns null when the value is acceptable (empty = unset), otherwise the
 * message to show the user.
 */
export function validateRepositoryUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith('git@') || u.startsWith('ssh://')) {
    return 'SSH remotes are not supported — use an https:// URL with an access token.';
  }
  if (!u.startsWith('https://')) return 'Repository URL must start with https://';

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return 'Repository URL is not a valid URL.';
  }
  if (!parsed.hostname) return 'Repository URL is not a valid URL.';
  // An https prefix alone does NOT keep the secret out of argv and
  // .git/config: `https://user:token@host/repo` puts it in both, which is
  // exactly what the credential-helper design exists to prevent.
  if (parsed.username || parsed.password) {
    return 'Do not put credentials in the repository URL — they would be stored in .git/config and visible in the process list. Use the access token field instead.';
  }
  return null;
}
