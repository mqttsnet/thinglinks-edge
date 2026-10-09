import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../core/db.ts';
import { deriveKey, encryptSecret } from '../../core/auth/crypto.ts';
import { InstanceOperationGate } from '../../core/instance/operation-gate.ts';
import { registerDeviceIngress } from './device-ingress.ts';
import type { HttpContext } from '../context.ts';
import { flowRevision } from './device-ingress/flow.ts';
import type { FlowSnapshot } from '../../core/flows/admin-client.ts';

const KEY = deriveKey('device-ingress-test', 'test-salt');
const PATH = '/api/device-ingress/b';
const SECRET = 'device-secret';
function deployed(id: string): FlowSnapshot {
  return { rev: 'rev-1', flows: [
    { id: 'tab', type: 'tab', disabled: false },
    { id: 'http', type: 'http in', z: 'tab', url: '/device/data', method: 'post', wires: [['device']] },
    { id: 'device', type: 'tl-device', z: 'tab', deviceId: 'device-a', wires: [] },
    { id: `comment-${id}`, type: 'comment', z: 'tab' },
  ] };
}

function seed(db: Db, id = 'i', bindingId = 'b'): void {
  db.prepare('INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES(?,?,?,512,0.5,?,?)')
    .run(id, id, 'test', `/red/${id}/`, 'test');
  db.prepare(`INSERT INTO device_http_binding
    (id,instance_id,target_path,device_id,secret_enc,max_body_bytes,rate_limit_per_minute,flow_revision)
    VALUES(?,?,?,?,?,?,?,?)`).run(bindingId, id, `/red/${id}/api/device/data`, 'device-a', encryptSecret(SECRET, KEY), 1024, 60, flowRevision(deployed(id)));
}

function context(db: Db, port: number): HttpContext {
  return {
    db, config: { basePath: '' }, repo: { key: KEY, get: (id: string) => {
      const row = db.prepare('SELECT id,admin_root FROM instance WHERE id=?').get(id) as { id: string; admin_root: string } | undefined;
      return row && { id: row.id, adminRoot: row.admin_root };
    } },
    upstreamFor: () => `http://127.0.0.1:${port}`,
    adminRuntime: { target: (id: string) => ({ upstream: `http://127.0.0.1:${port}`, adminRoot: `/red/${id}/`, username: 'admin', password: 'test-password' }) },
    operationGate: new InstanceOperationGate({ assertAllowed: () => {} }),
    guard: () => ({ username: 'admin', role: 'admin' }),
  } as unknown as HttpContext;
}

async function upstream(t: TestContext, listener: RequestListener, snapshotFor = deployed): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/auth/revoke')) { res.writeHead(204); res.end(); return; }
    if (req.url?.endsWith('/auth/token')) { res.setHeader('content-type', 'application/json'); res.end('{"access_token":"test-access","expires_in":3600}'); return; }
    const match = req.url?.match(/^\/red\/([^/]+)\/flows$/);
    if (match) { assert.equal(req.headers.authorization, 'Bearer test-access'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(snapshotFor(match[1]!))); return; }
    listener(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return (server.address() as { port: number }).port;
}

function routes(t: TestContext, ctx: HttpContext) {
  const app = Fastify();
  // Sibling management routes must retain ordinary JSON parsing.
  app.post('/control', async request => ({ isBuffer: Buffer.isBuffer(request.body), data: request.body }));
  registerDeviceIngress(app, ctx);
  t.after(() => app.close());
  return app;
}

function fixture(t: TestContext, port: number) {
  const db = openDb(':memory:'); seed(db);
  t.after(() => db.close());
  const ctx = context(db, port);
  return { db, ctx, app: routes(t, ctx) };
}

