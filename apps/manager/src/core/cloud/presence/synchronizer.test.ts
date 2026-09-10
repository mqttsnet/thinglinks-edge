import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db.ts';
import { PresenceSynchronizer, type PresenceCloud } from './synchronizer.ts';

const queryItem = (deviceId: string, gatewayId = 'g', nodeType = 2) => ({ deviceId, statusCode: 0, deviceInfo: { gatewayId, nodeType, productIdentification: 'p' } });
const result = (ids: string[]) => ({ statusCode: 0, data: ids.map(deviceId => ({ deviceId, statusCode: 0 })) });
function fixture(db = openDb(':memory:')) {
  let now = 1_000;
  const state = { deviceIdentification: 'g', state: 'online' };
  let instances = [{ id: 'i', running: true }, { id: 'j', running: true }];
  const listeners = new Set<() => void>();
  const queries: string[][] = [];
  const updates: { deviceId: string; status: string }[][] = [];
  const errors: string[] = [];
  const cloud: PresenceCloud = {
    status: () => state,
    onStateChange: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    querySubDevices: async ids => { queries.push(ids); return { statusCode: 0, data: ids.map(id => queryItem(id, state.deviceIdentification)) }; },
    updateSubDeviceStatus: async statuses => { updates.push(statuses); return result(statuses.map(x => x.deviceId)); },
  };
  const sync = new PresenceSynchronizer({ db, cloud, listInstances: async () => instances, now: () => now, onError: e => { errors.push(e); }, intervalMs: 5 });
  return { db, sync, cloud, queries, updates, errors, state, listeners,
    time: (value: number) => { now = value; }, instances: (value: typeof instances) => { instances = value; },
    change: (gateway: string, connected = true) => { state.deviceIdentification = gateway; state.state = connected ? 'online' : 'offline'; for (const fn of listeners) fn(); },
  };
}

test('live observations coalesce, verify ownership and refresh at a bounded interval without quiet-device expiry', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 1000; i++) f.sync.observeUplink('i', 'd');
    await f.sync.runOnce();
    assert.deepEqual(f.queries, [['d']]);
    assert.deepEqual(f.updates, [[{ deviceId: 'd', status: 'ONLINE' }]]);
    f.time(20_000); await f.sync.runOnce(); assert.equal(f.updates.length, 1);
    f.time(301_001); await f.sync.runOnce(); assert.equal(f.updates.length, 1, 'silence must not fabricate a heartbeat');
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce(); assert.equal(f.updates.length, 2);
    assert.ok(f.updates.every(batch => batch[0]?.status === 'ONLINE'));
  } finally { await f.sync.close(); f.db.close(); }
});

test('ownership query must match complete request; foreign, ordinary, failed, missing and duplicate items cannot update', async () => {
  for (const data of [[queryItem('d', 'other')], [queryItem('d', 'g', 0)], [{ deviceId: 'd', statusCode: 1 }], [], [queryItem('d'), queryItem('d')], [queryItem('d'), queryItem('extra')]]) {
    const f = fixture();
    try {
      f.cloud.querySubDevices = async () => ({ statusCode: 0, data });
      f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
      assert.equal(f.updates.length, 0); assert.ok(f.errors.length);
      await f.sync.runOnce(); assert.equal(f.updates.length, 0);
    } finally { await f.sync.close(); f.db.close(); }
  }
});

test('partial operation result confirms only successful unique requested items and retries failed items', async () => {
  const f = fixture();
  try {
    f.cloud.updateSubDeviceStatus = async statuses => { f.updates.push(statuses); return { statusCode: 0, data: [{ deviceId: 'a', statusCode: 0 }, { deviceId: 'b', statusCode: 1 }] }; };
    f.sync.observeUplink('i', 'a'); f.sync.observeUplink('i', 'b'); await f.sync.runOnce();
    assert.equal(f.db.prepare('SELECT count(*) n FROM cloud_presence WHERE confirmed_status IS NOT NULL').get() && (f.db.prepare('SELECT count(*) n FROM cloud_presence WHERE confirmed_status IS NOT NULL').get() as { n: number }).n, 1);
    f.time(10_000); await f.sync.runOnce(); assert.deepEqual(f.queries.at(-1), ['b']);
    assert.ok(f.errors.length);
  } finally { await f.sync.close(); f.db.close(); }
});

