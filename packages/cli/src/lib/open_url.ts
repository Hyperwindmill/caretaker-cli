import { spawn } from 'node:child_process';

// ponytail: 3 OS branches, that's the whole feature.
export function openCommandFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** Open a URL in the user's default browser. Fire-and-forget: a missing
 *  opener must not crash the flow — the URL is still surfaced to the user by
 *  the caller. */
export function openUrl(url: string): void {
  const { cmd, args } = openCommandFor(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore
  }
}
