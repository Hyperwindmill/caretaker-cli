// Pure logic for the update banner. The shapes mirror packages/cli/src/cli/web/update_routes.ts
// (webview-ui does not import cli internals) — keep them in sync.

export interface UpdateStatus {
  current: string;
  latest?: string;
  url?: string;
  appOutdated: boolean;
  cliVersion?: string;
  cliOutdated: boolean;
  dismissedVersion?: string;
}

export interface CliUpdateResult {
  ok: boolean;
  output: string;
  cliVersion?: string;
  cliOutdated: boolean;
}

export const UPDATE_COMMAND = 'npm i -g @hyperwindmill/caretaker-cli@latest';

export function shouldShowBanner(s: UpdateStatus | null): boolean {
  return !!s?.latest && (s.appOutdated || s.cliOutdated) && s.dismissedVersion !== s.latest;
}

export function cliUpdateMessage(r: CliUpdateResult): { kind: 'done' | 'failed' | 'stale'; text: string } {
  if (!r.ok) return { kind: 'failed', text: 'Update failed. Run the command yourself (it may need admin rights):' };
  if (r.cliOutdated) {
    return {
      kind: 'stale',
      text: `npm finished, but the caretaker-cli on your PATH is still ${r.cliVersion ?? 'unknown'} (installed another way?).`,
    };
  }
  return { kind: 'done', text: 'CLI updated — restart open caretaker-cli sessions to use it.' };
}
