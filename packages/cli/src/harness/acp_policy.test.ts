import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePermission, buildPermissionResponse, acpTaskExtras } from './acp_policy.js';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';

const req = (kind: string | null, locations?: { path: string }[]): RequestPermissionRequest => ({
  sessionId: 's1',
  toolCall: { toolCallId: 't1', kind: kind as any, locations },
  options: [],
});

test('interactive mode asks', () => {
  assert.equal(decidePermission(req('execute'), {}), 'ask');
  assert.equal(decidePermission(req('edit'), { mode: 'interactive' }), 'ask');
});

test('unattended allows everything (no docker)', () => {
  assert.equal(decidePermission(req('execute'), { mode: 'unattended' }), 'allow');
  assert.equal(decidePermission(req('edit'), { mode: 'unattended' }), 'allow');
});

test('docker denies execute in every mode', () => {
  const docker = { container: 'c', workdir: '/w' };
  assert.equal(decidePermission(req('execute'), { mode: 'unattended', docker }), 'deny');
  assert.equal(decidePermission(req('execute'), { mode: 'interactive', docker }), 'deny');
  assert.equal(decidePermission(req('read'), { mode: 'unattended', docker }), 'allow');
});

test('planner denies mutating kinds, allows read/search/other', () => {
  const p = { mode: 'planner' as const };
  for (const k of ['edit', 'delete', 'move', 'execute']) assert.equal(decidePermission(req(k), p), 'deny');
  for (const k of ['read', 'search', 'think', 'fetch', 'other', null]) assert.equal(decidePermission(req(k), p), 'allow');
});

test('planner SDD allows edit only when every location is .md', () => {
  const sdd = { mode: 'planner' as const, sdd: true };
  assert.equal(decidePermission(req('edit', [{ path: '/w/spec.md' }]), sdd), 'allow');
  assert.equal(decidePermission(req('edit', [{ path: '/w/spec.md' }, { path: '/w/a.ts' }]), sdd), 'deny');
  assert.equal(decidePermission(req('edit', []), sdd), 'deny'); // no locations = can't verify = deny
  assert.equal(decidePermission(req('execute'), sdd), 'deny');
});

test('deny-all denies reads too', () => {
  assert.equal(decidePermission(req('read'), { mode: 'deny-all' }), 'deny');
});

const opts: PermissionOption[] = [
  { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
  { optionId: 'aA', name: 'Always', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
];

test('buildPermissionResponse maps decisions to option kinds', () => {
  assert.deepEqual(buildPermissionResponse(opts, 'once').outcome, { outcome: 'selected', optionId: 'a1' });
  assert.deepEqual(buildPermissionResponse(opts, 'always').outcome, { outcome: 'selected', optionId: 'aA' });
  assert.deepEqual(buildPermissionResponse(opts, 'reject').outcome, { outcome: 'selected', optionId: 'r1' });
  assert.deepEqual(buildPermissionResponse(opts, 'deny').outcome, { outcome: 'selected', optionId: 'r1' });
  assert.deepEqual(buildPermissionResponse([], 'deny').outcome, { outcome: 'cancelled' });
});

test('acpTaskExtras shapes the run extras per role', () => {
  const dev = acpTaskExtras({ planning: false, sdd: false, bridge: { url: 'http://b', token: 'T' } });
  assert.equal(dev.mode, 'unattended');
  assert.deepEqual(dev.extraMcpServers, { task: { type: 'http', url: 'http://b', headers: { Authorization: 'Bearer T' } } });
  const plan = acpTaskExtras({ planning: true, sdd: true });
  assert.equal(plan.mode, 'planner');
  assert.equal(plan.sdd, true);
  assert.equal(plan.extraMcpServers, undefined);
});
