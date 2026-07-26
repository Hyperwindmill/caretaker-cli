// Pure helpers for the managed-backend block in the Voice tab (see
// docs/superpowers/specs/2026-07-26-voice-managed-backend-design.md, "UI"
// section). webview-ui has no dependency on the cli package (only on
// caretaker-types), so these two types mirror the contract exported by
// packages/cli/src/cli/web/voice_backend.ts by hand — same shape, same
// fields, kept in sync by hand.
export type BackendStatus = {
  /** Why the affordance may be unavailable, distinguished because the fixes differ. */
  docker: 'ok' | 'absent' | 'denied' | 'down';
  container: 'running' | 'stopped' | 'absent';
  imagePresent: boolean;
  /** Port parsed out of the endpoint, or null when it is not loopback. */
  port: number | null;
  /** True when /v1/models answers — running is not the same as ready. */
  responding: boolean;
};

export type StartProgress = {
  step: 'image' | 'run' | 'ready' | 'models' | 'done' | 'error';
  message: string;
  /** Present only on the terminal line ('done' | 'error'). */
  status?: BackendStatus;
};

/** One status line, driven by `status`. The three Docker failures are checked
 *  before container state on purpose — the remedies differ, and a generic
 *  "Docker unavailable" wastes the user's time. Wording matches the design
 *  spec verbatim. Callers only invoke this once the block is already visible
 *  (`docker !== 'absent' && port !== null`), so `absent` falls through to the
 *  same "stopped" line as any other non-running state — it is unreachable in
 *  practice, not a case worth its own message. */
export function backendStatusText(status: BackendStatus): string {
  if (status.docker === 'denied') return 'your user needs to be in the docker group';
  if (status.docker === 'down') return 'the Docker daemon is not running';
  if (status.container === 'running') return `Local backend: running on :${status.port}`;
  return 'Local backend: stopped';
}

/** Splits NDJSON as it streams in, tolerating a chunk boundary that lands
 *  mid-line: `TextDecoderStream`/`getReader()` delivers arbitrary byte
 *  boundaries, so a `\n` can arrive split across two `read()` calls. Feed the
 *  previous call's `remainder` back in as `buffer` on the next chunk. A
 *  trailing empty line (the stream ending on `\n`, the common case) is
 *  dropped rather than surfaced as a blank "line" for the caller to parse. */
export function splitNdjsonLines(
  buffer: string,
  chunk: string,
): { lines: string[]; remainder: string } {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.length > 0), remainder };
}
