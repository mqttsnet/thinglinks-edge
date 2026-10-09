import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IngressAdminSessions } from './session.ts';
import type { AdminTarget } from '../../../core/flows/admin-client.ts';

const target: AdminTarget = { upstream: 'http://instance:1880', adminRoot: '/red/i/', username: 'admin', password: 'test-password' };
function fixture(capacity = 2) {
  let now = 1000; let minted = 0; const revoked: string[] = []; let expiry = 3600;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/auth/token')) return Response.json({ access_token: `token-${++minted}`, expires_in: expiry });
    if (String(input).endsWith('/auth/revoke')) { revoked.push((JSON.parse(String(init?.body)) as { token: string }).token); return new Response(null, { status: 204 }); }
    throw new Error('unexpected request');
  };
  const sessions = new IngressAdminSessions({ capacity, now: () => now, fetchImpl: fetcher });
  return { sessions, revoked, minted: () => minted, setNow: (v: number) => { now = v; }, setExpiry: (v: number) => { expiry = v; } };
}

test('session reuse and same-scope concurrent requests mint only one token', async () => {
  const f = fixture();
  const tokens = await Promise.all(Array.from({ length: 20 }, () => f.sessions.get('i', target, 'credential-v1')));
  assert.equal(new Set(tokens).size, 1); assert.equal(f.minted(), 1);
  assert.equal(await f.sessions.get('i', target, 'credential-v1'), tokens[0]);
  await f.sessions.close(); assert.deepEqual(f.revoked, [tokens[0]]);
});

test('credential, upstream and generation changes never reuse a previous scope and revoke replaced tokens', async () => {
  const f = fixture();
  await f.sessions.get('i', target, 'generation-a');
  await f.sessions.get('i', { ...target, password: 'changed' }, 'generation-a');
  await f.sessions.get('i', { ...target, upstream: 'http://replacement:1880' }, 'generation-a');
  await f.sessions.get('i', target, 'generation-b');
  assert.equal(f.minted(), 4); assert.equal(f.revoked.length, 3);
  await f.sessions.close(); assert.equal(f.revoked.length, 4);
});

test('expiry is refreshed early and the old token is revoked; capacity evicts with revocation', async () => {
  const f = fixture(1);
  await f.sessions.get('i', target, 'v1');
  f.setNow(1000 + 3590 * 1000);
  const renewed = await f.sessions.get('i', target, 'v1');
  assert.equal(f.minted(), 2); assert.deepEqual(f.revoked, ['token-1']);
  await f.sessions.get('j', { ...target, adminRoot: '/red/j/' }, 'v1');
  assert.equal(f.minted(), 3); assert.ok(f.revoked.includes(renewed));
  await f.sessions.close(); await assert.rejects(f.sessions.get('i', target, 'v1'));
});

test('invalidation is exact-token scoped and failed revocation never keeps a cache entry', async () => {
  let minted = 0; let revokeCalls = 0;
  const sessions = new IngressAdminSessions({ fetchImpl: async (input) => {
    if (String(input).endsWith('/auth/token')) return Response.json({ access_token: `token-${++minted}`, expires_in: 3600 });
    revokeCalls++; throw new Error('unavailable');
  } });
  const first = await sessions.get('i', target, 'v1');
  await sessions.invalidate('i', 'unrelated');
  assert.equal(await sessions.get('i', target, 'v1'), first);
  await sessions.invalidate('i', first);
  assert.notEqual(await sessions.get('i', target, 'v1'), first);
  assert.equal(revokeCalls, 1); await sessions.close();
});

test('close during authentication revokes the new token and never leaves a usable cache', async () => {
  let resolve!: (value: Response) => void; let revoked = 0;
  const sessions = new IngressAdminSessions({ fetchImpl: async input => {
    if (String(input).endsWith('/auth/token')) return new Promise<Response>(r => { resolve = r; });
    revoked++; return new Response(null, { status: 204 });
  } });
  const get = sessions.get('i', target, 'v1');
  const close = sessions.close();
  resolve(Response.json({ access_token: 'token', expires_in: 3600 }));
  await assert.rejects(get); await close; assert.equal(revoked, 1);
});

test('bounded revocation timeout releases expired entries instead of stalling token renewal', async t => {
  const { createServer } = await import('node:http');
  let auth = 0; let now = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/auth/token')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: `token-${++auth}`, expires_in: 1 })); }
    // Intentionally never respond to revocation.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const sessions = new IngressAdminSessions({ now: () => now });
  const local = { ...target, upstream: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  assert.equal(await sessions.get('i', local, 'v1'), 'token-1');
  now = 1000;
  const before = Date.now();
  assert.equal(await sessions.get('i', local, 'v1'), 'token-2');
  assert.ok(Date.now() - before < 3000);
  await sessions.close();
});
