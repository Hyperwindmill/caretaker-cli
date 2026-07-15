// Ephemeral loopback listener that captures the OAuth authorization-code
// redirect. Binds 127.0.0.1 on an OS-assigned free port; the caller uses
// `redirectUrl` as the OAuth redirect_uri and awaits `waitForCode()`.

import { createServer, type Server } from 'node:http';

export interface CallbackListener {
  redirectUrl: string;
  waitForCode(): Promise<string>;
  close(): void;
}

export async function startCallbackListener(
  opts?: { timeoutMs?: number },
): Promise<CallbackListener> {
  const timeoutMs = opts?.timeoutMs ?? 300_000;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html' });
    if (error) {
      res.end('<html><body>Authorization failed. You can close this tab.</body></html>');
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
    } else if (code) {
      res.end('<html><body>Authorization complete. You can close this tab.</body></html>');
      resolveCode(code);
    } else {
      res.end('<html><body>Missing code. You can close this tab.</body></html>');
      rejectCode(new Error('OAuth callback missing "code"'));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind loopback listener');
  const redirectUrl = `http://127.0.0.1:${addr.port}/callback`;

  let timer: NodeJS.Timeout | undefined;
  const waitForCode = () => {
    timer = setTimeout(() => rejectCode(new Error('OAuth flow timed out')), timeoutMs);
    return codePromise.finally(() => timer && clearTimeout(timer));
  };

  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };

  return { redirectUrl, waitForCode, close };
}
