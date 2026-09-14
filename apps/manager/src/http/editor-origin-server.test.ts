import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import Fastify from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { openDb } from '../core/db.ts';
import { EditorOrigins } from '../core/instance/editor-origins.ts';
import { registerEditorOriginGate, startEditorOriginServers } from './editor-origin-server.ts';
import type { HttpContext } from './context.ts';

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

test('independent listener admits only its instance and blocks shared-cookie attacks on Manager', { timeout: 15_000 }, async (t) => {
  const port = await availablePort();
  const db = openDb(':memory:');
  const origins = new EditorOrigins(db, { externalUrl: 'http://127.0.0.1:19100', basePath: '',
    portRange: { min: port, max: port }, generationFor: (id) => id === 'line-a' ? 'generation' : undefined });
  origins.origin('line-a');
  const ctx = { config: { basePath: '', allowedOrigins: ['http://127.0.0.1:19100'] }, editorOrigins: origins } as unknown as HttpContext;
  const app = Fastify();
  registerEditorOriginGate(app, ctx);
  app.get('/api/users', async () => ({ secret: 'manager-only' }));
  app.post('/api/logout', async () => ({ mutation: true }));
  app.get('/red/:id', async (req, reply) => reply.redirect(`${req.url}/`));
  app.get('/red/:id/*', async () => ({ editor: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const listeners = await startEditorOriginServers(app, { host: '127.0.0.1', portRange: origins.portRange });
  t.after(async () => { await listeners.close(); await app.close(); db.close(); });
  const runtime = `http://127.0.0.1:${port}`;
  const manager = `http://127.0.0.1:${address.port}`;
  const cookie = 'tle_sid=fake-admin-cookie; tle_csrf=fake-shared-csrf';
  const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers: { cookie, ...headers }, redirect: 'manual' });
  assert.equal((await get(`${runtime}/red/line-a/index.js`)).status, 200);
  assert.equal((await get(`${runtime}/red/line-a`)).status, 302);
  assert.equal((await get(`${runtime}/api/users`)).status, 404);
  assert.equal((await get(`${runtime}/red/line-b/index.js`)).status, 404);
  assert.equal((await get(`${runtime}/red/line-a/api/action`, { 'sec-fetch-site': 'same-site', referer: 'http://127.0.0.1:19999/red/other/' })).status, 403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = request(`${runtime}/red/line-a/index.js`, { headers: { host: 'attacker.example' } }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    }); req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await get(`${manager}/red/line-a/index.js`)).status, 403);
  assert.equal((await get(`${manager}/red/line-a/`)).status, 302);
  assert.equal((await get(`${manager}/red/line-a/api/report`)).status, 200);
  assert.equal((await get(`${manager}/red/line-a/api/report`, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await fetch(`${manager}/api/logout`, { method: 'POST', headers: { cookie, origin: runtime, 'x-csrf-token': 'fake-shared-csrf' } })).status, 403);
  assert.equal((await fetch(`${manager}/api/logout`, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:19100' } })).status, 200);
});

test('runtime listeners forward websocket upgrades and close cleanly', { timeout: 10_000 }, async (t) => {
  const app = Fastify();
  await app.ready();
  const port = await availablePort();
  const ws = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, (client) => {
    client.on('message', (message) => client.send(message));
  }));
  const listeners = await startEditorOriginServers(app, { host: '127.0.0.1', portRange: { min: port, max: port } });
  const client = new WebSocket(`ws://127.0.0.1:${port}/red/line-a/comms`);
  t.after(async () => { client.terminate(); await listeners.close(); ws.close(); await app.close(); });
  await once(client, 'open');
  const response = once(client, 'message'); client.send('echo');
  assert.equal(String((await response)[0]), 'echo');
});
