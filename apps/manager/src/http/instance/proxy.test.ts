import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import fastify from 'fastify';
import { EditorAccessStore } from '../../core/auth/editor-access.ts';

function Fastify(options: { logger: boolean }) {
  const app = fastify(options);
  // These proxy unit fixtures authenticate a synthetic Manager session.
  app.addHook('onRequest', (req, _reply, done) => { req.cookies = { tle_sid: 'fake-session' }; done(); });
  return app;
}
import WebSocket, { WebSocketServer } from 'ws';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import {
  InstanceBusyError,
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
} from '../../core/instance/operation-gate.ts';
import { InstanceRepo, type InstanceRecord } from '../../core/instance/repo.ts';
import {
  ProxySessionRegistry,
  type ProxyWebSocketSession,
} from '../../core/instance/proxy-session-registry.ts';
import { PLATFORM_NODE_PACKAGE } from '../../core/nodes/platform-contract.ts';
import type { HttpContext } from '../context.ts';
import { registerProxy } from './proxy.ts';

const instance: InstanceRecord = {
  id: 'line-a',
  name: 'line-a',
  imageTag: '5.0.4-24-minimal',
  memLimit: 512,
  cpuLimit: 0.5,
  adminRoot: '/red/line-a/',
  credSecret: 'credential-secret',
  notes: '',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function terminateWebSockets(server: WebSocketServer): void {
  for (const socket of server.clients) socket.terminate();
}

function trackConnections(app: ReturnType<typeof Fastify>): Set<Socket> {
  const sockets = new Set<Socket>();
  app.server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

function trackServerConnections(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function proxyContext(
  upstream: string,
  operationGate: InstanceOperationGate,
  proxySessions = new ProxySessionRegistry(),
  existingRepo?: InstanceRepo,
): HttpContext {
  const repo = existingRepo ?? proxyRepository();
  const editorAccess = new EditorAccessStore({ credentialFor: (id) => repo.credentials(id)[0] });
  editorAccess.grant({ sessionId: 'fake-session', username: 'admin', instanceId: 'line-a', scope: '*' });
  const currentUser = () => ({ username: 'admin', role: 'admin', mustChangePassword: false, mustEnroll2fa: false, totpEnabled: false });
  return {
    editorAccess,
    auth: { peek: currentUser },
    config: {
      basePath: '',
      externalUrl: 'http://127.0.0.1:19100',
      allowedOrigins: ['http://127.0.0.1:19100'],
    },
    repo,
    operationGate,
    proxySessions,
    upstreamFor: () => upstream,
    currentUser: () => ({
      username: 'admin',
      role: 'admin',
      mustChangePassword: false,
      mustEnroll2fa: false,
      totpEnabled: false,
    }),
    users: {},
    instanceIdFromUrl: (url: string) => /^\/red\/([^/?]+)/.exec(url)?.[1],
  } as unknown as HttpContext;
}

function proxyRepository(): InstanceRepo {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('proxy-gate-test', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  return repo;
}

function markManualRequired(repo: InstanceRepo, txId: string): void {
  repo.beginNodeMigration({
    instanceId: 'line-a',
    txId,
    operationKind: 'bootstrap',
    phase: 'preparing',
    originalRunning: false,
    stagedBefore: false,
    modeBefore: 'legacy',
    imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '',
    snapshot: { version: 1, kind: 'bootstrap' },
    actor: 'admin',
  });
  repo.updateNodeMigration('line-a', 'manual_required', 'state-inconsistent');
}

async function websocketUrl(app: ReturnType<typeof Fastify>): Promise<string> {
  const port = await fastifyPort(app);
  return `ws://127.0.0.1:${port}/red/line-a/socket`;
}

async function fastifyPort(app: ReturnType<typeof Fastify>): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

test('proxy writes honor live and repository-backed gates while reads remain available', async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(req.method ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(upstream);
  const repo = proxyRepository();
  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const app = Fastify({ logger: false });
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, gate, undefined, repo));

  try {
    await gate.run('line-a', 'platform-migration', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const response = await app.inject({ method, url: '/red/line-a/admin', payload: '{}' });
        assert.equal(response.statusCode, 409, method);
        assert.match(response.json().error, /platform-migration/);
      }
      const upgrade = await app.inject({
        method: 'GET',
        url: '/red/line-a/socket',
        headers: { connection: 'Upgrade', upgrade: 'websocket' },
      });
      assert.equal(upgrade.statusCode, 409, 'WebSocket upgrade');
      assert.equal((await app.inject({ method: 'GET', url: '/red/line-a/status' })).statusCode, 200);
      assert.equal((await app.inject({ method: 'HEAD', url: '/red/line-a/status' })).statusCode, 200);
    });
    markManualRequired(repo, 'tx-proxy-manual');
    const persistedWrite = await app.inject({
      method: 'POST',
      url: '/red/line-a/admin',
      payload: '{}',
    });
    assert.equal(persistedWrite.statusCode, 409);
    assert.match(persistedWrite.json().error, /manual_required\/state-inconsistent/);
    assert.equal((await app.inject({ method: 'GET', url: '/red/line-a/status' })).statusCode, 200);
    assert.deepEqual(seen, ['GET', 'HEAD', 'GET']);
  } finally {
    await app.close();
    await closeServer(upstream);
  }
});

