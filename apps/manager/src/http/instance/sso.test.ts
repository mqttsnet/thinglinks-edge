import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { EditorAccessStore } from '../../core/auth/editor-access.ts';
import { canInstance } from '../../core/auth/authz.ts';
import { ProxySessionRegistry } from '../../core/instance/proxy-session-registry.ts';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import type { SessionUser } from '../../core/auth/service.ts';
import { InstanceRepo } from '../../core/instance/repo.ts';
import type { GrantLevel } from '../../core/auth/authz.ts';
import type { HttpContext } from '../context.ts';
import { registerSso } from './sso.ts';
import { registerEditorAccess } from './editor-access.ts';

async function fixture(user: SessionUser | undefined, grant?: GrantLevel, tokenOverride?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const handoffs: Array<{ scope: string; token: { scope: string }; allowed: () => boolean }> = [];
  const upstream = createServer((req, res) => { void (async () => {
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body) as Record<string, unknown>;
    requests.push(request);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tokenOverride ?? { access_token: 'fake-node-red-token', token_type: 'Bearer', scope: request.scope, expires_in: 3600 }));
  })().catch(() => res.destroy()); });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('fake-sso-master-key', 'instance'));
  repo.create({ id: 'line-a', name: 'line-a', imageTag: '5.0.4-24-minimal', memLimit: 512, cpuLimit: 0.5,
    adminRoot: '/red/line-a/', credSecret: 'fake-secret', notes: '' }, [],
  [{ username: 'admin', password: 'fake-instance-password', permissions: '*' }]);
  const app = Fastify();
  app.register(cookie);
  const editorAccess = new EditorAccessStore({ credentialFor: (id) => repo.credentials(id)[0] });
  const proxySessions = new ProxySessionRegistry();
  const ctx = { config: { basePath: '' }, db, repo,
    upstreamFor: () => `http://127.0.0.1:${address.port}`,
    currentUser: () => user, auth: { peek: () => user }, users: { grantFor: () => grant }, editorAccess, proxySessions,
    editorOrigins: { issueHandoff: (payload: { scope: string; token: { scope: string } }, allowed: () => boolean) => {
      handoffs.push({ ...payload, allowed }); return { editorUrl: 'http://127.0.0.1:19201/editor-handoff/fake-ticket' };
    } },
  } as unknown as HttpContext;
  ctx.guard = (req, reply, opts) => {
    if (!user) { reply.code(401).send({ error: '未登录' }); return; }
    if (user.mustChangePassword || user.mustEnroll2fa || !canInstance(user.role, opts.need, grant)
      || (opts.csrf && req.headers['x-csrf-token'] !== 'fake-csrf')) { reply.code(403).send({ error: '拒绝' }); return; }
    return user;
  };
  registerSso(app, ctx);
  registerEditorAccess(app, ctx);
  return { app, requests, handoffs, editorAccess, proxySessions, async close() { await app.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); db.close(); } };
}

const admin: SessionUser = { username: 'admin', role: 'admin', mustChangePassword: false, mustEnroll2fa: false, totpEnabled: false };

const request = { method: 'POST' as const, url: '/api/instances/line-a/editor-access', headers: { cookie: 'tle_sid=fake-session', 'x-csrf-token': 'fake-csrf' }, payload: { password: 'fake-instance-password' } };

