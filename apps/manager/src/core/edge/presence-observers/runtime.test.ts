import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceObserverRuntime } from './runtime.ts';
import { PresenceObservers } from './index.ts';
import { openDb } from '../../db.ts';
import { PresenceSynchronizer } from '../../cloud/presence/synchronizer.ts';
import { FieldRegistry } from '../registry.ts';

test('collector expiry updates the shared aggregate; Docker failure and pause never fence a live process', async () => {
  const stops: string[] = []; const states: unknown[] = [];
  let fail = false; let pendingExpiry = true;
  const runtime = new PresenceObserverRuntime({
    observers: {
      markAllUnknown: () => [],
      listAggregates: () => ['i', 'p', 's'].map(instanceId => ({ instanceId, nodeId: 'd', state: true })),
      activityVersion: () => 0,
      expireLeases: () => pendingExpiry ? (pendingExpiry = false, [{ instanceId: 'i', nodeId: 'd', state: true }]) : [],
      stopInstance: (id: string) => { stops.push(id); return [{ instanceId: id, nodeId: 'd', state: false }]; },
    },
    registry: { setObservedOnline: (_i: string, _d: string, state: boolean) => states.push(['field', state]) },
    presence: { observeAggregate: (_i: string, _d: string, state: boolean | undefined, fresh: boolean) => states.push(['cloud', state, fresh]) },
    listInstances: async () => {
      if (fail) throw new Error('Docker unavailable');
      return [{ id: 'i', running: true, state: 'running' }, { id: 'p', running: false, state: 'paused' }, { id: 's', running: false, state: 'exited' }];
    },
  });
  await runtime.runOnce();
  assert.deepEqual(stops, ['s']);
  assert.deepEqual(states, [['field', true], ['cloud', true, false], ['field', false], ['cloud', false, false]]);
  fail = true; await runtime.runOnce();
  assert.deepEqual(stops, ['s']);
  await runtime.close(); await runtime.runOnce();
  assert.deepEqual(stops, ['s']);
});

test('a delayed stopped-container snapshot cannot fence a newly activated or renewed runtime', async () => {
  let version = 0; let stopCount = 0; let resolve!: (rows: { id: string; running: boolean; state: string }[]) => void;
  const runtime = new PresenceObserverRuntime({
    observers: {
      markAllUnknown: () => [], expireLeases: () => [],
      listAggregates: () => [{ instanceId: 'i', nodeId: 'd', state: true }],
      activityVersion: () => version,
      stopInstance: () => { stopCount++; return []; },
    },
    registry: { setObservedOnline: () => {} }, presence: { observeAggregate: () => {} },
    listInstances: () => new Promise(done => { resolve = done; }),
  });
  const delayed = runtime.runOnce();
  await new Promise(done => setImmediate(done));
  version++; // A successful activation/sample/renew happened while the Docker snapshot was in flight.
  resolve([{ id: 'i', running: false, state: 'exited' }]); await delayed;
  assert.equal(stopCount, 0);
  const current = runtime.runOnce(); await new Promise(done => setImmediate(done));
  resolve([{ id: 'i', running: false, state: 'exited' }]); await current;
  assert.equal(stopCount, 1, 'a subsequent stable stop remains authoritative');
  await runtime.close();
});

test('startup replays retained offline responsibility without reviving cached online evidence', async () => {
  const changes: unknown[] = [];
  const runtime = new PresenceObserverRuntime({
    observers: {
      markAllUnknown: () => [{ instanceId: 'i', nodeId: 'gone', state: false }, { instanceId: 'i', nodeId: 'quiet', state: undefined }],
      expireLeases: () => [], listAggregates: () => [], activityVersion: () => 0, stopInstance: () => [],
    },
    registry: { setObservedOnline: (_i: string, d: string, state: boolean) => changes.push(['field', d, state]) },
    presence: { observeAggregate: (_i: string, d: string, state: boolean | undefined, fresh: boolean) => changes.push(['cloud', d, state, fresh]) },
    listInstances: async () => [{ id: 'i', state: 'running', running: true }],
  });
  runtime.start(); await runtime.runOnce(); await runtime.close();
  assert.deepEqual(changes, [['field', 'gone', false], ['cloud', 'gone', false, false], ['cloud', 'quiet', undefined, false]]);
});

test('retained offline is reconciled after Cloud configuration arrives later than observer startup', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
  const observers = new PresenceObservers(db);
  const scope = { instanceId: 'i', nodeId: 'd', observerId: 'collector' };
  const run = observers.activate(scope, { runNonce: 'run', ticket: observers.challenge(scope, 'run').ticket });
  observers.accept(scope, { kind: 'status', online: false, runNonce: 'run', generation: run.generation, sequence: 1 });
  let configured = false;
  const updates: string[] = [];
  const list = async () => [{ id: 'i', running: true, state: 'running' }];
  const presence = new PresenceSynchronizer({ db, listInstances: list, cloud: {
    status: () => ({ state: configured ? 'online' : 'unconfigured', deviceIdentification: configured ? 'gateway' : '' }),
    onStateChange: () => () => {},
    querySubDevices: async ids => ({ statusCode: 0, data: ids.map(deviceId => ({ deviceId, statusCode: 0, deviceInfo: { gatewayId: 'gateway', nodeType: 2 } })) }),
    updateSubDeviceStatus: async rows => { updates.push(...rows.map(row => row.status)); return { statusCode: 0, data: rows.map(row => ({ deviceId: row.deviceId, statusCode: 0 })) }; },
  } });
  const runtime = new PresenceObserverRuntime({ observers, registry: new FieldRegistry(db), presence, listInstances: list });
  try {
    runtime.start(); await runtime.runOnce(); await presence.runOnce();
    assert.deepEqual(updates, []);
    configured = true; await runtime.runOnce(); await presence.runOnce();
    assert.deepEqual(updates, ['OFFLINE']);
    await runtime.runOnce(); await presence.runOnce();
    assert.deepEqual(updates, ['OFFLINE'], 'reconciliation retains the existing Cloud deduplication');
  } finally { await runtime.close(); await presence.close(); db.close(); }
});
