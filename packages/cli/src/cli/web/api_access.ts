import type { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import {
  createApiToken,
  loadApiAccess,
  revokeApiToken,
  setApiPort,
  verifyApiToken,
} from '../../store/json.js';

/**
 * The authenticated API listener: a second port that serves the web server's
 * REST routes to clients outside the browser, every request carrying
 * `Authorization: Bearer <token>`.
 *
 * Authentication is decided by the port a request arrives on, never by where
 * it comes from: the main port stays as it always was (the GUI, the WebSocket,
 * no auth — loopback or behind an authenticating proxy), and this one always
 * asks for a token, loopback included. That is what keeps it correct behind a
 * reverse proxy or a Docker port mapping, where the peer address says nothing.
 */

type Fetch = (req: Request, ...rest: any[]) => Response | Promise<Response>;

export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1] : null;
}

/** REST routes only. Left on the main port: the GUI and its WebSocket, the
 *  task MCP bridge (its own per-run tokens), and token management itself — a
 *  token must not be able to mint or revoke tokens. */
export function isApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  return !['/api/ws', '/api/mcp', '/api/access'].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Wraps the app's fetch for the API port. The token is checked first, so an
 *  unauthenticated caller learns nothing about which paths exist. */
export function guardApiFetch(appFetch: Fetch, verify: (token: string) => Promise<boolean> = verifyApiToken): Fetch {
  return async (req, ...rest) => {
    const token = bearerToken(req.headers.get('authorization'));
    if (!token || !(await verify(token))) {
      // One answer for a missing and a wrong token.
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      });
    }
    if (!isApiPath(new URL(req.url).pathname)) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return appFetch(req, ...rest);
  };
}

export function parsePort(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export interface ApiListenerOptions {
  /** The main web port — the API listener refuses to share it. */
  webPort: number;
  host: string;
  /** `--api-port`: wins over the port saved in api.json. */
  portOverride?: number;
}

interface ListenerState {
  port: number;
  host: string;
  error?: string;
}

let server: ServerType | null = null;
let state: ListenerState | null = null;

const closeServer = () =>
  new Promise<void>((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    s.close(() => resolve());
    // Keep-alive connections would otherwise hold close() open.
    (s as any).closeAllConnections?.();
  });

/** (Re)starts the listener on the configured port, or stops it when none is
 *  set. Never throws: a port already in use is reported in the status, and the
 *  web server keeps running. */
export async function applyApiListener(app: Hono, opts: ApiListenerOptions): Promise<void> {
  await closeServer();
  state = null;
  const port = opts.portOverride ?? (await loadApiAccess()).port;
  if (!port) return;
  if (port === opts.webPort) {
    state = { port, host: opts.host, error: 'The API port must differ from the web port.' };
    console.error(`[api] ${state.error}`);
    return;
  }
  const current: ListenerState = { port, host: opts.host };
  state = current;
  await new Promise<void>((resolve) => {
    const s = serve({ fetch: guardApiFetch(app.fetch), port, hostname: opts.host }, () => {
      console.log(`🔑 Caretaker API (token required) at http://${opts.host}:${port}`);
      resolve();
    });
    s.on('error', (err: Error) => {
      current.error = err.message;
      if (server === s) server = null;
      console.error(`[api] listener on ${opts.host}:${port} failed: ${err.message}`);
      resolve();
    });
    server = s;
  });
}

/** Token management, on the main port only (see isApiPath). */
export function registerApiAccess(app: Hono, opts: ApiListenerOptions): void {
  const status = async () => {
    const access = await loadApiAccess();
    return {
      port: access.port ?? null,
      portOverride: opts.portOverride ?? null,
      listener: state,
      tokens: access.tokens.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    };
  };

  app.get('/api/access', async (c) => c.json(await status()));

  app.put('/api/access/port', async (c) => {
    const body = await c.req.json().catch(() => null);
    const raw = body?.port;
    const port = raw === null || raw === '' ? null : parsePort(raw);
    if (raw !== null && raw !== '' && port === null) {
      return c.json({ error: 'port must be an integer between 1 and 65535, or null to turn the API off.' }, 400);
    }
    if (port !== null && port === opts.webPort) {
      return c.json({ error: 'The API port must differ from the web port.' }, 400);
    }
    await setApiPort(port);
    await applyApiListener(app, opts);
    return c.json(await status());
  });

  app.post('/api/access/tokens', async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.slice(0, 80) : '';
    const { token } = await createApiToken(name);
    return c.json({ token, ...(await status()) });
  });

  app.delete('/api/access/tokens/:id', async (c) => {
    await revokeApiToken(c.req.param('id'));
    return c.json(await status());
  });
}
