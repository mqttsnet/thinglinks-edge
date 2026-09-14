import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkIsolationController, type FirewallPort } from './controller.ts';
import { parseDescriptor, type NetworkDescriptor } from './descriptor.ts';
import type { DescriptorStore } from './store.ts';
import { NetworkOwnershipError } from './firewall.ts';
import type { KernelSnapshot } from './firewall.ts';

const a = parseDescriptor({ networkId: 'a'.repeat(64), cidr: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'br-aaaaaaaaaaaa', ipv6Enabled: false, protectedHosts: [], peerCIDRs: [], allowedHostEndpoints: [] });
const b = parseDescriptor({ ...a, networkId: 'b'.repeat(64), cidr: '172.24.0.0/16', gateway: '172.24.0.1', bridge: 'br-bbbbbbbbbbbb' });
class Store implements DescriptorStore {
  values: NetworkDescriptor[] = []; failSave = false;
  async load() { return structuredClone(this.values); }
  async save(values: readonly NetworkDescriptor[]) { if (this.failSave) throw Error('disk full'); this.values = structuredClone([...values]); }
}
class Firewall implements FirewallPort {
  missing = new Set<string>(); conflicts = new Set<string>(); lateConflict = '';
  assertOwnership(_snapshot: KernelSnapshot, descriptor: NetworkDescriptor) { if (this.conflicts.has(descriptor.networkId)) throw new NetworkOwnershipError(); }
  installed = new Map<string, string>(); failInstall = ''; failRemove = false; installs: string[] = []; supported = true;
  async snapshot(): Promise<KernelSnapshot> { return { backendReady: this.supported, localHosts: [], filter: '', interfaces: new Map() }; }
  sourcePresent(_snapshot: KernelSnapshot, descriptor: NetworkDescriptor) { return !this.missing.has(descriptor.networkId); }
  bridgeMatches(_snapshot: KernelSnapshot, descriptor: NetworkDescriptor) { return this.supported && !this.missing.has(descriptor.networkId); }
  ready(snapshot: KernelSnapshot, value: NetworkDescriptor) { return snapshot.backendReady && this.installed.get(value.networkId) === JSON.stringify(value); }
  async install(value: NetworkDescriptor) { this.installs.push(value.networkId); if (this.lateConflict === value.networkId) { this.conflicts.add(value.networkId); throw new NetworkOwnershipError(); } if (this.failInstall === value.networkId) throw Error('kernel install failed'); this.installed.set(value.networkId, JSON.stringify(value)); }
  async remove(value: NetworkDescriptor) { if (this.failRemove) throw Error('kernel cleanup failed'); this.installed.delete(value.networkId); }
}

test('register protects old peers before advertising the newly registered network as ready', async () => {
  const store = new Store(), firewall = new Firewall(), controller = new NetworkIsolationController(store, firewall);
  await controller.initialize(); await controller.register(a); await controller.register(b);
  assert.equal(await controller.ready(a.networkId), true);
  assert.equal(await controller.ready(b.networkId), true);
  assert.ok(store.values.find(value => value.networkId === a.networkId)!.peerCIDRs.includes(b.cidr));
  assert.ok(store.values.find(value => value.networkId === b.networkId)!.peerCIDRs.includes(a.cidr));
  await controller.unregister(b.networkId);
  assert.ok(store.values[0]!.peerCIDRs.includes(b.cidr), 'removed peer CIDRs stay protected conservatively');
  assert.equal(await controller.ready(b.networkId), false);
});

test('failed peer expansion never grants new-network readiness and persists recovery intent', async () => {
  const store = new Store(), firewall = new Firewall(), controller = new NetworkIsolationController(store, firewall);
  await controller.initialize(); await controller.register(a);
  const old = firewall.installed.get(a.networkId);
  firewall.failInstall = a.networkId;
  await assert.rejects(controller.register(b));
  assert.equal(await controller.ready(b.networkId), false);
  assert.equal(await controller.ready(a.networkId), false);
  assert.equal(firewall.installed.get(a.networkId), old, 'existing DROP policy remains installed');
  assert.equal(store.values.length, 2);
  firewall.failInstall = '';
  const recovered = new NetworkIsolationController(store, firewall);
  await recovered.initialize();
  assert.equal(await recovered.ready(a.networkId), true);
  assert.equal(await recovered.ready(b.networkId), true);
});

test('kernel loss is observed read-only and protection is repaired by explicit reconciliation', async () => {
  let now = 0;
  const store = new Store(), firewall = new Firewall(), controller = new NetworkIsolationController(store, firewall, { now: () => now });
  await controller.initialize(); await controller.register(a);
  assert.equal(await controller.ready(a.networkId), true);
  firewall.installed.delete(a.networkId); now += 2000;
  const count = firewall.installs.length;
  assert.equal(await controller.ready(a.networkId), false);
  assert.equal(firewall.installs.length, count, 'GET readiness itself does not mutate rules');
  await controller.reconcile();
  assert.equal(await controller.ready(a.networkId), true);
});

test('persistence failure precedes kernel mutations and unregister failure retains recovery state', async () => {
  const store = new Store(), firewall = new Firewall(), controller = new NetworkIsolationController(store, firewall);
  await controller.initialize(); store.failSave = true;
  await assert.rejects(controller.register(a)); assert.equal(firewall.installs.length, 0);
  store.failSave = false; await controller.register(a); firewall.failRemove = true;
  await assert.rejects(controller.unregister(a.networkId)); assert.equal(store.values.length, 1);
  assert.equal(await controller.ready(a.networkId), false);
  firewall.failRemove = false; await controller.unregister(a.networkId); await controller.unregister(a.networkId);
  assert.equal(store.values.length, 0);
});

test('an absent source interface stays unready without freezing a healthy new network', async () => {
  const store = new Store(), firewall = new Firewall(), controller = new NetworkIsolationController(store, firewall);
  await controller.initialize(); await controller.register(a);
  firewall.missing.add(a.networkId);
  await controller.register(b);
  assert.equal(await controller.ready(a.networkId), false);
  assert.equal(controller.profileState(a.networkId), 'source-missing');
  assert.equal(await controller.ready(b.networkId), true);
  assert.deepEqual(await controller.health(), { supported: true, recovered: true });
});

test('foreign-chain collisions never publish the losing domain descriptor', async () => {
  const store = new Store(), firewall = new Firewall(), controller = new NetworkIsolationController(store, firewall);
  await controller.initialize(); firewall.conflicts.add(a.networkId);
  await assert.rejects(controller.register(a));
  assert.equal(store.values.length, 0);
  assert.equal(firewall.installs.length, 0);
  firewall.conflicts.clear(); firewall.lateConflict = a.networkId;
  await assert.rejects(controller.register(a));
  assert.equal(store.values.length, 0, 'an atomic creation collision rolls back the new published descriptor');
  assert.equal(controller.descriptor(a.networkId), undefined);
});
