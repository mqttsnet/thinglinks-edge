import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import Fastify from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import { InstanceOperationGate } from '../../core/instance/operation-gate.ts';
import { InstanceRepo, type InstanceRecord } from '../../core/instance/repo.ts';
import { ProxySessionRegistry } from '../../core/instance/proxy-session-registry.ts';
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
): HttpContext {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('proxy-gate-test', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
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

async function websocketUrl(app: ReturnType<typeof Fastify>): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return `ws://127.0.0.1:${address.port}/red/line-a/socket`;
}

test('proxy POST PUT PATCH DELETE share the gate while GET and HEAD remain readable', async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(req.method ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(upstream);
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const app = Fastify({ logger: false });
  registerProxy(app, proxyContext(`http://127.0.0.1:${port}`, gate));

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
    assert.deepEqual(seen, ['GET', 'HEAD']);
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
