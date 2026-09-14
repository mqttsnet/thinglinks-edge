import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { openDb } from '../../core/db.ts';
import { AuthService } from '../../core/auth/service.ts';
import { UserRepo } from '../../core/auth/user-repo.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import { InstanceRepo } from '../../core/instance/repo.ts';
import { ProxySessionRegistry } from '../../core/instance/proxy-session-registry.ts';
import { InstanceOperationGate, InstanceRepositoryOperationPolicy } from '../../core/instance/operation-gate.ts';
import { createContext, type ServerDeps } from '../context.ts';
import { registerUsers } from './users.ts';
import { registerSession } from './session.ts';
import { registerProxy } from '../instance/proxy.ts';
import { registerEditorOriginGate } from '../editor-origin-server.ts';
import { reserveEditorOriginListeners } from '../editor-origin-listeners.fixtures.ts';

const password = 'only-a-local-test-password';

async function fixture(fakeChannels = true, editorPortRange?: { min: number; max: number }) {
  const db = openDb(':memory:');
  const auth = new AuthService(db);
  auth.createFirstAdmin('admin', password);
  const users = new UserRepo(db);
  for (const username of ['alice', 'bob']) {
    const initial = users.create(username, 'operator', 'admin');
    auth.changePassword(username, initial, password);
  }
  const repo = new InstanceRepo(db, deriveKey('local-session-fixture', 'instance'));
  for (const id of ['line-a', 'line-b']) {
    repo.create({ id, name: id, imageTag: '5.0.4-24-minimal', memLimit: 512, cpuLimit: 0.5,
      adminRoot: `/red/${id}/`, credSecret: 'local-fixture', notes: '' }, [],
    [{ username: 'admin', password: 'local-fixture-password', permissions: '*' }]);
    users.grant('alice', id, 'operate', 'admin');
    users.grant('bob', id, 'operate', 'admin');
  }
  const login = (username: string) => {
    const result = auth.login(username, password);
    assert.ok('sid' in result);
    return result.sid;
  };
  const admin = login('admin');
  const alice = login('alice');
  const aliceOther = login('alice');
  const bob = login('bob');
  const proxySessions = new ProxySessionRegistry();
  const app = Fastify();
  await app.register(cookie);
  const ctx = createContext({ config: { basePath: '', cookieSecure: false, editorPortRange,
    externalUrl: 'http://127.0.0.1:19100', allowedOrigins: ['http://127.0.0.1:19100'] }, db, auth, repo,
    proxySessions, operationGate: new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo)) } as unknown as ServerDeps);
  registerUsers(app, ctx);
  registerSession(app, ctx);
  const closed: string[] = [];
  const releases: Array<() => void> = [];
  for (const [name, username, sessionId, instanceId] of fakeChannels ? [
    ['alice-a', 'alice', alice, 'line-a'], ['alice-b', 'alice', alice, 'line-b'],
    ['alice-other', 'alice', aliceOther, 'line-a'], ['bob-a', 'bob', bob, 'line-a'],
  ] : []) {
    const release = proxySessions.authorize({ username: username!, sessionId: sessionId!, instanceId: instanceId! }, () => true)
      .register({ close: () => { closed.push(name!); } });
    assert.ok(release);
    releases.push(release);
  }
  return {
    app, auth, ctx, users, closed, admin, alice, aliceOther, bob, proxySessions,
    headers: (sid = admin) => ({ cookie: `tle_sid=${sid}; tle_csrf=fixture-csrf`, 'x-csrf-token': 'fixture-csrf' }),
    close: async () => { releases.forEach((release) => release()); await app.close(); db.close(); },
  };
}

for (const change of [
  { name: 'grant revocation', method: 'DELETE', url: '/api/users/alice/grants/line-a', expected: ['alice-a', 'alice-other'] },
  { name: 'grant downgrade', method: 'POST', url: '/api/users/alice/grants', payload: { instanceId: 'line-a', level: 'view' }, expected: ['alice-a', 'alice-other'] },
  { name: 'role downgrade', method: 'POST', url: '/api/users/alice/role', payload: { role: 'viewer' }, expected: ['alice-a', 'alice-b', 'alice-other'] },
  { name: 'disable account', method: 'POST', url: '/api/users/alice/disabled', payload: { disabled: true }, expected: ['alice-a', 'alice-b', 'alice-other'] },
  { name: 'reset password', method: 'POST', url: '/api/users/alice/password/reset', expected: ['alice-a', 'alice-b', 'alice-other'] },
] as const) {
  test(`${change.name} closes affected realtime channels before returning, preserving other users`, async (t) => {
    const f = await fixture();
    t.after(f.close);
    const response = await f.app.inject({ method: change.method, url: change.url, headers: f.headers(),
      ...('payload' in change ? { payload: change.payload } : {}) });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
    assert.deepEqual(f.closed.sort(), [...change.expected].sort());
  });
}

