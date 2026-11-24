/**
 * Keeps any project present on disk and absent from an incoming settings save,
 * appended after the incoming list so incoming edits win.
 */
export function keepMissingProjects<T extends { id: string }>(onDisk: T[], incoming: T[]): T[] {
  const incomingIds = new Set(incoming.map((p) => p.id));
  const missing = onDisk.filter((p) => !incomingIds.has(p.id));
  return [...incoming, ...missing];
}
