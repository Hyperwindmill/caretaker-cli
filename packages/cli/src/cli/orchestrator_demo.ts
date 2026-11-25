import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bearerToken } from './web/api_access.js';
import { PROTOCOL_VERSION } from './web/orchestrator_core.js';

export interface DemoInstance {
  instanceId: string;
  name: string;
  version: string;
  lastSeenAt: string;
}

export interface DemoQueuedMessage {
  id: string;
  method: string;
  path: string;
  body?: unknown;
}

export interface DemoResult {
  id: string;
  status: number;
  body: unknown;
}

export interface DemoOrchestrator {
  app: Hono;
  enqueue(instanceId: string, msg: { method: string; path: string; body?: unknown }): string;
  results(instanceId: string): DemoResult[];
  instances(): DemoInstance[];
}

export function createDemoOrchestrator(opts: {
  token: string;
  name?: string;
  /** Called when a result is first recorded, before the poll response is built. */
  onResult?: (instanceId: string, result: DemoResult) => void;
}): DemoOrchestrator {
  const displayName = opts.name || 'Demo Orchestrator';
  const instancesMap = new Map<string, DemoInstance>();
  const queues = new Map<string, DemoQueuedMessage[]>();
  const resultsMap = new Map<string, Map<string, DemoResult>>();

  function enqueue(
    instanceId: string,
    msg: { method: string; path: string; body?: unknown },
  ): string {
    const id = randomUUID();
    const list = queues.get(instanceId) ?? [];
    list.push({
      id,
      method: msg.method,
      path: msg.path,
      ...(msg.body !== undefined ? { body: msg.body } : {}),
    });
    queues.set(instanceId, list);
    return id;
  }

  function results(instanceId: string): DemoResult[] {
    return Array.from(resultsMap.get(instanceId)?.values() ?? []);
  }

  function instances(): DemoInstance[] {
    return Array.from(instancesMap.values());
  }

  const app = new Hono();

  app.use('*', async (c, next) => {
    const tok = bearerToken(c.req.header('authorization'));
    if (!tok || tok !== opts.token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  app.get('/health', (c) => {
    return c.json({ ok: true, protocol: PROTOCOL_VERSION, name: displayName });
  });

  app.post('/register', async (c) => {
    const body = (await c.req.json()) as {
      instanceId?: string;
      name?: string;
      version?: string;
    };
    if (!body.instanceId || typeof body.instanceId !== 'string') {
      return c.json({ error: 'instanceId is required' }, 400);
    }
    instancesMap.set(body.instanceId, {
      instanceId: body.instanceId,
      name: typeof body.name === 'string' ? body.name : '',
      version: typeof body.version === 'string' ? body.version : '',
      lastSeenAt: new Date().toISOString(),
    });
    return c.json({ ok: true, name: displayName });
  });

  app.post('/poll', async (c) => {
    const body = (await c.req.json()) as {
      instanceId?: string;
      results?: { id: string; status: number; body?: unknown }[];
    };
    const instanceId = body.instanceId;
    if (!instanceId || !instancesMap.has(instanceId)) {
      return c.json({ error: 'Unknown instanceId' }, 409);
    }
    const inst = instancesMap.get(instanceId)!;
    inst.lastSeenAt = new Date().toISOString();

    let instResults = resultsMap.get(instanceId);
    if (!instResults) {
      instResults = new Map<string, DemoResult>();
      resultsMap.set(instanceId, instResults);
    }
    for (const r of body.results ?? []) {
      if (r && typeof r.id === 'string' && !instResults.has(r.id)) {
        const recorded = { id: r.id, status: r.status, body: r.body ?? null };
        instResults.set(r.id, recorded);
        opts.onResult?.(instanceId, recorded);
      }
    }

    const pending = (queues.get(instanceId) ?? []).filter((m) => !instResults!.has(m.id));
    queues.set(instanceId, pending);
    return c.json({ messages: pending });
  });

  app.get('/instances', (c) => {
    return c.json({ instances: instances() });
  });

  app.post('/instances/:id/messages', async (c) => {
    const body = (await c.req.json()) as { method: string; path: string; body?: unknown };
    const id = enqueue(c.req.param('id'), body);
    return c.json({ id });
  });

  app.get('/instances/:id/results', (c) => {
    return c.json({ results: results(c.req.param('id')) });
  });

  return { app, enqueue, results, instances };
}

export function startDemoOrchestrator(opts: {
  port: number;
  host: string;
  token: string;
  name?: string;
}): void {
  const demo = createDemoOrchestrator({ token: opts.token, name: opts.name });
  serve({
    fetch: demo.app.fetch,
    port: opts.port,
    hostname: opts.host,
  });
  const baseUrl = `http://${opts.host}:${opts.port}`;
  console.log(`Demo orchestrator listening on ${baseUrl}`);
  console.log(
    `Enqueue a message: curl -X POST ${baseUrl}/instances/<instanceId>/messages -H "Authorization: Bearer ${opts.token}" -H "Content-Type: application/json" -d '{"method":"GET","path":"/api/projects"}'`,
  );
}
