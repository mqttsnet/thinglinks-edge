import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NetworkIntentStore, NETWORK_POLICY_OP_LABEL, NETWORK_POLICY_REALM_LABEL } from './network-intents.ts';
import { NetworkCoordinator, type NetworkDaemon } from './network-coordinator.ts';
import { NETWORK_POLICY_DEFAULTS, deploymentRealm, type PolicyConfig } from './config.ts';
import type { NetworkGuardClient } from './network-guard.ts';

const id = 'a'.repeat(64), labels = { 'com.mqttsnet.thinglinks-edge.managed': 'true', 'com.mqttsnet.thinglinks-edge.instance': 'line-a' };
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tle-net-coord-'))); mkdirSync(join(root, 'data'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: PolicyConfig = { ...NETWORK_POLICY_DEFAULTS, dataRoot: join(root, 'data'), stateRoot: root,
    networkPrefix: 'tle-net', managerContainer: 'tle-manager', imageRepo: 'nodered/node-red', allowedTags: ['5.0.4-24-minimal'],
    allowedImageIds: [], portRange: { min: 30000, max: 30999 } };
  const store = new NetworkIntentStore(join(root, 'intents'));
  const networks = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const daemon: NetworkDaemon = {
    json: async path => {
      if (path === '/networks') return [...networks.values()];
      const ref = path.slice('/networks/'.length);
      const found = networks.get(ref) ?? [...networks.values()].find(value => value['Name'] === ref);
      if (!found) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return found;
    },
    deleteNetwork: async networkId => { calls.push(`delete:${networkId}`); networks.delete(networkId); },
  };
  const guard: NetworkGuardClient = {
    assertAvailable: async () => { calls.push('available'); },
    register: async descriptor => { calls.push(`register:${descriptor.networkId}`); },
    assertReady: async networkId => { calls.push(`ready:${networkId}`); },
    unregister: async networkId => { calls.push(`unregister:${networkId}`); },
  };
  const coordinator = new NetworkCoordinator(config, daemon, guard, store, { timeoutMs: 20, intervalMs: 1 });
  const add = (body: Record<string, unknown>) => networks.set(id, { Id: id, Name: 'tle-net-line-a', Labels: body['Labels'],
    Driver: 'bridge', EnableIPv6: false, Internal: false, Options: {}, Containers: {},
    IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] } });
  return { config, store, networks, calls, daemon, guard, coordinator, add };
}

test('creation is journaled before dispatch and committed only after exact network rules are ready', async t => {
  const f = fixture(t);
  const operation = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  assert.equal(f.store.pending().length, 1);
  assert.equal(typeof (operation.body['Labels'] as Record<string, unknown>)[NETWORK_POLICY_OP_LABEL], 'string');
  f.add(operation.body);
  await operation.succeeded({ Id: id });
  assert.equal(f.store.pending().length, 0);
  assert.ok(f.calls.indexOf(`register:${id}`) < f.calls.indexOf(`ready:${id}`));
  await assert.rejects(f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels }));
  assert.equal(f.store.pending().length, 0);
});

test('registration failure compensates only the captured empty network and preserves uncertainty', async t => {
  const f = fixture(t);
  const operation = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  f.add(operation.body);
  f.guard.register = async () => { throw new Error('test backend failure'); };
  await assert.rejects(operation.succeeded({ Id: id }));
  await operation.failed(true);
  assert.deepEqual(f.calls.slice(-2), [`unregister:${id}`, `delete:${id}`]);
  assert.equal(f.store.pending().length, 0);
  const uncertain = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  await assert.rejects(uncertain.failed(true));
  assert.equal(f.store.pending().length, 1, 'absence cannot prove a dispatched daemon call never creates later');
});

test('known undispatched work can be cancelled and foreign or nonempty resources are never deleted', async t => {
  const f = fixture(t);
  const operation = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  await operation.failed(false); assert.equal(f.store.pending().length, 0);
  const next = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  f.add(next.body); f.networks.get(id)!['Containers'] = { foreign: {} };
  await assert.rejects(next.failed(true));
  assert.equal(f.calls.some(value => value.startsWith('delete:')), false);
});

test('deletion unregisters before dispatch and restores protection if daemon deletion fails', async t => {
  const f = fixture(t);
  const creation = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  f.add(creation.body); await creation.succeeded({ Id: id });
  f.calls.length = 0;
  const deletion = await f.coordinator.prepareDelete(f.networks.get(id)!);
  await deletion.beforeDispatch(); assert.deepEqual(f.calls, [`unregister:${id}`]);
  await deletion.failed(true);
  assert.ok(f.calls.includes(`register:${id}`)); assert.equal(f.store.pending().length, 0);
});

test('busy readiness can recover, but cancellation before admission makes no Docker or journal write', async t => {
  const f = fixture(t);
  let attempts = 0;
  f.guard.assertAvailable = async () => { if (++attempts < 3) throw new Error('busy'); };
  const operation = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  assert.equal(attempts, 3); await operation.failed(false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels }, abort.signal));
  assert.equal(f.store.pending().length, 0);
  assert.equal(f.networks.size, 0);
  assert.equal(f.calls.some(call => call.startsWith('delete:')), false);
});

test('an uncertain A intent fences A while B remains ready and recovery does not discard A', async t => {
  const f = fixture(t);
  const pendingA = await f.coordinator.prepareCreate({ Name: 'tle-net-line-a', Driver: 'bridge', EnableIPv6: false, Labels: labels });
  const bId = 'b'.repeat(64);
  const b = { Id: bId, Name: 'tle-net-line-b', Driver: 'bridge', EnableIPv6: false, Internal: false, Options: {}, Containers: {},
    Labels: { ...labels, 'com.mqttsnet.thinglinks-edge.instance': 'line-b', [NETWORK_POLICY_OP_LABEL]: 'b'.repeat(32),
      [NETWORK_POLICY_REALM_LABEL]: deploymentRealm(f.config) }, IPAM: { Config: [{ Subnet: '172.31.0.0/24', Gateway: '172.31.0.1' }] } };
  f.networks.set(bId, b);
  assert.deepEqual(await f.coordinator.recoverPending(), { recovered: 0, pending: 1 });
  assert.equal((await f.coordinator.ready(b)).networkId, bId);
  f.add(pendingA.body);
  await assert.rejects(f.coordinator.ready(f.networks.get(id)!));
  assert.equal((await f.coordinator.ready(b)).networkId, bId);
  assert.equal(f.store.pending().length, 1);
});