test('proxy write lease remains held until the upstream response finishes', async () => {
  const requestSeen = deferred<void>();
  const releaseResponse = deferred<void>();
  const upstream = createServer((_req, res) => {
    requestSeen.resolve();
    void releaseResponse.promise.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const app = Fastify({ logger: false });
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, gate));

  try {
    const response = app.inject({ method: 'POST', url: '/red/line-a/delay', payload: '{}' });
    await requestSeen.promise;
    assert.equal(gate.current('line-a'), 'proxy-write');
    releaseResponse.resolve();
    assert.equal((await response).statusCode, 200);
    assert.equal(gate.current('line-a'), undefined);
  } finally {
    releaseResponse.resolve();
    await app.close();
    await closeServer(upstream);
  }
});

test('proxy upstream error releases the write lease', async () => {
  const upstream = createServer((_req, res) => res.destroy(new Error('upstream failed')));
  const port = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const app = Fastify({ logger: false });
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, gate));

  try {
    const response = await app.inject({ method: 'POST', url: '/red/line-a/fail', payload: '{}' });
    assert.ok(response.statusCode >= 500);
    assert.equal(gate.current('line-a'), undefined);
  } finally {
    await app.close();
    await closeServer(upstream);
  }
});

test('real client abort releases once before upstream completion and late signals cannot release a new lease', async () => {
  const upstreamSeen = deferred<void>();
  let upstreamResponse: ServerResponse | undefined;
  let upstreamFinished = false;
  const upstream = createServer((_req, res) => {
    upstreamResponse = res;
    res.once('finish', () => { upstreamFinished = true; });
    upstreamSeen.resolve();
  });
  const upstreamSockets = trackServerConnections(upstream);
  const upstreamPort = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const app = Fastify({ logger: false });
  const managerSockets = trackConnections(app);
  registerProxy(app, proxyContext(`http://127.0.0.1:${upstreamPort}`, gate));
  const managerPort = await fastifyPort(app);
  const client = httpRequest({
    host: '127.0.0.1',
    port: managerPort,
    method: 'POST',
    path: '/red/line-a/abort',
    headers: { 'content-type': 'application/json' },
  });
  client.on('error', () => undefined);
  client.end('{}');

  try {
    await upstreamSeen.promise;
    assert.equal(gate.current('line-a'), 'proxy-write');
    client.destroy(new Error('client aborted'));
    await waitFor(() => gate.current('line-a') === undefined);
    assert.equal(upstreamFinished, false);

    const releaseMigration = deferred<void>();
    const migration = gate.run(
      'line-a',
      'platform-migration',
      async () => releaseMigration.promise,
    );
    assert.equal(gate.current('line-a'), 'platform-migration');
    // These are late competing terminal signals from the old request.
    client.destroy();
    upstreamResponse?.destroy();
    await nextTurn();
    assert.equal(gate.current('line-a'), 'platform-migration');
    releaseMigration.resolve();
    await migration;
  } finally {
    client.destroy();
    upstreamResponse?.destroy();
    for (const socket of managerSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await app.close();
    await closeServer(upstream);
  }
});

test('real upstream response socket close releases the proxy write lease', async () => {
  const upstreamStarted = deferred<void>();
  let upstreamResponse: ServerResponse | undefined;
  const upstream = createServer((_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    upstreamStarted.resolve();
  });
  const upstreamSockets = trackServerConnections(upstream);
  const upstreamPort = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const app = Fastify({ logger: false });
  const managerSockets = trackConnections(app);
  registerProxy(app, proxyContext(`http://127.0.0.1:${upstreamPort}`, gate));
  const managerPort = await fastifyPort(app);
  const responseSeen = deferred<IncomingMessage>();
  const client = httpRequest({
    host: '127.0.0.1',
    port: managerPort,
    method: 'POST',
    path: '/red/line-a/response-close',
    headers: { 'content-type': 'application/json' },
  });
  client.on('response', responseSeen.resolve);
  client.on('error', () => undefined);
  client.end('{}');

  try {
    await upstreamStarted.promise;
    const response = await responseSeen.promise;
    response.resume();
    assert.equal(gate.current('line-a'), 'proxy-write');
    const responseClosed = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      response.once('aborted', finish);
      response.once('close', finish);
      response.once('error', finish);
    });
    upstreamResponse?.destroy(new Error('upstream response closed'));
    await responseClosed;
    await waitFor(() => gate.current('line-a') === undefined);
  } finally {
    client.destroy();
    upstreamResponse?.destroy();
    for (const socket of managerSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await app.close();
    await closeServer(upstream);
  }
});

