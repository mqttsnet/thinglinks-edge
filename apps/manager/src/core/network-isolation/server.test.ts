import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { startNetworkIsolationServers, type NetworkControl } from './server.ts';
import { parseDescriptor } from './descriptor.ts';

const a = parseDescriptor({ networkId: 'a'.repeat(64), cidr: '127.0.0.0/8', gateway: '127.0.0.1', bridge: 'br-aaaaaaaaaaaa', ipv6Enabled: false, protectedHosts: [], peerCIDRs: [], allowedHostEndpoints: [] });
const b = parseDescriptor({ ...a, networkId: 'b'.repeat(64), cidr: '172.24.0.0/16', gateway: '172.24.0.1', bridge: 'br-bbbbbbbbbbbb' });
function unix(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let value = ''; res.on('data', part => { value += part; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(value) as Record<string, unknown> }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('Unix mutations stay private while HTTP readiness uses the real source CIDR', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-net-http-'))), socketPath = join(root, 'private', 'control.sock');
  const calls: string[] = [];
  const controller: NetworkControl = {
    descriptor: id => id === a.networkId ? a : id === b.networkId ? b : undefined,
    ready: async () => true, health: async () => ({ supported: true, recovered: true }), profileState: () => 'ready',
    register: async input => { const value = parseDescriptor(input); calls.push('register'); return { registered: true, ready: true, networkId: value.networkId }; },
    unregister: async id => { calls.push('unregister'); return { removed: true, networkId: id }; },
  };
  const servers = await startNetworkIsolationServers(controller, { controlSocket: socketPath, healthHost: '127.0.0.1', healthPort: 0 });
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
    assert.equal((await unix(socketPath, 'GET', '/healthz')).status, 200);
    assert.equal((await unix(socketPath, 'POST', '/networks/register', a)).status, 200);
    assert.equal((await unix(socketPath, 'GET', `/networks/${a.networkId}/ready`)).status, 200);
    const base = `http://127.0.0.1:${servers.healthPort}`;
    const ok = await fetch(`${base}/ready?network=${a.networkId}`);
    assert.equal(ok.status, 200); assert.equal((await ok.json() as { ready: boolean }).ready, true);
    assert.equal((await fetch(`${base}/ready?network=${b.networkId}`, { headers: { 'x-forwarded-for': '172.24.0.2' } })).status, 403);
    assert.equal((await fetch(`${base}/networks/register`, { method: 'POST', body: JSON.stringify(a) })).status, 404);
    assert.equal((await fetch(`${base}/ready?network=${a.networkId}&network=${b.networkId}`)).status, 400);
    assert.deepEqual(calls, ['register']);
    const deleted = await unix(socketPath, 'DELETE', `/networks/${a.networkId}`);
    assert.deepEqual(deleted, { status: 200, body: { removed: true, networkId: a.networkId } });
    assert.equal((await unix(socketPath, 'POST', '/networks/register', { padding: 'x'.repeat(70_000) })).status, 413);
  } finally { await servers.close(); await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(calls, ['register', 'unregister'], 'closing the process listener never unregisters kernel rules');
});

test('HTTP readiness never reports success while registration or recovery is pending', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-net-http-'))), socketPath = join(root, 'private', 'control.sock');
  const controller = { descriptor: () => a, ready: async () => false, health: async () => ({ supported: true, recovered: false }), profileState: () => 'pending' } as unknown as NetworkControl;
  const servers = await startNetworkIsolationServers(controller, { controlSocket: socketPath, healthHost: '127.0.0.1', healthPort: 0 });
  try {
    assert.equal((await unix(socketPath, 'GET', '/healthz')).status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${servers.healthPort}/ready?network=${a.networkId}`)).status, 503);
  } finally { await servers.close(); await rm(root, { recursive: true, force: true }); }
});


test('one real HTTP pipeline cannot consume other source networks readiness slots', async () => {
  const sourceB = Object.values(networkInterfaces()).flatMap(values => values ?? [])
    .find(value => value.family === 'IPv4' && !value.internal && !value.address.startsWith('127.'))?.address;
  assert.ok(sourceB, 'this real-source regression needs one existing non-loopback IPv4; it does not add host aliases');
  const peerB = parseDescriptor({ ...b, cidr: `${sourceB.split('.')[0]}.0.0.0/8`, gateway: sourceB });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-np-'))), socketPath = join(root, 'private', 'control.sock');
  let releaseA!: () => void, requestsA = 0, requestsB = 0;
  const waitingA = new Promise<void>(resolve => { releaseA = resolve; });
  const controller: NetworkControl = {
    descriptor: id => id === a.networkId ? a : id === peerB.networkId ? peerB : undefined,
    ready: async id => { if (id === a.networkId) { requestsA++; await waitingA; } else requestsB++; return true; },
    health: async () => ({ supported: true, recovered: true }), profileState: () => 'ready',
    register: async () => { throw Error('HTTP cannot mutate'); }, unregister: async () => { throw Error('HTTP cannot mutate'); },
  };
  const servers = await startNetworkIsolationServers(controller, { controlSocket: socketPath, healthHost: '127.0.0.1', healthPort: 0 });
  const client = createConnection({ host: '127.0.0.1', port: servers.healthPort });
  let received = '';
  client.on('data', part => { received += part; }); client.on('error', () => undefined);
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > deadline) throw Error('HTTP fixture did not reach expected state'); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
  };
  const fromB = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const req = request({ host: '127.0.0.1', port: servers.healthPort, localAddress: sourceB, path, agent: false, headers }, res => {
      let body = ''; res.on('data', part => { body += part; }); res.on('end', () => resolveResponse({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end();
  });
  try {
    await once(client, 'connect');
    client.write(Array.from({ length: 32 }, () => `GET /ready?network=${a.networkId} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`).join(''));
    await waitFor(() => requestsA >= 4);
    const good = await fromB(`/ready?network=${peerB.networkId}`);
    assert.equal(good.status, 200, 'B must still get readiness while A requests are suspended');
    assert.equal(JSON.parse(good.body).ready, true);
    assert.equal(requestsA, 4, 'A must not occupy all global 32 in-flight kernel checks');
    assert.equal(requestsB, 1);
    assert.equal((await fromB(`/ready?network=${a.networkId}`, { 'x-forwarded-for': '127.0.0.1' })).status, 403);
    assert.equal((await fromB(`/ready?network=${'c'.repeat(64)}`)).status, 503);
    assert.equal(requestsA, 4); assert.equal(requestsB, 1, 'unauthorized and unknown targets never invoke a kernel check');
    releaseA();
    await waitFor(() => (received.match(/HTTP\/1\.1 \d{3}/g) ?? []).length === 32);
    const statuses = [...received.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(match => Number(match[1]));
    assert.equal(statuses.filter(status => status === 200).length, 4);
    assert.equal(statuses.filter(status => status === 429).length, 28);
    const afterDrain = await fetch(`http://127.0.0.1:${servers.healthPort}/ready?network=${a.networkId}`);
    assert.equal(afterDrain.status, 200, 'completed requests release their source budget');
    await afterDrain.arrayBuffer();
    assert.equal(requestsA, 5);
  } finally { releaseA(); client.destroy(); await servers.close(); await rm(root, { recursive: true, force: true }); }
});
