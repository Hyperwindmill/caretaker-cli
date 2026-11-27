// Message timestamps in the chat and task thread: the time shown on hover next
// to a bubble's role, and the day separators between messages of different
// days. Pure TypeScript; `locale` is only passed by tests (undefined = browser).

function parse(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `14:32` — empty when the timestamp is missing or malformed. */
export function shortTime(iso: string | undefined, locale?: string): string {
  const d = parse(iso);
  return d ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';
}

/** Full date and time, for the hover tooltip. */
export function fullDateTime(iso: string | undefined, locale?: string): string {
  const d = parse(iso);
  return d ? d.toLocaleString(locale) : '';
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" / "Yesterday" (localized), else a short date, with the year only when
 *  it is not the current one. Calendar days in local time. */
export function dayLabel(d: Date, now: Date, locale?: string): string {
  // Math.round: a DST day is 23 or 25 hours long.
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (diff === 0 || diff === 1) {
    const s = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-diff, 'day');
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  }
  return d.toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** For each entry, the separator label to render before it, or null. A label
 *  appears at the first dated entry and wherever the calendar day changes;
 *  undated entries (streamed tool calls, legacy rows) never start a new day. */
export function daySeparators(dates: (string | undefined)[], now: Date, locale?: string): (string | null)[] {
  let last: number | null = null;
  return dates.map((iso) => {
    const d = parse(iso);
    if (!d) return null;
    const day = dayStart(d);
    if (day === last) return null;
    last = day;
    return dayLabel(d, now, locale);
  });
}
