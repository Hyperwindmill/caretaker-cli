/**
 * Partition a chat-item stream into render groups for compact mode.
 *
 * `.messages` is `display: flex; flex-direction: column`, so every direct child
 * occupies its own row. A content-width tool bubble is therefore still alone on
 * its line. To make consecutive tool calls flow inline (and wrap when they
 * don't fit), runs of consecutive `tool` items are collected into a single
 * `tool-row` group that renders as one inline-wrapping flex container; every
 * other item stays a standalone `single` group.
 *
 * Groups are keyed by the index of their first item, which is stable for an
 * append-only stream (the task log polls every few seconds and only ever
 * appends), so existing React component instances persist across polls.
 *
 * Generic over `T` (constrained to `{ kind: string }`) so the helper has no
 * runtime dependency on the `ChatItem` union — it only reads the discriminator.
 */
export type CompactGroup<T extends { kind: string }> =
  | { kind: 'single'; key: number; item: T }
  | { kind: 'tool-row'; key: number; items: T[] };

export function groupCompactItems<T extends { kind: string }>(items: T[]): CompactGroup<T>[] {
  const groups: CompactGroup<T>[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === 'tool') {
      const start = i;
      const run: T[] = [];
      while (i < items.length && items[i]!.kind === 'tool') {
        run.push(items[i]!);
        i++;
      }
      groups.push({ kind: 'tool-row', key: start, items: run });
    } else {
      groups.push({ kind: 'single', key: i, item });
      i++;
    }
  }
  return groups;
}