test('legacy SSO no longer mints a token and redirects to explicit password entry', async () => {
  const f = await fixture(admin);
  try {
    const response = await f.app.inject('/red/line-a/sso');
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/instances?editor=line-a');
    assert.equal(f.requests.length, 0);
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally { await f.close(); }
});

test('explicit editor unlock preserves effective role/grant scope and disables caching', async () => {
  for (const [role, grant, expected] of [
    ['admin', undefined, '*'], ['operator', 'operate', '*'], ['operator', 'view', 'read'], ['viewer', 'operate', 'read'],
  ] as const) {
    const f = await fixture({ ...admin, role }, grant);
    try {
      const response = await f.app.inject(request);
      assert.equal(response.statusCode, 200);
      assert.equal(f.requests[0]?.scope, expected, `${role}/${grant}`);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(f.handoffs[0]?.scope, expected);
      assert.equal(f.handoffs[0]?.token.scope, expected);
      assert.equal(f.handoffs[0]?.allowed(), true);
      assert.equal(response.json().editorUrl, 'http://127.0.0.1:19201/editor-handoff/fake-ticket');
      assert.equal(response.json().token, undefined);
      assert.ok(!response.body.includes('fake-node-red-token'));
      assert.ok(f.editorAccess.check({ sessionId: 'fake-session', username: 'admin', instanceId: 'line-a', scope: expected }));
      assert.ok(!response.body.includes('fake-instance-password'));
    } finally { await f.close(); }
  }
});

test('editor unlock refuses pending password/2FA and ungranted users before contacting Node-RED', async () => {
  for (const user of [undefined, { ...admin, mustChangePassword: true }, { ...admin, mustEnroll2fa: true }, { ...admin, role: 'operator' as const }]) {
    const f = await fixture(user);
    try {
      const response = await f.app.inject(request);
      assert.equal(response.statusCode, user ? 403 : 401);
      assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  }
});

test('editor unlock validates CSRF, exact password and the bcrypt byte limit without forwarding invalid attempts', async () => {
  const f = await fixture(admin);
  try {
    assert.equal((await f.app.inject({ ...request, headers: { cookie: 'tle_sid=fake-session' } })).statusCode, 403);
    assert.equal((await f.app.inject({ ...request, payload: { password: 'incorrect' } })).statusCode, 401);
    assert.equal((await f.app.inject({ ...request, payload: { password: '中'.repeat(25) } })).statusCode, 400);
    assert.equal(f.requests.length, 0);
    for (let i = 0; i < 4; i++) await f.app.inject({ ...request, payload: { password: 'incorrect' } });
    assert.equal((await f.app.inject(request)).statusCode, 429);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('editor unlock rejects an upstream token broader than requested read access', async () => {
  const f = await fixture({ ...admin, role: 'viewer' }, 'view', { access_token: 'fake-elevated-token', scope: '*', token_type: 'Bearer' });
  try {
    const response = await f.app.inject(request);
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes('fake-elevated-token'));
    assert.equal(f.editorAccess.check({ sessionId: 'fake-session', username: 'admin', instanceId: 'line-a', scope: 'read' }), undefined);
  } finally { await f.close(); }
});

test('editor unlock returns JSON only and explicit exit removes this instance lease', async () => {
  const f = await fixture(admin);
  try {
    assert.equal((await f.app.inject(request)).statusCode, 200);
    const response = await f.app.inject({ method: 'DELETE', url: request.url, headers: request.headers });
    assert.equal(response.statusCode, 200);
    assert.equal(f.editorAccess.check({ sessionId: 'fake-session', username: 'admin', instanceId: 'line-a', scope: '*' }), undefined);
  } finally { await f.close(); }
});

test('official Node-RED token response without scope remains compatible', async () => {
  const f = await fixture(admin, undefined, { access_token: 'official-shaped-token', token_type: 'Bearer', expires_in: 604800 });
  try { assert.equal((await f.app.inject(request)).statusCode, 200); } finally { await f.close(); }
});

test('upstream token responses are bounded before they can occupy Manager memory', async () => {
  const f = await fixture(admin, undefined, { access_token: 'fake-token', token_type: 'Bearer', padding: 'x'.repeat(100_000) });
  try { assert.equal((await f.app.inject(request)).statusCode, 502); } finally { await f.close(); }
});

test('a new Manager SID cannot bypass a read-only account instance-password attempt limit', async () => {
  const f = await fixture({ ...admin, username: 'viewer-one', role: 'viewer' }, 'view');
  try {
    for (let i = 0; i < 5; i++) {
      const response = await f.app.inject({ ...request, headers: { ...request.headers, cookie: `tle_sid=login-${i}` }, payload: { password: 'incorrect' } });
      assert.equal(response.statusCode, 401);
    }
    const next = await f.app.inject({ ...request, headers: { ...request.headers, cookie: 'tle_sid=another-new-login' }, payload: { password: 'incorrect' } });
    assert.equal(next.statusCode, 429);
    assert.ok(Number(next.headers['retry-after']) > 0);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
