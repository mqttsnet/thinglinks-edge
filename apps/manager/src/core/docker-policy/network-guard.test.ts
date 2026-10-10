import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { buildNetworkDescriptor, UnixNetworkGuardClient, waitForNetworkGuard } from './network-guard.ts';
import type { PolicyConfig } from './config.ts';

const id = 'a'.repeat(64);
const config = { protectedHosts: ['192.168.65.254'], allowedHostEndpoints: [] } as unknown as PolicyConfig;
const network = { Id: id, Driver: 'bridge', EnableIPv6: false, Options: {}, IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] } };

test('network descriptor is derived from independently inspected IPAM and rejects ambiguous networks', () => {
  const descriptor = buildNetworkDescriptor(network, [network, { Id: 'b'.repeat(64), IPAM: { Config: [{ Subnet: '172.31.0.0/24' }] } }], config);
  assert.equal(descriptor.networkId, id); assert.equal(descriptor.bridge, `br-${id.slice(0, 12)}`);
  assert.deepEqual(descriptor.peerCIDRs, ['172.31.0.0/24']);
  for (const patch of [
    { EnableIPv6: true }, { Driver: 'host' }, { Options: { 'com.docker.network.bridge.name': 'docker0' } },
    { IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.31.0.1' }] } },
    { IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }, { Subnet: '172.31.0.0/24', Gateway: '172.31.0.1' }] } },
  ]) assert.throws(() => buildNetworkDescriptor({ ...network, ...patch }, [network], config));
});

test('Unix guard acknowledgements must name the exact network and confirm ready or removal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tlg-')); t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'control.sock');
  let wrongId = false;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ registered: true, ready: true, removed: true, networkId: wrongId ? 'b'.repeat(64) : id }));
  });
  server.listen(socketPath); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new UnixNetworkGuardClient(socketPath);
  const descriptor = buildNetworkDescriptor(network, [network], config);
  await client.register(descriptor); await client.assertReady(id); await client.unregister(id);
  wrongId = true;
  await assert.rejects(client.register(descriptor));
  await assert.rejects(client.assertReady(id));
  await assert.rejects(client.unregister(id));
});

test('transient guard busy is retried, while persistent failure and cancellation stay closed', async () => {
  let calls = 0;
  await waitForNetworkGuard(async () => { if (++calls < 3) throw new Error('busy'); }, undefined, { timeoutMs: 100, intervalMs: 1 });
  assert.equal(calls, 3);
  await assert.rejects(waitForNetworkGuard(async () => { throw new Error('not ready'); }, undefined, { timeoutMs: 10, intervalMs: 1 }));
  const cancelled = new AbortController(); cancelled.abort();
  let writes = 0;
  await assert.rejects(waitForNetworkGuard(async () => { writes++; }, cancelled.signal, { timeoutMs: 100, intervalMs: 1 }));
  assert.equal(writes, 0);
});
