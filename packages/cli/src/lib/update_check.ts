// Update notice: is a newer Caretaker release published? See
// docs/superpowers/specs/2026-11-25-update-notice-design.md.
// Never throws, never logs: a failed check is simply "no notice".

const RELEASES_URL = 'https://api.github.com/repos/Hyperwindmill/caretaker-cli/releases/latest';
const FETCH_TIMEOUT_MS = 5_000;
const SUCCESS_TTL_MS = 6 * 3600_000;
const FAILURE_TTL_MS = 15 * 60_000;

/** `X.Y.Z` with an optional leading `v`; anything else (pre-releases included) → null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface LatestRelease {
  /** Without the leading `v`. */
  version: string;
  url: string;
}

let cache: { at: number; value: LatestRelease | null } | null = null;

export function __resetUpdateCacheForTests(): void {
  cache = null;
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<LatestRelease | null> {
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'caretaker-cli' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null;
    const parsed = parseVersion(body.tag_name);
    return parsed ? { version: parsed.join('.'), url: body.html_url } : null;
  } catch {
    return null;
  }
}

/** Latest published release (drafts and pre-releases are invisible to the
 *  endpoint). Cached in-process: 6 h on success, 15 min on failure. */
export async function getLatestRelease(
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<LatestRelease | null> {
  const now = (opts.now ?? Date.now)();
  if (cache) {
    const ttl = cache.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (now - cache.at <= ttl) return cache.value;
  }
  const value = await fetchLatestRelease(opts.fetchImpl ?? fetch);
  cache = { at: now, value };
  return value;
}
