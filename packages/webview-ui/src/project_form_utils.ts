/** Empty or a valid https URL → null; anything else → the error message to show. */
export function validateRepositoryUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith('git@') || u.startsWith('ssh://')) {
    return 'SSH remotes are not supported — use an https:// URL with an access token.';
  }
  if (!u.startsWith('https://')) return 'Repository URL must start with https://';
  return null;
}