test('logout closes only this login session on all instances', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers(f.alice) });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(f.closed.sort(), ['alice-a', 'alice-b']);
  assert.equal(f.auth.peek(f.alice), undefined);
  assert.ok(f.auth.peek(f.aliceOther));
});

test('self password change closes every session of that user', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.app.inject({ method: 'POST', url: '/api/change-password', headers: f.headers(f.alice),
    payload: { oldPassword: password, newPassword: 'a-new-local-test-password' } });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(f.closed.sort(), ['alice-a', 'alice-b', 'alice-other']);
  assert.equal(f.auth.peek(f.aliceOther), undefined);
});

test('rejected user changes never revoke legitimate sessions', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.app.inject({ method: 'POST', url: '/api/users/alice/role', headers: f.headers(), payload: { role: 'invalid' } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(f.closed, []);
});

test('real websocket grant revocation stops the affected channel while other users and instances keep working', { timeout: 10_000 }, async (t) => {
  const listeners = await reserveEditorOriginListeners(2);
  t.after(() => listeners.close());
  const f = await fixture(false, listeners.portRange);
  const runtimeOrigins = { 'line-a': f.ctx.editorOrigins.origin('line-a'), 'line-b': f.ctx.editorOrigins.origin('line-b') };
  const upstream = createServer();
  const upstreamWs = new WebSocketServer({ server: upstream });
  const rawSockets = new Set<Socket>();
  for (const server of [upstream, f.app.server]) server.on('connection', (socket: Socket) => {
    rawSockets.add(socket);
    socket.once('close', () => rawSockets.delete(socket));
  });
  const clients: WebSocket[] = [];
  t.after(async () => {
    f.proxySessions.closeUser('alice');
    f.proxySessions.closeUser('bob');
    for (const client of clients) if (client.readyState !== WebSocket.CLOSED) client.terminate();
    for (const socket of upstreamWs.clients) socket.terminate();
    for (const socket of rawSockets) socket.destroy();
    await listeners.close();
    upstreamWs.close();
    await f.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  upstreamWs.on('connection', (socket) => socket.on('message', (message) => socket.send(message)));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  f.ctx.upstreamFor = () => `http://127.0.0.1:${address.port}`;
  registerEditorOriginGate(f.app, f.ctx);
  registerProxy(f.app, f.ctx);
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  await listeners.forwardTo(f.app);
  const managerAddress = f.app.server.address();
  assert.ok(managerAddress && typeof managerAddress === 'object');
  const connect = async (sid: string, instanceId: 'line-a' | 'line-b') => {
    const user = f.auth.peek(sid);
    assert.ok(user);
    f.ctx.editorAccess.grant({ sessionId: sid, username: user.username, instanceId, scope: '*' });
    const client = new WebSocket(`${runtimeOrigins[instanceId].replace('http:', 'ws:')}/red/${instanceId}/comms`, {
      headers: { cookie: `tle_sid=${sid}`, origin: runtimeOrigins[instanceId] },
    });
    clients.push(client);
    await once(client, 'open', { signal: AbortSignal.timeout(2_000) });
    return client;
  };
  const aliceA = await connect(f.alice, 'line-a');
  const aliceB = await connect(f.alice, 'line-b');
  const bobA = await connect(f.bob, 'line-a');
  const echo = async (client: WebSocket, payload: string) => {
    const response = once(client, 'message', { signal: AbortSignal.timeout(2_000) });
    client.send(payload);
    const [message] = await response;
    assert.equal(String(message), payload);
  };
  await echo(aliceA, 'before-revocation');
  const closed = once(aliceA, 'close', { signal: AbortSignal.timeout(2_000) });
  const response = await f.app.inject({ method: 'DELETE', url: '/api/users/alice/grants/line-a', headers: f.headers() });
  assert.equal(response.statusCode, 204);
  await closed;
  assert.equal(aliceA.readyState, WebSocket.CLOSED);
  await echo(aliceB, 'same-user-other-instance');
  await echo(bobA, 'other-user-same-instance');
});
