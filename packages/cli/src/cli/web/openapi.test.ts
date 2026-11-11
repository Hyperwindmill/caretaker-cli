import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openApiDocument } from './openapi.js';

const doc = openApiDocument('1.2.3') as any;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = Object.entries(doc.paths).flatMap(([path, item]: [string, any]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m] })),
);

// The document is hand-written: this is what keeps it from naming a route the
// server does not have. server.ts registers its routes inline, so the check
// reads the source rather than booting a server.
test('every documented operation is a route registered in server.ts', () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  assert.ok(operations.length > 0);
  for (const { path, method } of operations) {
    const route = path.replace(/\{(\w+)\}/g, ':$1');
    assert.ok(source.includes(`app.${method}('${route}'`), `${method.toUpperCase()} ${path} is not registered`);
  }
});

test('every $ref resolves to a declared schema', () => {
  const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
  assert.ok(refs.length > 0);
  for (const r of refs) assert.ok(doc.components.schemas[r.split('/').pop()!], r);
});

test('every operation has a summary, a tag and a success response', () => {
  for (const { path, method, op } of operations) {
    const where = `${method} ${path}`;
    assert.ok(op.summary, where);
    assert.ok(op.tags?.length, where);
    assert.ok(op.responses?.[200], where);
  }
});

test('every path parameter in a template is declared', () => {
  for (const { path, method, op } of operations) {
    for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
      assert.ok(
        (op.parameters ?? []).some((p: any) => p.in === 'path' && p.name === name && p.required),
        `${method} ${path} misses {${name}}`,
      );
    }
  }
});

test('the document carries the version and the bearer scheme', () => {
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.version, '1.2.3');
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
});
