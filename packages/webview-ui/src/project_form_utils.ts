/**
 * Form-level check for a project's repository URL. This is UX feedback only —
 * the server re-validates with the same rules in `lib/repo_url.ts`, which is
 * the authority (this one lives in a payload the client fully controls).
 *
 * Empty or an acceptable https URL → null; anything else → the message to show.
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
  if (parsed.username || parsed.password) {
    return 'Do not put credentials in the repository URL — they would be stored in .git/config and visible in the process list. Use the access token field instead.';
  }
  return null;
}