test('stopped instance goes offline; starting does not assert online without a new live observation', async () => {
  const f = fixture();
  try {
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
    f.instances([{ id: 'i', running: false }]); await f.sync.runOnce();
    assert.equal(f.updates.at(-1)?.[0]?.status, 'OFFLINE');
    f.instances([{ id: 'i', running: true }]); await f.sync.runOnce(); assert.equal(f.updates.length, 2);
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce(); assert.equal(f.updates.at(-1)?.[0]?.status, 'ONLINE');
  } finally { await f.sync.close(); f.db.close(); }
});

test('late ownership response after stop never sends ONLINE and an in-flight ONLINE is corrected without confirming it', async () => {
  const f = fixture();
  try {
    let resolve!: (v: unknown) => void;
    f.cloud.querySubDevices = () => new Promise(r => { resolve = r; });
    f.sync.observeUplink('i', 'd'); const pending = f.sync.runOnce();
    await new Promise(r => setImmediate(r));
    f.sync.observeOffline('i', 'd'); resolve({ statusCode: 0, data: [queryItem('d')] }); await pending;
    assert.equal(f.updates.length, 0);
    f.cloud.querySubDevices = async () => ({ statusCode: 0, data: [queryItem('d')] });
    f.cloud.updateSubDeviceStatus = statuses => { f.updates.push(statuses); return new Promise(r => { resolve = r; }); };
    f.sync.observeUplink('i', 'd'); const sent = f.sync.runOnce(); await new Promise(r => setImmediate(r));
    f.sync.observeOffline('i', 'd'); resolve(result(['d'])); await sent;
    assert.equal((f.db.prepare('SELECT count(*) n FROM cloud_presence WHERE confirmed_status IS NOT NULL').get() as { n: number }).n, 0);
    f.cloud.updateSubDeviceStatus = async statuses => { f.updates.push(statuses); return result(['d']); };
    await f.sync.runOnce(); assert.equal(f.updates.at(-1)?.[0]?.status, 'OFFLINE');
  } finally { await f.sync.close(); f.db.close(); }
});

test('reconnect rechecks same gateway, change of gateway isolates previous candidates and late replies', async () => {
  const f = fixture(); f.sync.start();
  try {
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
    f.change('g', false); await f.sync.runOnce();
    f.change('g'); await f.sync.runOnce(); assert.equal(f.queries.length, 1, 'reconnect alone must not revive an old source');
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce(); assert.equal(f.queries.length, 2);
    f.change('new'); await f.sync.runOnce(); assert.equal(f.queries.length, 2);
    f.sync.observeUplink('i', 'new-d'); await f.sync.runOnce(); assert.deepEqual(f.queries.at(-1), ['new-d']);
  } finally { await f.sync.close(); assert.equal(f.listeners.size, 0); f.db.close(); }
});

test('restart loads ownership-checked sources; stopped sources become OFFLINE and running sources require live data', async () => {
  const db = openDb(':memory:'); const first = fixture(db);
  first.sync.observeUplink('i', 'stopped'); first.sync.observeUplink('j', 'running'); await first.sync.runOnce(); await first.sync.close();
  const next = fixture(db);
  try {
    next.instances([{ id: 'i', running: false }, { id: 'j', running: true }]); await next.sync.runOnce();
    assert.deepEqual(next.updates, [[{ deviceId: 'stopped', status: 'OFFLINE' }]]);
    next.sync.observeUplink('j', 'running'); await next.sync.runOnce(); assert.equal(next.updates.at(-1)?.[0]?.deviceId, 'running');
  } finally { await next.sync.close(); db.close(); }
});

test('multiple instance sources are conservative; stopping one does not overwrite another active source', async () => {
  const f = fixture();
  try {
    f.sync.observeUplink('i', 'd'); f.sync.observeUplink('j', 'd'); await f.sync.runOnce();
    f.instances([{ id: 'i', running: false }, { id: 'j', running: true }]); await f.sync.runOnce(); assert.equal(f.updates.length, 1);
    f.instances([]); await f.sync.runOnce(); assert.equal(f.updates.at(-1)?.[0]?.status, 'OFFLINE');
  } finally { await f.sync.close(); f.db.close(); }
});

