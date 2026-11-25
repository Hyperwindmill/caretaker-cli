/**
 * What the plugin-source form sends as `authToken` on save.
 *
 * The edit form never shows the stored token (it is encrypted at rest), so an
 * empty field while editing means "keep the current token" — `undefined`
 * leaves it untouched in patchSource, like the TUI. On create, an empty field
 * means no token.
 */
export function authTokenForSave(isEditing: boolean, typed: string): string | null | undefined {
  const trimmed = typed.trim();
  if (trimmed) return trimmed;
  return isEditing ? undefined : null;
}
