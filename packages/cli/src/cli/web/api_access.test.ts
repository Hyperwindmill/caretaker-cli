import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, guardApiFetch, isApiPath, parsePort } from './api_access.js';

const app = async (req: Request) => new Response(`app:${new URL(req.url).pathname}`);
const guarded = guardApiFetch(app, async (t) => t === 'good');
const call = (path: string, auth?: string) =>
  guarded(new Request(`http://x${path}`, auth ? { headers: { authorization: auth } } : undefined));

test('bearerToken reads only a well-formed Bearer header', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer   abc '), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken('Bearer'), null);
  assert.equal(bearerToken('Bearer a b'), null);
  assert.equal(bearerToken(null), null);
});

test('a valid token reaches the app on a REST route', async () => {
  const res = await call('/api/projects', 'Bearer good');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'app:/api/projects');
});

test('a missing and a wrong token get the same 401', async () => {
  const missing = await call('/api/projects');
  const wrong = await call('/api/projects', 'Bearer bad');
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(await missing.text(), await wrong.text());
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
});

test('without a token every path answers 401, existing or not', async () => {
  for (const p of ['/', '/api/ws', '/api/access', '/nope']) assert.equal((await call(p)).status, 401);
});

test('with a token, non-REST paths and reserved routes are 404', async () => {
  for (const p of ['/', '/standalone.js', '/api/ws', '/api/mcp/task', '/api/access', '/api/access/tokens']) {
    assert.equal((await call(p, 'Bearer good')).status, 404, p);
  }
});

test('the API description is served without a token, to GET only', async () => {
  for (const p of ['/api/openapi.json', '/api/docs']) {
    assert.equal((await call(p)).status, 200, p);
    const post = await guarded(new Request(`http://x${p}`, { method: 'POST' }));
    assert.equal(post.status, 401, p);
  }
});

test('isApiPath keeps look-alike prefixes', () => {
  assert.equal(isApiPath('/api/tasks/demo-1/messages'), true);
  assert.equal(isApiPath('/api/accessories'), true);
  assert.equal(isApiPath('/api'), false);
  assert.equal(isApiPath('/apix/tasks'), false);
});

test('parsePort accepts integers in range, as number or string', () => {
  assert.equal(parsePort(8080), 8080);
  assert.equal(parsePort('8080'), 8080);
  for (const bad of [0, 65536, 1.5, '', 'abc', null, undefined]) assert.equal(parsePort(bad), null);
});
