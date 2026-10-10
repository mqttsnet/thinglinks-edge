import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { openDb } from '../core/db.ts';
import { tarArchive } from '../core/archive/tar.ts';
import { AuthService } from '../core/auth/service.ts';
import { UserRepo } from '../core/auth/user-repo.ts';
import { deriveKey } from '../core/auth/crypto.ts';
import { InstanceRepo } from '../core/instance/repo.ts';
import { ProxySessionRegistry } from '../core/instance/proxy-session-registry.ts';
import { NodeStore } from '../core/nodes/store.ts';
import { NodeCatalog } from '../core/nodes/catalog.ts';
import type { Catalogue } from '../core/nodes/packument.ts';
import { createContext, type ServerDeps } from './context.ts';
import { registerNpmRegistry } from './nodes/registry.ts';
import { registerEditorOriginGate, startEditorOriginServers } from './editor-origin-server.ts';

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

for (const basePath of ['', '/nodered']) test(`runtime catalogue requires its own instance unlock and preserves the original metadata (${basePath || 'root'})`, { timeout: 10_000 }, async (t) => {
  const port = await availablePort();
  const db = openDb(':memory:');
  const auth = new AuthService(db);
  auth.createFirstAdmin('admin', 'local-admin-fixture-password');
  const users = new UserRepo(db);
  const initial = users.create('alice', 'operator', 'admin');
  auth.changePassword('alice', initial, 'local-fixture-user-password');
  const login = auth.login('alice', 'local-fixture-user-password'); assert.ok('sid' in login);
  const repo = new InstanceRepo(db, deriveKey('catalogue-fixture-key', 'instance'));
  for (const id of ['line-a', 'line-b']) {
    repo.create({ id, name: `private-${id}-name`, imageTag: '5.0.4-24-minimal', memLimit: 512, cpuLimit: 0.5,
      adminRoot: `${basePath}/red/${id}/`, credSecret: `fixture-generation-${id}`, notes: '' }, [],
    [{ username: 'admin', password: 'local-editor-fixture-password', permissions: '*' }]);
    users.grant('alice', id, 'operate', 'admin');
  }
  const registry = new ProxySessionRegistry();
  const ctx = createContext({ db, auth, repo, proxySessions: registry,
    config: { externalUrl: `http://127.0.0.1:19100${basePath}`, basePath, allowedOrigins: ['http://127.0.0.1:19100'],
      editorPortRange: { min: port, max: port } } } as unknown as ServerDeps);
  const origin = ctx.editorOrigins.origin('line-a');
  const storeRoot = mkdtempSync(join(tmpdir(), 'tle-runtime-catalogue-'));
  const store = new NodeStore(storeRoot);
  store.add(gzipSync(tarArchive([{ name: 'package/package.json', content: JSON.stringify({ name: 'node-red-contrib-fixture', version: '1.0.0',
    description: 'Public fixture metadata', 'node-red': { nodes: { 'fixture-input': 'fixture.js' } } }) }])));
  const catalog = new NodeCatalog(db);
  catalog.approve({ module: 'node-red-contrib-fixture', actor: 'admin', note: 'private-approval-note' });
  const app = Fastify();
  app.register(cookie);
  registerEditorOriginGate(app, ctx);
  app.register(async api => {
    registerNpmRegistry(api, ctx, { store, catalog, internalBase: `http://internal-manager:19100${basePath}/npm/` });
    api.get(`${basePath}/api/users`, async () => ({ users: ['private-user-data'] }));
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const managerAddress = app.server.address(); assert.ok(managerAddress && typeof managerAddress === 'object');
  const listeners = await startEditorOriginServers(app, { host: '127.0.0.1', portRange: ctx.editorOrigins.portRange });
  t.after(async () => { await listeners.close(); await app.close(); ctx.disposeEditorSessions(); db.close(); rmSync(storeRoot, { recursive: true, force: true }); });
  const path = `${basePath}/npm/-/catalogue.json`;
  const mainCatalogue = await fetch(`http://127.0.0.1:${managerAddress.port}${path}`).then(r => r.json()) as Catalogue;
  const headers = { cookie: `tle_sid=${login.sid}`, origin };
  ctx.editorAccess.grant({ sessionId: login.sid, username: 'alice', instanceId: 'line-a', scope: '*' });
  assert.equal((await fetch(`${origin}${path}`, { headers })).status, 200, 'an authenticated unlocked editor must load its catalogue');
  ctx.editorAccess.revokeSession(login.sid, 'line-a');
  assert.equal((await fetch(`${origin}${path}`)).status, 401);
  assert.equal((await fetch(`${origin}${path}`, { headers })).status, 403);
  ctx.editorAccess.grant({ sessionId: login.sid, username: 'alice', instanceId: 'line-b', scope: '*' });
  assert.equal((await fetch(`${origin}${path}`, { headers })).status, 403, 'unlocking another instance must not authorize this port');
  ctx.editorAccess.grant({ sessionId: login.sid, username: 'alice', instanceId: 'line-a', scope: '*' });
  const response = await fetch(`${origin}${path}?_cache=fixture`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const metadata = await response.json() as Catalogue;
  // The catalogue envelope timestamps each response; package metadata is unchanged.
  assert.ok(Number.isFinite(Date.parse(metadata.updated_at)));
  assert.deepEqual({ ...metadata, updated_at: mainCatalogue.updated_at }, mainCatalogue);
  assert.deepEqual(metadata.modules.map((entry: { id: string }) => entry.id), ['node-red-contrib-fixture']);
  assert.doesNotMatch(JSON.stringify(metadata), /private-line|private-user-data|private-approval-note|internal-manager/);
  assert.equal((await fetch(`${origin}${path}`, { method: 'HEAD', headers })).status, 200);
  for (const forbidden of [`${basePath}/npm/`, `${basePath}/npm/node-red-contrib-fixture`, `${path}/`, `${basePath}/api/users`, `${basePath}/api/nodes`]) {
    assert.equal((await fetch(`${origin}${forbidden}`, { headers })).status, 404, forbidden);
  }
  assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${origin}${path}`, { headers: { ...headers, origin: 'http://127.0.0.1:19100' } })).status, 403);
  assert.equal((await fetch(`${origin}${path}`, { headers: { cookie: headers.cookie, 'sec-fetch-site': 'same-site' } })).status, 403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = request(`${origin}${path}`, { headers: { ...headers, host: 'untrusted-host.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.once('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  ctx.editorAccess.revokeSession(login.sid, 'line-a');
  assert.equal((await fetch(`${origin}${path}`, { headers })).status, 403);
  ctx.editorAccess.grant({ sessionId: login.sid, username: 'alice', instanceId: 'line-a', scope: '*' });
  users.revoke('alice', 'line-a');
  assert.equal((await fetch(`${origin}${path}`, { headers })).status, 403, 'a remaining editor lease cannot bypass current instance permissions');
});