function signed(body: string | object = { value: 1 }, options: { secret?: string; nonce?: string; timestamp?: number; path?: string; bindingId?: string; deviceId?: string } = {}) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? 'nonce-aaaaaaaaaaaa';
  const path = options.path ?? PATH;
  const payload = ['POST', path, options.bindingId ?? 'b', options.deviceId ?? 'device-a', timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  return {
    method: 'POST' as const, url: path, payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-thinglinks-timestamp': timestamp,
      'x-thinglinks-nonce': nonce,
      'x-thinglinks-signature': createHmac('sha256', options.secret ?? SECRET).update(payload).digest('hex'),
      authorization: 'Bearer manager-secret-must-not-forward', cookie: 'tle_sid=must-not-forward',
      'x-thinglinks-device-id': 'spoofed',
    },
  };
}

function createBinding(targetPath: string, id = 'new-binding') {
  return { method: 'POST' as const, url: '/api/instances/i/device-http-bindings', payload: { id, targetPath, deviceId: 'device-a' } };
}

test('raw JSON bytes reach only the fixed path; client credentials and forged identity are stripped', async t => {
  let seen: { path: string | undefined; headers: Record<string, unknown>; body: Buffer } | undefined;
  const port = await upstream(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      seen = { path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(202, { 'content-type': 'application/json', 'set-cookie': 'injected=yes', 'access-control-allow-origin': '*' });
      res.end('{"accepted":1}');
    });
  });
  const { app } = fixture(t, port);
  const raw = '{\n  "temperature": 21, "large": 9007199254740993\n}\n';
  const response = await app.inject(signed(raw));
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(response.json(), { accepted: 1 });
  assert.equal(seen?.path, '/red/i/api/device/data');
  assert.equal(seen?.body.toString(), raw);
  assert.equal(seen?.headers.authorization, undefined); assert.equal(seen?.headers.cookie, undefined);
  assert.equal(seen?.headers['x-thinglinks-device-id'], 'device-a');
  assert.equal(seen?.headers['x-thinglinks-instance-id'], 'i');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  const control = await app.inject({ method: 'POST', url: '/control', payload: { hello: 1 } });
  assert.deepEqual(control.json(), { isBuffer: false, data: { hello: 1 } });
});

test('encoded or normalized target paths are refused at create and again at runtime', async t => {
  let calls = 0;
  const port = await upstream(t, (_req, res) => { calls++; res.end(); });
  const { app, db } = fixture(t, port);
  for (const path of ['/red/i/api/%2e%2e/flows', '/red/i/api/%252e%252e/flows', '/red/i/api/../flows', '/red/i/api/./x', '/red/i/api/a%2fb', '/red/i/api//x', '/red/i/api/a\\b', '/red/other/api/x', '//localhost/x', '/red/i/api/x?url=a', '/red/i/api/x#hash', '/red/i/api/ x']) {
    const result = await app.inject(createBinding(path));
    assert.equal(result.statusCode, 400, path);
    db.prepare('UPDATE device_http_binding SET target_path=? WHERE id=\'b\'').run(path);
    assert.equal((await app.inject(signed({}, { nonce: `nonce-${calls}-${'a'.repeat(18)}` }))).statusCode, 400, path);
  }
  assert.equal(calls, 0);
});

