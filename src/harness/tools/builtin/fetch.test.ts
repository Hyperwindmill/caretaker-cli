import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fetchTool } from './fetch.js';

function ctx() {
  return {
    signal: new AbortController().signal,
    workingDir: tmpdir(),
    readPaths: new Set<string>(),
  };
}

interface RouteHandler {
  (req: IncomingMessage, res: ServerResponse): void;
}

async function withServer<T>(
  handler: RouteHandler,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('fetch: text format returns the body as-is', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
    },
    async (baseUrl) => {
      const out = await fetchTool.execute({ url: `${baseUrl}/`, format: 'text' }, ctx());
      assert.equal(out.content, 'hello world');
    },
  );
});

test('fetch: json format pretty-prints valid JSON', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1,"b":2}');
    },
    async (baseUrl) => {
      const out = await fetchTool.execute({ url: `${baseUrl}/`, format: 'json' }, ctx());
      assert.equal(out.content, '{\n  "a": 1,\n  "b": 2\n}');
    },
  );
});

test('fetch: json format on non-JSON returns error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
    },
    async (baseUrl) => {
      const out = await fetchTool.execute({ url: `${baseUrl}/`, format: 'json' }, ctx());
      assert.match(out.content, /not valid JSON/);
    },
  );
});

test('fetch: markdown format converts simple HTML', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Title</h1><p>body</p>');
    },
    async (baseUrl) => {
      const out = await fetchTool.execute({ url: `${baseUrl}/`, format: 'markdown' }, ctx());
      // Turndown's default uses setext-style ("Title\n=====") rather than
      // ATX ("# Title"). Accept either.
      assert.match(out.content, /Title(\n=+|^|\s)/m);
      assert.match(out.content, /body/);
    },
  );
});

test('fetch: invalid url is rejected', async () => {
  const out = await fetchTool.execute({ url: 'not-a-url' }, ctx());
  assert.match(out.content, /Error: invalid URL/);
});

test('fetch: non-http scheme is rejected', async () => {
  const out = await fetchTool.execute({ url: 'ftp://example.com/file' }, ctx());
  assert.match(out.content, /unsupported scheme/);
});

test('fetch: external abort cancels the request', async () => {
  await withServer(
    (_req, res) => {
      // Delay long enough for abort to fire.
      setTimeout(() => res.end('late'), 5000);
    },
    async (baseUrl) => {
      const ac = new AbortController();
      const c = { ...ctx(), signal: ac.signal };
      const p = fetchTool.execute({ url: `${baseUrl}/`, format: 'text' }, c);
      setTimeout(() => ac.abort(), 50);
      const out = await p;
      assert.match(out.content, /Error: fetch failed/);
    },
  );
});
