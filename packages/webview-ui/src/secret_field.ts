/**
 * What a settings form sends for a stored secret on save.
 *
 * A form never shows a stored secret (it is encrypted at rest), so while
 * editing an empty field means "keep the current one" (`undefined`), and
 * removing it is the explicit `remove` control (`null`). A typed value always
 * wins. On create, an empty field means no secret.
 */
export function secretForSave(
  isEditing: boolean,
  typed: string,
  remove = false,
): string | null | undefined {
  const trimmed = typed.trim();
  if (trimmed) return trimmed;
  return isEditing && !remove ? undefined : null;
}