test('WebSocket registration observes the upgrade lease and blocks migration until registered', async () => {
  const upstream = createServer();
  const upstreamRawSockets = trackServerConnections(upstream);
  const upstreamSockets = new WebSocketServer({ server: upstream });
  const port = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  class InspectingRegistry extends ProxySessionRegistry {
    observedOperation: ReturnType<InstanceOperationGate['current']>;
    migrationAcquired = false;
    migrationError: unknown;
    migrationAttempt: Promise<void> = Promise.resolve();

    override register(instanceId: string, session: ProxyWebSocketSession): () => void {
      this.observedOperation = gate.current(instanceId);
      this.migrationAttempt = gate.run(
        instanceId,
        'platform-migration',
        async () => { this.migrationAcquired = true; },
      ).then(
        () => undefined,
        (error: unknown) => { this.migrationError = error; },
      );
      return super.register(instanceId, session);
    }
  }
  const proxySessions = new InspectingRegistry();
  const app = Fastify({ logger: false });
  const closeManagerServer = app.server.close.bind(app.server);
  const managerSockets = trackConnections(app);
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, gate, proxySessions));
  const url = await websocketUrl(app);
  const client = new WebSocket(url);

  try {
    await once(client, 'open');
    await waitFor(() => proxySessions.count('line-a') === 1);
    await proxySessions.migrationAttempt;
    assert.equal(proxySessions.observedOperation, 'proxy-write');
    assert.equal(proxySessions.migrationAcquired, false);
    assert.ok(proxySessions.migrationError instanceof InstanceBusyError);
    assert.equal(proxySessions.migrationError.activeOperation, 'proxy-write');
    await waitFor(() => gate.current('line-a') === undefined);
  } finally {
    if (client.readyState !== WebSocket.CLOSED) client.terminate();
    terminateWebSockets(upstreamSockets);
    for (const socket of managerSockets) socket.destroy();
    for (const socket of upstreamRawSockets) socket.destroy();
    await nextTurn();
    await new Promise<void>((resolve, reject) => {
      closeManagerServer((error) => error ? reject(error) : resolve());
    });
    upstreamSockets.close();
    await closeServer(upstream);
  }
});

test('existing WebSocket receives 1012 and unregisters before snapshot continuation', async () => {
  const upstream = createServer();
  const upstreamRawSockets = trackServerConnections(upstream);
  const upstreamSockets = new WebSocketServer({ server: upstream });
  const port = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const proxySessions = new ProxySessionRegistry();
  const app = Fastify({ logger: false });
  const closeManagerServer = app.server.close.bind(app.server);
  const managerSockets = trackConnections(app);
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, gate, proxySessions));
  const url = await websocketUrl(app);
  const client = new WebSocket(url);

  try {
    await once(client, 'open');
    await waitFor(() => proxySessions.count('line-a') === 1);
    assert.equal(proxySessions.count('line-a'), 1);
    const closed = once(client, 'close');
    const events: string[] = [];
    await proxySessions.closeAndDrain('line-a', { code: 1012, timeoutMs: 1_000 });
    events.push('snapshot');
    const [code] = await closed as [number, Buffer];
    assert.equal(code, 1012);
    assert.deepEqual(events, ['snapshot']);
    assert.equal(proxySessions.count('line-a'), 0);
    assert.equal(gate.current('line-a'), undefined);
  } finally {
    if (client.readyState !== WebSocket.CLOSED) client.terminate();
    terminateWebSockets(upstreamSockets);
    for (const socket of managerSockets) socket.destroy();
    for (const socket of upstreamRawSockets) socket.destroy();
    await nextTurn();
    await new Promise<void>((resolve, reject) => {
      closeManagerServer((error) => error ? reject(error) : resolve());
    });
    upstreamSockets.close();
    await closeServer(upstream);
  }
});

