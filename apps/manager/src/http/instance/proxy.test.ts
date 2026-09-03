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
import Fastify from 'fastify';
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
  app.server.on('connection', (socket) => {
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
  return {
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