test('batches are bounded and single flight; close cancels timers and awaits the active round', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 205; i++) f.sync.observeUplink('i', `d${i}`);
    await Promise.all([f.sync.runOnce(), f.sync.runOnce()]); assert.equal(f.queries.length, 1); assert.equal(f.queries[0]?.length, 100);
    await f.sync.runOnce(); await f.sync.runOnce(); assert.deepEqual(f.queries.map(x => x.length), [100, 100, 5]);
    f.sync.start(); await f.sync.close();
    const count = f.queries.length; await new Promise(r => setTimeout(r, 20)); await f.sync.runOnce(); assert.equal(f.queries.length, count);
  } finally { await f.sync.close(); f.db.close(); }
});

test('Docker lookup failure does not mean offline or permit a stale ONLINE update', async () => {
  const f = fixture(); let fail = false;
  const sync = new PresenceSynchronizer({ db: f.db, cloud: f.cloud, listInstances: async () => { if (fail) throw new Error('unavailable'); return [{ id: 'i', running: true }]; } });
  try {
    sync.observeUplink('i', 'd'); await sync.runOnce(); fail = true; await sync.runOnce();
    assert.equal(f.updates.length, 1);
  } finally { await sync.close(); await f.sync.close(); f.db.close(); }
});

test('a new concurrent source is confirmed and persisted before restart can infer a stop', async () => {
  const f = fixture();
  try {
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
    f.sync.observeUplink('j', 'd'); await f.sync.runOnce(); await f.sync.close();
    const next = fixture(f.db);
    try {
      next.instances([{ id: 'i', running: false }, { id: 'j', running: true }]); await next.sync.runOnce();
      assert.equal(next.updates.length, 0, 'a running known second source is unknown, not offline, after restart');
    } finally { await next.sync.close(); }
  } finally { await f.sync.close(); f.db.close(); }
});

test('actual instance stop while the status request is in flight does not confirm a late ONLINE', async () => {
  const f = fixture(); let resolve!: (v: unknown) => void;
  try {
    f.cloud.updateSubDeviceStatus = statuses => { f.updates.push(statuses); return new Promise(r => { resolve = r; }); };
    f.sync.observeUplink('i', 'd'); const pending = f.sync.runOnce(); await new Promise(r => setImmediate(r));
    f.instances([]); resolve(result(['d'])); await pending;
    assert.equal((f.db.prepare('SELECT count(*) n FROM cloud_presence WHERE confirmed_status IS NOT NULL').get() as { n: number }).n, 0);
    f.cloud.updateSubDeviceStatus = async statuses => { f.updates.push(statuses); return result(['d']); };
    await f.sync.runOnce(); assert.equal(f.updates.at(-1)?.[0]?.status, 'OFFLINE');
  } finally { await f.sync.close(); f.db.close(); }
});

test('hung Docker inspection has a deadline; shutdown aborts it and late results cannot publish', async () => {
  const f = fixture(); let signal: AbortSignal | undefined; let resolve!: (v: { id: string; running: boolean }[]) => void;
  const sync = new PresenceSynchronizer({ db: f.db, cloud: f.cloud, instanceTimeoutMs: 10,
    listInstances: current => { signal = current; return new Promise(r => { resolve = r; }); } });
  try {
    sync.observeUplink('i', 'd'); await sync.runOnce(); assert.equal(signal?.aborted, true);
    const next = sync.runOnce(); await new Promise(r => setImmediate(r));
    await sync.close(); await next; assert.equal(signal?.aborted, true);
    resolve([{ id: 'i', running: true }]); await new Promise(r => setImmediate(r));
    assert.equal(f.queries.length, 0);
  } finally { await sync.close(); await f.sync.close(); f.db.close(); }
});