test('HTTP proxy does not expose Manager credentials or let an instance set shared-origin cookies', async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['tle_sid=forged; Path=/', 'flow_session=foreign; Path=/'] });
    res.end(JSON.stringify(req.headers));
  });
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined })));
  try {
    for (const path of ['/red/line-a/flows', '/red/line-a/api/report']) {
      const response = await app.inject({ url: path, headers: {
        cookie: 'tle_sid=fake-manager-session; tle_csrf=fake-csrf; another_instance=fake-cookie',
        'x-csrf-token': 'fake-csrf', 'x-forwarded-user': 'admin', 'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '127.0.0.1', 'x-auth-request-user': 'admin', forwarded: 'for=127.0.0.1',
        authorization: 'Bearer instance-or-device-token', 'x-device-key': 'fake-device-key',
      } });
      assert.equal(response.statusCode, 200);
      const seen = response.json();
      for (const name of ['cookie', 'x-csrf-token', 'x-forwarded-user', 'x-forwarded-for', 'x-real-ip', 'x-auth-request-user', 'forwarded']) {
        assert.equal(seen[name], undefined, `${path} must strip ${name}`);
      }
      assert.equal(seen.authorization, 'Bearer instance-or-device-token');
      assert.equal(seen['x-device-key'], 'fake-device-key');
      assert.equal(response.headers['set-cookie'], undefined);
    }
  } finally { await app.close(); await closeServer(upstream); }
});

test('WebSocket proxy isolates credentials while retaining explicit instance authentication', async () => {
  const seen = deferred<IncomingMessage>();
  const upstream = createServer();
  const upstreamRawSockets = trackServerConnections(upstream);
  const upstreamSockets = new WebSocketServer({ server: upstream });
  upstreamSockets.on('headers', (headers) => headers.push('Set-Cookie: tle_sid=forged; Path=/'));
  upstreamSockets.on('connection', (_socket, req) => seen.resolve(req));
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  const closeManagerServer = app.server.close.bind(app.server);
  const managerSockets = trackConnections(app);
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined })));
  const client = new WebSocket(await websocketUrl(app), { headers: {
    cookie: 'tle_sid=fake-manager-session; tle_csrf=fake-csrf',
    'x-csrf-token': 'fake-csrf', 'x-forwarded-user': 'admin', authorization: 'Bearer instance-token',
  } });
  const upgrade = once(client, 'upgrade');
  try {
    await once(client, 'open');
    const request = await seen.promise;
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-csrf-token'], undefined);
    assert.equal(request.headers['x-forwarded-user'], undefined);
    assert.equal(request.headers.authorization, 'Bearer instance-token');
    const [response] = await upgrade as [IncomingMessage];
    assert.equal(response.headers['set-cookie'], undefined);
  } finally {
    client.terminate(); terminateWebSockets(upstreamSockets);
    for (const socket of managerSockets) socket.destroy();
    for (const socket of upstreamRawSockets) socket.destroy();
    await nextTurn();
    await new Promise<void>((resolve, reject) => closeManagerServer((error) => error ? reject(error) : resolve()));
    upstreamSockets.close(); await closeServer(upstream);
  }
});

test('proxy refuses pending two-factor enrollment before contacting the instance', async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end('unexpected'); });
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  const ctx = proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined }));
  const user = ctx.currentUser({} as never)!;
  ctx.currentUser = () => ({ ...user, mustEnroll2fa: true });
  registerProxy(app, ctx);
  try {
    const response = await app.inject({ url: '/red/line-a/flows' });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'TOTP_ENROLL_REQUIRED');
    assert.equal(hits, 0);
  } finally { await app.close(); await closeServer(upstream); }
});

test('editor password lease gates direct reads, writes and WebSocket without stopping flow ingress', async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end('ok'); });
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  const ctx = proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined }));
  registerProxy(app, ctx);
  ctx.editorAccess.revokeSession('fake-session');
  try {
    for (const input of [
      { url: '/red/line-a/flows' },
      { method: 'POST' as const, url: '/red/line-a/flows', payload: '{}' },
      { url: '/red/line-a/comms', headers: { upgrade: 'websocket', connection: 'Upgrade' } },
    ]) {
      const response = await app.inject(input);
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, 'EDITOR_PASSWORD_REQUIRED');
    }
    assert.equal(hits, 0);
    assert.equal((await app.inject({ url: '/red/line-a/api/report' })).statusCode, 200);
    assert.equal(hits, 1);
  } finally { await app.close(); await closeServer(upstream); }
});

