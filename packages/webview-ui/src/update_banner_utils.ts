// Pure logic for the update banner. The shapes mirror packages/cli/src/cli/web/update_routes.ts
// (webview-ui does not import cli internals) — keep them in sync.

export interface UpdateStatus {
  current: string;
  latest?: string;
  url?: string;
  appOutdated: boolean;
  cliVersion?: string;
  cliOutdated: boolean;
  /** npm or pnpm command, matching whatever installed the CLI on PATH. */
  cliCommand?: string;
  dismissedVersion?: string;
}

export interface CliUpdateResult {
  ok: boolean;
  output: string;
  cliVersion?: string;
  cliOutdated: boolean;
  cliCommand?: string;
}

const NPM_UPDATE_COMMAND = 'npm i -g @hyperwindmill/caretaker-cli@latest';

export function cliCommandFor(s: UpdateStatus): string {
  return s.cliCommand ?? NPM_UPDATE_COMMAND;
}

export function shouldShowBanner(s: UpdateStatus | null): boolean {
  return !!s?.latest && (s.appOutdated || s.cliOutdated) && s.dismissedVersion !== s.latest;
}

export function cliUpdateMessage(r: CliUpdateResult): { kind: 'done' | 'failed' | 'stale'; text: string } {
  if (!r.ok) return { kind: 'failed', text: 'Update failed. Run the command yourself (it may need admin rights):' };
  if (r.cliOutdated) {
    return {
      kind: 'stale',
      text: `The update finished, but the caretaker-cli on your PATH is still ${r.cliVersion ?? 'unknown'} (installed another way?).`,
    };
  }
  return { kind: 'done', text: 'CLI updated — restart open caretaker-cli sessions to use it.' };
}

/** Visible while there is something to update, and after a CLI update ran —
 *  so its result ("restart open sessions") is shown even when that update
 *  left nothing behind any more. */
export function bannerVisible(s: UpdateStatus | null, r: CliUpdateResult | null): boolean {
  return !!s && (shouldShowBanner(s) || r !== null);
}

export function bannerHeadline(s: UpdateStatus): string {
  if (s.appOutdated) return `⬆ Caretaker ${s.latest} is available — you have ${s.current}`;
  return `⬆ Your terminal caretaker-cli is ${s.cliVersion} — Caretaker ${s.latest} is available`;
}