test('upstream redirects never reach a second destination', async t => {
  let redirected = 0;
  const destination = await upstream(t, (_req, res) => { redirected++; res.end('internal secret'); });
  const port = await upstream(t, (_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${destination}/admin` }); res.end(); });
  const { app } = fixture(t, port);
  const result = await app.inject(signed());
  assert.equal(result.statusCode, 502, result.body);
  assert.equal(redirected, 0);
  assert.equal(result.headers.location, undefined);
});

test('HTML responses are inert on the Manager origin', async t => {
  const port = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'injected=true', 'content-security-policy': "default-src *" });
    res.end('<script>fetch("/api/instances")</script>');
  });
  const { app } = fixture(t, port);
  const result = await app.inject(signed());
  assert.equal(result.statusCode, 200);
  assert.match(String(result.headers['content-type']), /^text\/plain/);
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.match(String(result.headers['content-security-policy']), /sandbox/);
  assert.match(String(result.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(result.headers['set-cookie'], undefined);
});

test('invalid signatures, device scope, timestamps and modified bytes never enter Node-RED or consume nonce', async t => {
  let calls = 0;
  const port = await upstream(t, (_req, res) => { calls++; res.writeHead(204); res.end(); });
  const { app, db } = fixture(t, port);
  for (const request of [
    signed({}, { secret: 'wrong' }), signed({}, { deviceId: 'other-device' }),
    signed({}, { timestamp: Math.floor(Date.now() / 1000) - 301 }),
    { ...signed(), payload: '{"value": 1}' },
    { ...signed(), headers: { 'content-type': 'application/json' } },
  ]) assert.equal((await app.inject(request)).statusCode, 401);
  assert.equal(calls, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM device_http_nonce').get() as { n: number }).n, 0);
  assert.equal((await app.inject(signed())).statusCode, 204);
});

test('nonce, limits and rotated credentials survive a real file database close and reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tle-ingress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.sqlite');
  const port = await upstream(t, (_req, res) => { res.writeHead(204); res.end(); });
  let db = openDb(file); seed(db);
  let app = routes(t, context(db, port));
  assert.equal((await app.inject(signed())).statusCode, 204);
  const rotated = await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/rotate' });
  assert.equal(rotated.statusCode, 200);
  const secret = rotated.json().secret as string;
  assert.ok(secret); assert.notEqual(secret, SECRET);
  await app.close(); db.close();
  db = openDb(file); app = routes(t, context(db, port));
  t.after(() => db.close());
  assert.equal((await app.inject(signed({}, { secret }))).statusCode, 409);
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }))).statusCode, 401);
  // Pin the current rate bucket so this check remains deterministic at a minute boundary.
  db.prepare('UPDATE device_http_binding SET rate_limit_per_minute=1 WHERE id=\'b\'').run();
  db.prepare('UPDATE device_http_rate SET window_start=? WHERE binding_id=\'b\'').run(Math.floor(Date.now() / 60000) * 60);
  assert.equal((await app.inject(signed({}, { secret, nonce: 'nonce-cccccccccccc' }))).statusCode, 429);
  assert.equal((db.prepare('SELECT request_count FROM device_http_rate').get() as { request_count: number }).request_count, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/instances/i/device-http-bindings/b' })).statusCode, 204);
  assert.equal((await app.inject(signed({}, { secret, nonce: 'nonce-dddddddddddd' }))).statusCode, 404);
});

test('per-instance operation gate remains held through the full upstream response', async t => {
  let respond!: () => void; let arrived!: () => void;
  const entered = new Promise<void>(resolve => { arrived = resolve; });
  const port = await upstream(t, (_req, res) => { respond = () => { res.writeHead(204); res.end(); }; arrived(); });
  const { app, ctx } = fixture(t, port);
  const first = app.inject(signed()); await entered;
  assert.equal(ctx.operationGate.current('i'), 'proxy-write');
  const second = await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }));
  assert.equal(second.statusCode, 409);
  await assert.rejects(ctx.operationGate.run('i', 'upgrade-image', async () => {}));
  respond(); assert.equal((await first).statusCode, 204);
  assert.equal(ctx.operationGate.current('i'), undefined);
});

test('global concurrency cap rejects before allocating another upstream request', async t => {
  const responders: Array<() => void> = [];
  let allArrived!: () => void;
  const ready = new Promise<void>(resolve => { allArrived = resolve; });
  const port = await upstream(t, (_req, res) => {
    responders.push(() => { res.writeHead(204); res.end(); });
    if (responders.length === 16) allArrived();
  });
  const { app, db } = fixture(t, port);
  const pending = [];
  for (let i = 0; i < 16; i++) {
    seed(db, `i${i}`, `b${i}`);
    pending.push(app.inject(signed({}, { path: `/api/device-ingress/b${i}`, bindingId: `b${i}` })));
  }
  await ready;
  const rejected = await app.inject(signed());
  assert.equal(rejected.statusCode, 429);
  for (const respond of responders) respond();
  assert.ok((await Promise.all(pending)).every(result => result.statusCode === 204));
});

test('body limit and unsupported content handling do not leak operation leases', async t => {
  const port = await upstream(t, (_req, res) => { res.writeHead(204); res.end(); });
  const { app, ctx } = fixture(t, port);
  assert.equal((await app.inject(signed({ value: 'x'.repeat(1100) }))).statusCode, 413);
  assert.equal((await app.inject({ ...signed(), headers: { ...signed().headers, 'content-type': 'text/html' } })).statusCode, 415);
  assert.equal((await app.inject({ ...signed(), headers: { ...signed().headers, 'content-encoding': 'gzip' } })).statusCode, 415);
  assert.equal(ctx.operationGate.current('i'), undefined);
  assert.equal((await app.inject(signed())).statusCode, 204);
});

test('create, rotate and revoke roll back when their audit write fails', async t => {
  const port = await upstream(t, (_req, res) => res.end(), id => ({ ...deployed(id), flows: deployed(id).flows.map(n => n.type === 'http in' ? { ...n, url: '/new' } : n) }));
  const { app, db } = fixture(t, port);
  const original = (db.prepare('SELECT secret_enc FROM device_http_binding WHERE id=\'b\'').get() as { secret_enc: string }).secret_enc;
  db.exec("CREATE TRIGGER reject_ingress_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.equal((await app.inject(createBinding('/red/i/api/new'))).statusCode, 500);
  assert.equal(db.prepare('SELECT id FROM device_http_binding WHERE id=\'new-binding\'').get(), undefined);
  assert.equal((await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/rotate' })).statusCode, 500);
  assert.equal((db.prepare('SELECT secret_enc FROM device_http_binding WHERE id=\'b\'').get() as { secret_enc: string }).secret_enc, original);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/instances/i/device-http-bindings/b' })).statusCode, 500);
  assert.ok(db.prepare('SELECT id FROM device_http_binding WHERE id=\'b\'').get());
});

test('management calls require instance-scoped permissions and never return stored secrets', async t => {
  const { app, ctx } = fixture(t, 1);
  const calls: unknown[] = [];
  ctx.guard = (_req, reply, options) => { calls.push(options); reply.code(403).send({ error: 'denied' }); return undefined; };
  assert.equal((await app.inject(createBinding('/red/i/api/new'))).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/rotate' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/instances/i/device-http-bindings/b' })).statusCode, 403);
  assert.deepEqual(calls, Array(3).fill({ csrf: true, need: 'instance:operate', instance: 'i' }));
  ctx.guard = () => ({ username: 'admin', role: 'admin', mustChangePassword: false, mustEnroll2fa: false, totpEnabled: false });
  const list = await app.inject('/api/instances/i/device-http-bindings');
  assert.equal(list.json().bindings[0].secret, undefined);
  assert.equal(list.json().bindings[0].secretEnc, undefined);
  assert.equal(list.body.includes(SECRET), false);
});

test('upstream timeout aborts and releases the operation lease; retries need a new nonce', async t => {
  let hang = true;
  const port = await upstream(t, (_req, res) => {
    if (hang) { res.writeHead(200); res.write('partial'); }
    else { res.writeHead(204); res.end(); }
  });
  const { app, ctx } = fixture(t, port);
  const response = await app.inject(signed());
  assert.equal(response.statusCode, 504, response.body);
  assert.equal(ctx.operationGate.current('i'), undefined);
  hang = false;
  assert.equal((await app.inject(signed())).statusCode, 409);
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }))).statusCode, 204);
});

test('oversize responses are cancelled and leases released', async t => {
  const port = await upstream(t, (_req, res) => { res.end('x'.repeat(1024 * 1024 + 1)); });
  const { app, ctx } = fixture(t, port);
  assert.equal((await app.inject(signed())).statusCode, 502);
  assert.equal(ctx.operationGate.current('i'), undefined);
});

test('no query rewrite, missing instance or payload over the absolute limit is forwarded', async t => {
  let calls = 0;
  const port = await upstream(t, (_req, res) => { calls++; res.end(); });
  const { app, ctx } = fixture(t, port);
  assert.equal((await app.inject(signed({}, { path: `${PATH}?target=admin` }))).statusCode, 400);
  assert.equal((await app.inject(signed('x'.repeat(8 * 1024 * 1024 + 1)))).statusCode, 413);
  ctx.repo.get = () => undefined;
  assert.equal((await app.inject(signed())).statusCode, 404);
  assert.equal(calls, 0);
});

test('only properly typed binding settings and valid signed UTF-8 JSON are accepted', async t => {
  let calls = 0;
  const port = await upstream(t, (_req, res) => { calls++; res.end(); });
  const { app } = fixture(t, port);
  for (const field of ['maxBodyBytes', 'rateLimitPerMinute']) {
    for (const value of [null, true, '1024', {}, []]) {
      const request = createBinding('/red/i/api/new');
      assert.equal((await app.inject({ ...request, payload: { ...request.payload, [field]: value } })).statusCode, 400, `${field} ${String(value)}`);
    }
  }
  for (const deviceId of [123, true, null, {}, []]) {
    const request = createBinding('/red/i/api/new');
    assert.equal((await app.inject({ ...request, payload: { ...request.payload, deviceId } })).statusCode, 400);
  }
  for (const payload of ['{ "unterminated": ', Buffer.from([123,34,120,34,58,34,0xc3,0x28,34,125])]) {
    assert.equal((await app.inject(signed(payload))).statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('a slow sender has an absolute body deadline even while bytes keep arriving', async t => {
  const db = openDb(':memory:'); seed(db); t.after(() => db.close());
  const app = Fastify();
  registerDeviceIngress(app, context(db, 1), { bodyReceiveTimeoutMs: 100 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const port = (app.server.address() as { port: number }).port;
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  let response = '';
  const finished = new Promise<void>(resolve => { socket.on('data', chunk => { response += String(chunk); }); socket.on('close', resolve); });
  socket.write('POST /api/device-ingress/b HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n');
  const tick = setInterval(() => socket.write(' '), 10);
  const stop = setTimeout(() => socket.destroy(), 1500);
  try {
    await finished;
    assert.match(response, /HTTP\/1.1 408/);
  } finally { clearInterval(tick); clearTimeout(stop); }
});

test('a binding can only be created against a deployed HTTP path for its exact managed device', async t => {
  const port = await upstream(t, (_req, res) => { res.end(); });
  const { app } = fixture(t, port);
  const badDevice = createBinding('/red/i/api/device/data', 'new-device');
  const mismatch = await app.inject({ ...badDevice, payload: { ...badDevice.payload, deviceId: 'other-device' } });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal((await app.inject(createBinding('/red/i/api/not-deployed'))).statusCode, 400);
});

test('deploying a different device behind the same path invalidates the old binding before data forwarding', async t => {
  let snapshot = deployed('i'); let calls = 0;
  const port = await upstream(t, (_req, res) => { calls++; res.writeHead(204); res.end(); }, () => snapshot);
  const { app, db } = fixture(t, port);
  assert.equal((await app.inject(signed())).statusCode, 204);
  snapshot = { ...snapshot, rev: 'rev-2', flows: snapshot.flows.map(node => node.type === 'tl-device' ? { ...node, deviceId: 'device-b' } : node) };
  const changed = await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }));
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(calls, 1);
  assert.equal((db.prepare('SELECT count(*) n FROM device_http_nonce').get() as { n: number }).n, 1);
  // Hash mismatch fails closed even when an upstream incorrectly reuses a revision.
  snapshot.rev = 'rev-1';
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-cccccccccccc' }))).statusCode, 409);
  db.prepare("UPDATE device_http_binding SET flow_revision='' WHERE id='b'").run();
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-dddddddddddd' }))).statusCode, 409);
});

test('disabled, ambiguous, linked and unregistered device flows cannot establish bindings', async t => {
  let snapshot = deployed('i');
  const port = await upstream(t, (_req, res) => res.end(), () => snapshot);
  const { app } = fixture(t, port);
  const original = deployed('i');
  const cases = [
    original.flows.map(n => n.type === 'tab' ? { ...n, disabled: true } : n),
    original.flows.map(n => n.type === 'tl-device' ? { ...n, type: 'debug' } : n),
    [...original.flows, { ...original.flows[1]!, id: 'duplicate' }],
    original.flows.map(n => n.type === 'tl-device' ? { ...n, type: 'link out' } : n),
    original.flows.map(n => n.type === 'http in' ? { ...n, url: '/:name' } : n),
    [...original.flows.map(n => n.type === 'tl-device' ? { ...n, wires: [['second']] } : n), { id: 'second', type: 'tl-device', z: 'tab', deviceId: 'device-a', wires: [] }],
  ];
  for (const flows of cases) {
    snapshot = { rev: 'revision', flows };
    const created = await app.inject(createBinding('/red/i/api/device/data', 'test-create'));
    assert.equal(created.statusCode, 400, created.body);
  }
});

test('flow verification rejects authentication failure, redirects and oversized admin responses', async t => {
  let mode = 'auth-fail'; let flowRequests = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(mode === 'auth-fail' ? 401 : 200, { 'content-type': 'application/json' });
      res.end('{"access_token":"token","expires_in":3600}'); return;
    }
    flowRequests++;
    if (mode === 'redirect') { res.writeHead(302, { location: '/internal-secret' }); res.end(); }
    else res.end(JSON.stringify({ rev: 'same', flows: [{ id: 'oversize', type: 'comment', name: 'x'.repeat(1048576) }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const { app } = fixture(t, (server.address() as { port: number }).port);
  assert.equal((await app.inject(signed())).statusCode, 502);
  assert.equal(flowRequests, 0, 'no anonymous fallback to the flows API');
  mode = 'redirect';
  assert.equal((await app.inject(signed())).statusCode, 502);
  assert.equal(flowRequests, 1, 'the redirect destination must never be fetched');
  mode = 'oversize';
  assert.equal((await app.inject(signed())).statusCode, 502);
});

test('case and trailing-slash HTTP route aliases cannot shadow a device binding', async t => {
  let snapshot = deployed('i');
  const port = await upstream(t, (_req, res) => res.end(), () => snapshot);
  const { app } = fixture(t, port);
  for (const url of ['/Device/data', '/device/data/', '/device/../data', '/device//data']) {
    snapshot = { rev: 'alias', flows: [...deployed('i').flows,
      { id: 'shadow-input', type: 'http in', z: 'tab', url, method: 'post', wires: [['shadow-device']] },
      { id: 'shadow-device', type: 'tl-device', z: 'tab', deviceId: 'other-device', wires: [] },
    ] };
    const result = await app.inject(createBinding('/red/i/api/device/data', 'alias-binding'));
    assert.equal(result.statusCode, 400, url);
  }
});

test('native admin token is reused, snapshots stay fresh, and replay or quota rejection never reads Admin API', async t => {
  let auth = 0; let reads = 0; let forwards = 0; let revoked = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/auth/token')) { auth++; res.end(JSON.stringify({ access_token: `token-${auth}`, expires_in: 604800 })); }
    else if (req.url?.endsWith('/auth/revoke')) { revoked++; res.writeHead(204); res.end(); }
    else if (req.url?.endsWith('/flows')) { reads++; res.end(JSON.stringify(deployed('i'))); }
    else { forwards++; res.writeHead(204); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const { app, db } = fixture(t, (server.address() as { port: number }).port);
  assert.equal((await app.inject(signed())).statusCode, 204);
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }))).statusCode, 204);
  assert.deepEqual([auth, reads, forwards], [1, 2, 2]);
  assert.equal((await app.inject(signed())).statusCode, 409);
  assert.equal((await app.inject(signed({}, { secret: 'wrong' }))).statusCode, 401);
  db.prepare("UPDATE device_http_binding SET rate_limit_per_minute=2 WHERE id='b'").run();
  db.prepare("UPDATE device_http_rate SET window_start=? WHERE binding_id='b'").run(Math.floor(Date.now() / 60000) * 60);
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-cccccccccccc' }))).statusCode, 429);
  assert.deepEqual([auth, reads, forwards], [1, 2, 2]);
  await app.close(); assert.equal(revoked, 1);
});

test('native 401 clears only the rejected token and retries once; persistent 401 does not loop', async t => {
  let auth = 0; let reads = 0; let revoked = 0; let alwaysReject = false;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/auth/token')) { auth++; res.end(JSON.stringify({ access_token: `token-${auth}`, expires_in: 3600 })); }
    else if (req.url?.endsWith('/auth/revoke')) { revoked++; res.writeHead(204); res.end(); }
    else if (req.url?.endsWith('/flows')) {
      reads++;
      if (alwaysReject || req.headers.authorization === 'Bearer token-1') { res.writeHead(401); res.end('{}'); }
      else res.end(JSON.stringify(deployed('i')));
    } else { res.writeHead(204); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const { app } = fixture(t, (server.address() as { port: number }).port);
  assert.equal((await app.inject(signed())).statusCode, 204);
  assert.deepEqual([auth, reads, revoked], [2, 2, 1]);
  alwaysReject = true;
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }))).statusCode, 502);
  assert.deepEqual([auth, reads, revoked], [3, 4, 3]);
});

test('explicit flow revalidation restores an unchanged device using its existing secret and nonce history', async t => {
  let snapshot = deployed('i');
  const port = await upstream(t, (_req, res) => { res.writeHead(204); res.end(); }, () => snapshot);
  const { app, db } = fixture(t, port);
  const before = db.prepare("SELECT * FROM device_http_binding WHERE id='b'").get() as Record<string, unknown>;
  assert.equal((await app.inject(signed())).statusCode, 204);
  snapshot = { ...snapshot, rev: 'revision-new' };
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }))).statusCode, 409);
  const confirmed = await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/revalidate' });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().binding.requiresRebind, false);
  assert.equal(confirmed.json().secret, undefined);
  const after = db.prepare("SELECT * FROM device_http_binding WHERE id='b'").get() as Record<string, unknown>;
  assert.notEqual(after.flow_revision, before.flow_revision);
  assert.deepEqual({ ...after, flow_revision: before.flow_revision }, before, 'only flow_revision changes');
  assert.equal((await app.inject(signed({}, { nonce: 'nonce-bbbbbbbbbbbb' }))).statusCode, 204, 'same original device secret remains valid');
  assert.equal((await app.inject(signed())).statusCode, 409, 'revalidation never discards replay protection');
  assert.equal((db.prepare("SELECT count(*) n FROM audit WHERE action='device-http-binding-revalidate'").get() as { n: number }).n, 1);
});

test('revalidation never accepts a replacement device or changed receiving path', async t => {
  let snapshot = deployed('i');
  const port = await upstream(t, (_req, res) => res.end(), () => snapshot);
  const { app, db } = fixture(t, port);
  const before = db.prepare("SELECT flow_revision,secret_enc FROM device_http_binding WHERE id='b'").get();
  for (const type of ['tl-device', 'http in']) {
    snapshot = { rev: 'new', flows: deployed('i').flows.map(node => node.type === type
      ? type === 'tl-device' ? { ...node, deviceId: 'device-b' } : { ...node, url: '/other/path' }
      : node) };
    const result = await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/revalidate' });
    assert.equal(result.statusCode, 400, result.body);
    assert.deepEqual(db.prepare("SELECT flow_revision,secret_enc FROM device_http_binding WHERE id='b'").get(), before);
  }
});

test('revalidation requires instance operate with CSRF and rolls back when its audit fails', async t => {
  const port = await upstream(t, (_req, res) => res.end(), () => ({ ...deployed('i'), rev: 'new' }));
  const { app, db, ctx } = fixture(t, port);
  const request = { method: 'POST' as const, url: '/api/instances/i/device-http-bindings/b/revalidate' };
  const guard = ctx.guard;
  const calls: unknown[] = [];
  ctx.guard = (_req, reply, options) => { calls.push(options); reply.code(403).send({ error: 'CSRF or permission denied' }); return undefined; };
  assert.equal((await app.inject(request)).statusCode, 403);
  assert.deepEqual(calls, [{ csrf: true, need: 'instance:operate', instance: 'i' }]);
  ctx.guard = guard;
  const before = db.prepare("SELECT * FROM device_http_binding WHERE id='b'").get();
  db.exec("CREATE TRIGGER reject_revalidation_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.equal((await app.inject(request)).statusCode, 500);
  assert.deepEqual(db.prepare("SELECT * FROM device_http_binding WHERE id='b'").get(), before);
});

test('revalidation CAS rejects rotation, deletion and recreation during the native flow read', async t => {
  let mutate: (() => void) | undefined;
  const port = await upstream(t, (_req, res) => res.end(), () => { mutate?.(); return { ...deployed('i'), rev: 'new' }; });
  const { app, db } = fixture(t, port);
  const original = db.prepare("SELECT * FROM device_http_binding WHERE id='b'").get() as Record<string, unknown>;
  const restore = () => {
    db.prepare("DELETE FROM device_http_binding WHERE id='b'").run();
    db.prepare(`INSERT INTO device_http_binding(id,instance_id,target_path,device_id,secret_enc,max_body_bytes,rate_limit_per_minute,flow_revision)
      VALUES('b','i','/red/i/api/device/data','device-a',?,1024,60,?)`).run(original.secret_enc, original.flow_revision);
  };
  for (const mutation of [
    () => db.prepare("UPDATE device_http_binding SET secret_enc=? WHERE id='b'").run(encryptSecret('rotated', KEY)),
    () => db.prepare("DELETE FROM device_http_binding WHERE id='b'").run(),
    () => { restore(); db.prepare("UPDATE device_http_binding SET secret_enc=? WHERE id='b'").run(encryptSecret('recreated', KEY)); },
  ]) {
    restore(); mutate = mutation;
    const result = await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/revalidate' });
    assert.equal(result.statusCode, 409, result.body);
    const row = db.prepare("SELECT flow_revision FROM device_http_binding WHERE id='b'").get() as { flow_revision: string } | undefined;
    if (row) assert.equal(row.flow_revision, original.flow_revision);
  }
  assert.equal((db.prepare("SELECT count(*) n FROM audit WHERE action='device-http-binding-revalidate'").get() as { n: number }).n, 0);
});

test('legacy URL-only bindings can confirm the deployed device without replacing credentials', async t => {
  const port = await upstream(t, (_req, res) => { res.writeHead(204); res.end(); });
  const { app, db } = fixture(t, port);
  db.prepare("UPDATE device_http_binding SET flow_revision='' WHERE id='b'").run();
  assert.equal((await app.inject(signed())).statusCode, 409);
  const confirmed = await app.inject({ method: 'POST', url: '/api/instances/i/device-http-bindings/b/revalidate' });
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await app.inject(signed())).statusCode, 204);
});