test('expired editor or Manager sessions navigate back to the absolute management origin', async () => {
  for (const managerExpired of [false, true]) {
    const app = Fastify({ logger: false });
    const ctx = proxyContext('http://127.0.0.1:1', new InstanceOperationGate({ assertAllowed: () => undefined }));
    ctx.editorAccess.revokeSession('fake-session');
    if (managerExpired) ctx.currentUser = () => undefined;
    registerProxy(app, ctx);
    try {
      const navigation = await app.inject({ url: '/red/line-a/', headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
      assert.equal(navigation.statusCode, 302);
      assert.equal(navigation.headers.location, 'http://127.0.0.1:19100/instances?editor=line-a');
      const api = await app.inject({ url: '/red/line-a/flows' });
      assert.equal(api.statusCode, managerExpired ? 401 : 403);
    } finally { await app.close(); }
  }
});

test('flow documents have an opaque browser origin and cannot register shared-origin service workers', async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html', 'service-worker-allowed': '/' }); res.end('<script>localStorage.getItem("another-instance")</script>'); });
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined })));
  try {
    const response = await app.inject('/red/line-a/api/dashboard');
    const csp = response.headers['content-security-policy'];
    assert.equal(typeof csp, 'string');
    assert.match(csp as string, /(?:^|;)\s*sandbox allow-scripts(?:;|$)/);
    assert.ok(!(csp as string).includes('allow-same-origin'));
    assert.equal(response.headers['service-worker-allowed'], undefined);
    const worker = await app.inject({ url: '/red/line-a/api/worker.js', headers: { 'service-worker': 'script' } });
    assert.equal(worker.statusCode, 403);
    assert.equal(hits, 1);
  } finally { await app.close(); await closeServer(upstream); }
});

test('flow GET cannot be used as a write bypass by a read-only account', async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end('unexpected'); });
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  const ctx = proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined }));
  ctx.currentUser = () => ({ username: 'viewer', role: 'viewer', mustChangePassword: false, mustEnroll2fa: false, totpEnabled: false });
  ctx.users = { grantFor: () => 'view' } as unknown as HttpContext['users'];
  registerProxy(app, ctx);
  try {
    assert.equal((await app.inject('/red/line-a/api/operate')).statusCode, 403);
    assert.equal(hits, 0);
  } finally { await app.close(); await closeServer(upstream); }
});

test('native editor logout also invalidates the outer password lease', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'cache-control': 'public, max-age=3600' }); res.end('{}'); });
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  const ctx = proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined }));
  registerProxy(app, ctx);
  try {
    const response = await app.inject({ method: 'POST', url: '/red/line-a/auth/revoke', payload: { token: 'fake-node-red-token' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const after = await app.inject('/red/line-a/flows');
    assert.equal(after.statusCode, 403);
    assert.equal(after.json().code, 'EDITOR_PASSWORD_REQUIRED');
  } finally { await app.close(); await closeServer(upstream); }
});

test('revocation during a delayed upstream handshake discards buffered writes', async () => {
  const pendingUpgrade = deferred<{ req: IncomingMessage; socket: Socket; head: Buffer }>();
  const upstream = createServer();
  const upstreamRawSockets = trackServerConnections(upstream);
  const upstreamSockets = new WebSocketServer({ noServer: true });
  let writes = 0;
  upstreamSockets.on('connection', (socket) => { socket.on('message', () => { writes++; }); });
  upstream.on('upgrade', (req, socket, head) => pendingUpgrade.resolve({ req, socket: socket as Socket, head }));
  const port = await listen(upstream);
  const app = Fastify({ logger: false });
  const closeManagerServer = app.server.close.bind(app.server);
  const managerSockets = trackConnections(app);
  const sessions = new ProxySessionRegistry();
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, new InstanceOperationGate({ assertAllowed: () => undefined }), sessions));
  const client = new WebSocket(await websocketUrl(app));
  try {
    await once(client, 'open');
    const pending = await pendingUpgrade.promise;
    sessions.closeSession('fake-session');
    client.send('must-not-reach-device');
    await nextTurn();
    upstreamSockets.handleUpgrade(pending.req, pending.socket, pending.head, (socket) => upstreamSockets.emit('connection', socket, pending.req));
    await waitFor(() => client.readyState === WebSocket.CLOSED);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(writes, 0);
    assert.equal(sessions.count('line-a'), 0);
  } finally {
    client.terminate(); terminateWebSockets(upstreamSockets);
    for (const socket of managerSockets) socket.destroy();
    for (const socket of upstreamRawSockets) socket.destroy();
    await nextTurn();
    await new Promise<void>((resolve, reject) => closeManagerServer((error) => error ? reject(error) : resolve()));
    upstreamSockets.close(); await closeServer(upstream);
  }
});
