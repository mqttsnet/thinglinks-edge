import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db.ts';
import { CommandBridge } from './bridge.ts';
import type { DownlinkCommand } from '../gateway.ts';
import type { ProtocolMid } from '../mid.ts';
function fixture(limits = {}) {
    const db = openDb(':memory:');
    let now = 1000;
    let online = true;
    const replies: {
        mid: ProtocolMid;
        body: any;
        gateway: string | undefined;
    }[] = [];
    const cloud = { status: () => ({ deviceIdentification: 'gateway' }), onCommand: () => () => { }, onStateChange: () => () => { },
        publishCommandResponse: async (mid: ProtocolMid, body: unknown, gateway?: string) => { if (!online)
            throw new Error('offline'); replies.push({ mid, body, gateway }); } };
    const bridge = new CommandBridge({ db, cloud, now: () => now, limits });
    const binding = { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control', commands: [{ cmd: 'set', param: 'value' }] };
    const command = (mid:ProtocolMid = 1, params: unknown = { value: 5 }): DownlinkCommand => ({ topic: '/v1/devices/gateway/command', gatewayId: 'gateway', mid, body: { deviceIdentification: 'device', productIdentification: 'product', msgType: 'cloudReq', serviceCode: 'control', cmd: 'set', params, versionNo: 'version' } });
    return { db, bridge, binding, command, replies, cloud, advance: (ms: number) => { now += ms; }, offline: () => { online = false; }, online: () => { online = true; } };
}
test('SQLite deduplicates adjacent Snowflake mids losslessly and returns their exact values through leases and receipts',async()=>{
  const f=fixture();const mids=['480000000000000001','480000000000000002','9223372036854775807'];
  try {
    f.bridge.registerBindings('a',f.binding);
    for(const mid of mids)await f.bridge.receive(f.command(mid));
    await f.bridge.receive(f.command(mids[0]!));assert.equal(f.bridge.list().length,3);
    const column=f.db.prepare('PRAGMA table_info(cloud_command)').all() as {name:string;type:string}[];
    assert.equal(column.find(c=>c.name==='mid')?.type,'TEXT');
    for(const mid of mids) {
      const lease=f.bridge.next('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control'})!;
      assert.equal(lease.mid,mid);await f.bridge.complete('a',lease.id,{leaseToken:lease.leaseToken,ok:true});
      assert.equal(f.replies.at(-1)?.mid,mid);
    }
    await f.bridge.receive(f.command(mids[0]!));assert.equal(f.bridge.list().length,3);
    assert.equal(f.bridge.next('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control'}),null);
  }finally{await f.bridge.close();f.db.close();}
});
test('retired MID high watermark compares decimal integers, never SQLite text lexicographic MAX',async()=>{
  const f=fixture({maxResults:1});
  try {
    f.bridge.registerBindings('a',f.binding);
    for(const mid of ['9999999999999999','10000000000000000','10000000000000001']) {
      await f.bridge.receive(f.command(mid));
      const lease=f.bridge.next('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control'})!;
      await f.bridge.complete('a',lease.id,{leaseToken:lease.leaseToken,ok:true});
    }
    assert.equal((f.db.prepare('SELECT retired_mid FROM cloud_command_gateway').get() as {retired_mid:string}).retired_mid,'10000000000000000');
    await f.bridge.receive(f.command('10000000000000000'));
    assert.equal(f.bridge.next('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control'}),null);
    assert.match(f.replies.at(-1)!.body.errMsg,/保留窗口/);
  }finally{await f.bridge.close();f.db.close();}
});
test('uncertain transport outcome stays unknown and never leases for execution again',async()=>{
  const f=fixture();try{
    f.bridge.registerBindings('a',f.binding);await f.bridge.receive(f.command());
    const poll={consumerId:f.binding.consumerId,nodeId:f.binding.nodeId,serviceCode:f.binding.serviceCode};
    const leased=f.bridge.next('a',poll)!;
    await f.bridge.complete('a',leased.id,{leaseToken:leased.leaseToken,ok:false,unknown:true,error:'设备应答超时，结果未知'});
    assert.equal(f.bridge.list()[0]!.status,'unknown');
    await f.bridge.receive(f.command());assert.equal(f.bridge.next('a',poll),null);
    assert.equal(f.replies.at(-1)!.body.errCode,1);
  }finally{f.db.close();}
});
test('declared commands lease once, require instance/token ownership, persist result and replay only receipt', async () => {
    const f = fixture();
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive(f.command());
        const leased = f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' });
        assert.ok(leased);
        assert.deepEqual(leased.params, { value: 5 });
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        await assert.rejects(() => f.bridge.complete('b', leased.id, { leaseToken: leased.leaseToken, ok: true }), /归属|实例/);
        await assert.rejects(() => f.bridge.complete('a', leased.id, { leaseToken: 'wrong', ok: true }), /令牌/);
        await f.bridge.complete('a', leased.id, { leaseToken: leased.leaseToken, ok: true, result: { value: 5 } });
        assert.equal(f.replies[0]?.mid, 1);
        assert.equal(f.replies[0]?.body.errCode, 0);
        assert.equal(f.replies[0]?.body.msgType, 'deviceRsp');
        await f.bridge.receive(f.command());
        assert.equal(f.replies.length, 2);
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        const restored = new CommandBridge({ db: f.db, cloud: f.cloud });
        assert.equal(restored.list()[0]?.status, 'succeeded');
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('undeclared parameters, unknown targets, conflicting bindings and unsafe mids never execute', async () => {
    const f = fixture();
    try {
        f.bridge.registerBindings('a', f.binding);
        f.bridge.registerBindings('b', f.binding);
        await f.bridge.receive(f.command(1, { value: 5, extra: 1 }));
        assert.equal(f.bridge.list()[0]?.status, 'rejected');
        await f.bridge.receive({ ...f.command(2), body: { ...(f.command(2).body as object), deviceIdentification: 'missing' } });
        await assert.rejects(() => f.bridge.receive(f.command(Number.MAX_SAFE_INTEGER + 1)), /mid/);
        await assert.rejects(() => f.bridge.receive(f.command(3, { value: 'x'.repeat(70000) })), /大小|上限/);
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('leased commands time out as unknown and never execute again; receipt retries do not redeliver', async () => {
    const f = fixture({ leaseMs: 1000 });
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive(f.command());
        const lease = f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' });
        assert.ok(lease);
        f.offline();
        f.advance(1001);
        await f.bridge.tick();
        assert.equal(f.bridge.list()[0]?.status, 'unknown');
        assert.equal(f.replies.length, 0);
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        await assert.rejects(() => f.bridge.complete('a', lease.id, { leaseToken: lease.leaseToken, ok: true }), /超时|未知/);
        f.online();
        await f.bridge.tick();
        assert.equal(f.replies[0]?.body.errCode, 1);
        assert.match(f.replies[0]?.body.errMsg, /未知/);
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('expired bindings and bounded pending/results do not execute evicted duplicate mids', async () => {
    const f = fixture({ bindingTtlMs: 1000, maxPending: 1, maxResults: 1 });
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive(f.command(1));
        await f.bridge.receive(f.command(2));
        assert.equal(f.bridge.list().filter(c => c.status === 'queued').length, 1);
        const lease = f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' });
        assert.ok(lease);
        await f.bridge.complete('a', lease.id, { leaseToken: lease.leaseToken, ok: true });
        await f.bridge.receive(f.command(1));
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        f.advance(1001);
        await f.bridge.receive(f.command(3));
        assert.equal(f.bridge.list().some(c => c.mid === 3 && c.status === 'queued'), false);
        assert.ok(f.bridge.list().filter(c => !['queued', 'leased'].includes(c.status)).length <= 1);
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('one device service executes serially, duplicate consumers cannot race, and old gateway queues stay isolated', async () => {
    const f = fixture();
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive(f.command(1));
        await f.bridge.receive(f.command(2));
        const first = f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' });
        assert.ok(first);
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        await f.bridge.complete('a', first.id, { leaseToken: first.leaseToken, ok: true });
        f.bridge.registerBindings('a', { ...f.binding, consumerId: 'duplicate' });
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        assert.equal(f.bridge.list().find(row => row.mid === 2)?.status, 'rejected');
        await f.bridge.receive({ ...f.command(3), gatewayId: 'previous-gateway' });
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('late completion persists unknown even when no periodic tick has run', async () => {
    const f = fixture({ leaseMs: 1000 });
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive(f.command());
        const lease = f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' });
        assert.ok(lease);
        f.advance(1001);
        await assert.rejects(() => f.bridge.complete('a', lease.id, { leaseToken: lease.leaseToken, ok: true }), /未知/);
        assert.equal(f.bridge.list()[0]?.status, 'unknown');
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('pending commands from another cloud identity are never leased after reconfiguration', async () => {
    const f = fixture();
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive({ ...f.command(4), gatewayId: 'previous-gateway', topic: '/v1/devices/previous-gateway/command' });
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        assert.equal(f.bridge.list()[0]?.status, 'queued');
    }
    finally {
        await f.bridge.close();
        f.db.close();
    }
});
test('close waits for a pending receipt before the owner closes the database', async () => {
    const f = fixture();
    let release!: () => void;
    f.cloud.publishCommandResponse = async () => new Promise<void>(resolve => { release = resolve; });
    const receiving = f.bridge.receive(f.command());
    let closed = false;
    const closing = Promise.resolve(f.bridge.close()).then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    await receiving;
    await closing;
    f.db.close();
});

test('execution checks the explicitly addressed cached model, including models loaded after queueing', async () => {
    const f = fixture();
    let cached: import('../model-client.ts').ProductModel | undefined;
    const queries: string[][] = [];
    Object.assign(f.cloud, { getCachedModel: (product: string, version: string) => { queries.push([product, version]); return cached; } });
    try {
        f.bridge.registerBindings('a', f.binding);
        await f.bridge.receive(f.command(1));
        assert.equal(f.bridge.list()[0]?.modelChecked, false);
        cached = { services: [{ serviceCode: 'control', commands: [{ commandCode: 'set', requests: [{ parameterCode: 'value', datatype: 'int', min: '0', max: '1' }] }] }] };
        assert.equal(f.bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
        assert.equal(f.bridge.list()[0]?.status, 'rejected');
        assert.equal(f.bridge.list()[0]?.modelChecked, true);
        await f.bridge.receive(f.command(2));
        assert.equal(f.bridge.list().find(row => row.mid === 2)?.status, 'rejected');
        assert.deepEqual(queries[0], ['product', 'version']);
    } finally { await f.bridge.close(); f.db.close(); }
});

test('the lease response exposes the exact persisted absolute deadline from a single clock calculation', async () => {
    const db = openDb(':memory:');
    let now = 1000;
    const cloud = { status: () => ({ deviceIdentification: 'gateway' }), onCommand: () => () => {}, onStateChange: () => () => {}, publishCommandResponse: async () => {} };
    const bridge = new CommandBridge({ db, cloud, now: () => now++, limits: { leaseMs: 1000 } });
    try {
        bridge.registerBindings('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control', commands: [{ cmd: 'set', param: 'value' }] });
        await bridge.receive({ topic: '/v1/devices/gateway/command', gatewayId: 'gateway', mid: 1234, body: { deviceIdentification: 'device', msgType: 'cloudReq', serviceCode: 'control', cmd: 'set', params: { value: 5 } } });
        const leased = bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' })!;
        const row = db.prepare('SELECT lease_deadline FROM cloud_command WHERE id=?').get(leased.id) as { lease_deadline: number };
        assert.equal(leased.leaseDeadline, row.lease_deadline);
        assert.equal(Number.isSafeInteger(leased.leaseDeadline), true);
        now = leased.leaseDeadline;
        await bridge.tick();
        assert.equal(bridge.list()[0]?.status, 'unknown');
        assert.equal(bridge.next('a', { consumerId: 'consumer', nodeId: 'device', serviceCode: 'control' }), null);
    } finally { await bridge.close(); db.close(); }
});