test('ownership-checked in-flight ONLINE leaves restart reconciliation responsibility even without a receipt', async () => {
  const f = fixture();
  let release!: () => void; const seen = new Promise<void>(resolve => { release = resolve; });
  f.cloud.updateSubDeviceStatus = async (_statuses, _gateway, signal) => {
    release(); return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  f.sync.observeUplink('i', 'd'); const pending = f.sync.runOnce(); await seen; await f.sync.close(); await pending;
  const next = fixture(f.db);
  try {
    next.instances([]); await next.sync.runOnce();
    assert.deepEqual(next.updates, [[{ deviceId: 'd', status: 'OFFLINE' }]]);
  } finally { await next.sync.close(); f.db.close(); }
});

test('a state round trip while an opposite request is pending always sends a compensating update', async () => {
  for (const initiallyOnline of [false, true]) {
    const f = fixture(); let resolve!: (v: unknown) => void;
    const observe = (online: boolean) => online ? f.sync.observeUplink('i', 'd') : f.sync.observeOffline('i', 'd');
    try {
      observe(initiallyOnline); await f.sync.runOnce();
      f.cloud.updateSubDeviceStatus = statuses => { f.updates.push(statuses); return new Promise(r => { resolve = r; }); };
      observe(!initiallyOnline); const pending = f.sync.runOnce(); await new Promise(r => setImmediate(r));
      observe(initiallyOnline); resolve(result(['d'])); await pending;
      f.cloud.updateSubDeviceStatus = async statuses => { f.updates.push(statuses); return result(['d']); };
      await f.sync.runOnce();
      assert.deepEqual(f.updates.map(batch => batch[0]?.status), initiallyOnline ? ['ONLINE', 'OFFLINE', 'ONLINE'] : ['OFFLINE', 'ONLINE', 'OFFLINE']);
    } finally { await f.sync.close(); f.db.close(); }
  }
});

test('high frequency live uplink does not starve a pending status confirmation', async () => {
  const f = fixture(); let resolve!: (v: unknown) => void;
  try {
    f.cloud.updateSubDeviceStatus = statuses => { f.updates.push(statuses); return new Promise(r => { resolve = r; }); };
    f.sync.observeUplink('i', 'd'); const pending = f.sync.runOnce(); await new Promise(r => setImmediate(r));
    for (let i = 0; i < 100; i++) f.sync.observeUplink('i', 'd');
    resolve(result(['d'])); await pending; await f.sync.runOnce();
    assert.equal(f.updates.length, 1);
    f.cloud.updateSubDeviceStatus = async statuses => { f.updates.push(statuses); return result(['d']); };
    f.time(301_001); await f.sync.runOnce(); assert.equal(f.updates.length, 2);
  } finally { await f.sync.close(); f.db.close(); }
});

test('changing the gateway during a query or update fences its late result', async () => {
  for (const phase of ['query', 'update']) {
    const f = fixture(); f.sync.start(); let resolve!: (v: unknown) => void;
    try {
      if (phase === 'query') f.cloud.querySubDevices = () => new Promise(r => { resolve = r; });
      else f.cloud.updateSubDeviceStatus = statuses => { f.updates.push(statuses); return new Promise(r => { resolve = r; }); };
      f.sync.observeUplink('i', 'd'); const pending = f.sync.runOnce(); await new Promise(r => setImmediate(r));
      f.change('new'); resolve(phase === 'query' ? { statusCode: 0, data: [queryItem('d')] } : result(['d'])); await pending;
      assert.equal(f.updates.length, phase === 'query' ? 0 : 1);
      assert.equal((f.db.prepare('SELECT count(*) n FROM cloud_presence WHERE confirmed_status IS NOT NULL').get() as { n: number }).n, 0);
      await f.sync.runOnce(); assert.equal(f.updates.length, phase === 'query' ? 0 : 1);
    } finally { await f.sync.close(); f.db.close(); }
  }
});

test('persistent source capacity cannot lose a concurrent source and infer false OFFLINE after restart', async () => {
  const f = fixture();
  try {
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
    f.db.transaction(() => { const insert = f.db.prepare("INSERT INTO cloud_presence(gateway_id, instance_id, device_id, confirmed_status) VALUES ('old', 'i', ?, 'ONLINE')"); for (let i = 0; i < 9999; i++) insert.run(String(i)); })();
    f.sync.observeUplink('j', 'd'); await f.sync.runOnce();
    const queries = f.queries.length; await f.sync.runOnce(); assert.equal(f.queries.length, queries);
    f.time(7_000); await f.sync.runOnce(); assert.equal(f.queries.length, queries + 1, 'dirty source remains retryable after backoff');
    await f.sync.close();
    const next = fixture(f.db);
    try {
      next.instances([{ id: 'i', running: false }, { id: 'j', running: true }]); await next.sync.runOnce();
      assert.equal(next.updates.length, 0);
      assert.ok(f.errors.some(error => error.includes('上限')));
      assert.equal((f.db.prepare('SELECT count(*) n FROM cloud_presence').get() as { n: number }).n, 10000);
    } finally { await next.sync.close(); }
  } finally { await f.sync.close(); f.db.close(); }
});

test('in-memory source capacity marks a known device ambiguous instead of overwriting its active rejected source', async () => {
  const f = fixture();
  try {
    f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
    for (let i = 0; i < 9999; i++) f.sync.observeUplink('j', `other-${i}`);
    f.sync.observeUplink('j', 'd');
    f.instances([{ id: 'i', running: false }, { id: 'j', running: true }]); await f.sync.runOnce();
    assert.equal(f.updates.some(batch => batch.some(item => item.deviceId === 'd' && item.status === 'OFFLINE')), false);
    await f.sync.close(); const next = fixture(f.db);
    try {
      next.instances([{ id: 'i', running: false }, { id: 'j', running: true }]); await next.sync.runOnce();
      assert.equal(next.updates.some(batch => batch.some(item => item.deviceId === 'd' && item.status === 'OFFLINE')), false);
    } finally { await next.sync.close(); }
  } finally { await f.sync.close(); f.db.close(); }
});

test('capacity conflict discovered before or during OFFLINE never confirms incomplete-source OFFLINE', async () => {
  for (const phase of ['before', 'during']) {
    const f = fixture(); let resolve!: (v: unknown) => void;
    try {
      f.sync.observeUplink('i', 'd'); await f.sync.runOnce();
      if (phase === 'before') {
        f.db.transaction(() => { const insert = f.db.prepare("INSERT INTO cloud_presence(gateway_id, instance_id, device_id) VALUES ('old', 'i', ?)"); for (let i = 0; i < 9999; i++) insert.run(String(i)); })();
        f.sync.observeOffline('j', 'd'); f.sync.observeOffline('i', 'd'); await f.sync.runOnce();
        assert.equal(f.updates.length, 1, 'discovering missing capacity cannot send a now-ambiguous OFFLINE');
      } else {
        for (let i = 0; i < 9999; i++) f.sync.observeUplink('j', `other-${i}`);
        f.cloud.updateSubDeviceStatus = statuses => { f.updates.push(statuses); return new Promise(r => { resolve = r; }); };
        f.sync.observeOffline('i', 'd'); const pending = f.sync.runOnce(); await new Promise(r => setImmediate(r));
        f.sync.observeUplink('j', 'd'); resolve(result(f.updates.at(-1)!.map(x => x.deviceId))); await pending;
        assert.equal((f.db.prepare("SELECT confirmed_status FROM cloud_presence WHERE gateway_id='g' AND device_id='d'").get() as { confirmed_status: string | null }).confirmed_status, null);
      }
      assert.equal((f.db.prepare("SELECT source_conflict FROM cloud_presence WHERE gateway_id='g' AND device_id='d'").get() as { source_conflict: number }).source_conflict, 1);
    } finally { await f.sync.close(); f.db.close(); }
  }
});

test('an old OFFLINE confirmation persists a new inactive source without redundant Cloud updates or repeated queries', async () => {
  const f = fixture();
  try {
    f.sync.observeOffline('i', 'd'); await f.sync.runOnce();
    f.time(400_000); f.sync.observeOffline('j', 'd'); await f.sync.runOnce();
    assert.equal((f.db.prepare('SELECT count(*) n FROM cloud_presence WHERE device_id=?').get('d') as { n: number }).n, 2);
    const queries = f.queries.length; await f.sync.runOnce();
    assert.equal(f.queries.length, queries, 'new source must no longer remain dirty');
    assert.equal(f.updates.length, 1, 'unchanged OFFLINE requires no heartbeat or status side effect');
  } finally { await f.sync.close(); f.db.close(); }
});

test('inactive-source reconciliation cannot occupy every batch and starve a fresh ONLINE refresh', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) f.sync.observeOffline('i', `idle-${i}`);
    await f.sync.runOnce(); f.sync.observeUplink('i', 'active'); await f.sync.runOnce();
    f.time(400_000);
    for (let i = 0; i < 100; i++) f.sync.observeOffline('j', `idle-${i}`);
    f.sync.observeUplink('i', 'active'); await f.sync.runOnce(); await f.sync.runOnce();
    assert.equal(f.updates.flat().filter(item => item.deviceId === 'active' && item.status === 'ONLINE').length, 2);
    assert.equal(f.updates.flat().filter(item => item.deviceId.startsWith('idle-')).length, 100);
    const queries = f.queries.length; await f.sync.runOnce(); assert.equal(f.queries.length, queries);
  } finally { await f.sync.close(); f.db.close(); }
});
