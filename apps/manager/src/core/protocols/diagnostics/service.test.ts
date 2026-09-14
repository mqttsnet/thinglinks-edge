import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openDb } from '../../db.ts';
import { InstanceOperationGate } from '../../instance/operation-gate.ts';
import { ProtocolDiagnosticStore } from './store.ts';
import { ProtocolDiagnosticService } from './service.ts';
import { ManagedFlowResponseTooLargeError, type SingleFlowConfig, type InstalledModule } from '../../flows/admin-client.ts';
import type { FlowNode } from '../../flows/types.ts';
const connection = { host: '192.0.2.1', port: 502, unitId: 1, registerType: 'HoldingRegister' as const, address: 0, quantity: 2, clientTimeout: 100, reconnectTimeout: 100 };
function fixture() {
  const db = openDb(':memory:');
  let now = Date.now();
  let sequence = 0;
  const flows = new Map<string, SingleFlowConfig>();
  let deleted = 0;
  let added = 0;
  let failDelete = false;
  let failList = false;
  let rawGraphOversized = false;
  const listReservations: number[] = [];
  let modules = true;
  let lostResponse = false;
  let ambiguousNoFlow = false;
  let generation = 'generation';
  let runtimeExists = true;
  let runtimeId = 'runtime';
  let running = true;
  let verifyBarrier: Promise<void> | undefined;
  const store = new ProtocolDiagnosticStore(db, { now: () => now });
  const gate = new InstanceOperationGate({ assertAllowed() { } });
  const mod = { module: 'node-red-contrib-modbus', version: '5.60.2', observedVersions: ['5.60.2'], enabled: true, local: false, observedFiles: [], source: 'unknown', health: 'healthy', errors: [], types: ['modbus-client', 'modbus-getter'], nodeSets: [{ id: 'modbus', name: 'modbus', module: 'node-red-contrib-modbus', version: '5.60.2', enabled: true, types: ['modbus-client', 'modbus-getter'], err: '' }] } as InstalledModule;
  const service = new ProtocolDiagnosticService({ store, gate, now: () => now, taskId: () => `task-${++sequence}`, readerId: () => `reader-${sequence}`, generationFor: () => generation, runtime: { async inspect() { return { runtimeId, generation: 'generation', running, callbackReady: true }; }, async exists() { return runtimeExists; } }, admin: { async readModules() { return modules ? [mod] : []; }, async listFlows(_id, reservedBytes) { listReservations.push(reservedBytes ?? 0); if (failList) throw new Error('private upstream diagnostic'); if (rawGraphOversized) throw new ManagedFlowResponseTooLargeError(); return [...flows.values()].flatMap(f => [{ id: f.id!, type: 'tab' }, ...f.nodes, ...(f.configs ?? [])]) as FlowNode[]; }, async addFlow(_id, f) { assert.equal(store.unfinished().length, 1); added++; if (ambiguousNoFlow) throw new Error('unknown deployment response'); const id = `generated-${added}`; flows.set(id, { ...structuredClone(f), id, nodes: f.nodes.map(n => ({ ...n, z: id })), configs: (f.configs ?? []).map(n => ({ ...n, z: id })) }); if (lostResponse)
        throw new Error('response lost'); return { id }; }, async getFlow(_id, id) { await verifyBarrier; const f = flows.get(id); if (!f)
        throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(f); }, async deleteFlow(_id, id) { if (failDelete)
        throw new Error('hidden backend secret'); deleted++; flows.delete(id); } } });
  return { db, store, service, gate, flows, get added() { return added; }, get deleted() { return deleted; }, advance: (ms: number) => { now += ms; }, setFailDelete: (v: boolean) => { failDelete = v; }, setFailList: (v: boolean) => { failList = v; }, setRawGraphOversized: () => { rawGraphOversized = true; }, listReservations, setModules: (v: boolean) => { modules = v; }, setLostResponse: (v: boolean) => { lostResponse = v; }, setAmbiguousNoFlow: () => { ambiguousNoFlow = true; }, setGeneration: (v: string) => { generation = v; }, setRuntimeExists: (v: boolean) => { runtimeExists = v; }, setRuntimeId: (v: string) => { runtimeId = v; }, setRunning: (v: boolean) => { running = v; }, holdVerification: () => { let release!: () => void; verifyBarrier = new Promise<void>(resolve => { release = resolve; }); return () => { verifyBarrier = undefined; release(); }; } };
}
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) {
  if (check())
    return;
  await delay(5);
} assert.fail('condition not reached'); }
test('read is claimed once, scoped, validated, and success follows confirmed single-tab cleanup', async () => {
  const f = fixture();
  try {
    const task = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', task.id).state === 'connecting');
    assert.equal(f.gate.current('a'), 'protocol-read');
    const readerId = f.store.get(task.id)!.readerId;
    assert.throws(() => f.service.claim('b', task.id, { readerId }));
    const lease = f.service.claim('a', task.id, { readerId });
    assert.throws(() => f.service.claim('a', task.id, { readerId }));
    assert.throws(() => f.service.complete('a', task.id, { readerId, ...lease, registers: [1], durationMs: 1 }));
    f.service.complete('a', task.id, { readerId, leaseToken: lease.leaseToken, registers: [1, 65535], durationMs: 2 });
    await until(() => f.service.get('a', task.id).cleanup === 'done');
    assert.deepEqual(f.service.get('a', task.id).result, { registers: [1, 65535], hex: '0001 FFFF', durationMs: 2 });
    assert.equal(f.service.get('a', task.id).state, 'succeeded');
    assert.equal(f.deleted, 1);
    assert.equal(f.added, 1);
    assert.equal(f.gate.current('a'), undefined);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('failed cleanup remains durable and blocks another read; DELETE retries cleanup without reread', async () => {
  const f = fixture();
  try {
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).state === 'connecting');
    f.setFailDelete(true);
    const r = await f.service.cancel('a', t.id);
    assert.equal(r.state, 'cleanup-required');
    assert.equal(r.cleanup, 'failed');
    assert.equal(JSON.stringify(r).includes('hidden backend'), false);
    await assert.rejects(f.service.start('a', connection, 'actor'));
    f.setFailDelete(false);
    assert.equal((await f.service.cancel('a', t.id)).state, 'cancelled');
    assert.equal(f.added, 1);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('changed flow is never deleted and startup recovery never adds or claims', async () => {
  const f = fixture();
  try {
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).state === 'connecting');
    const flow = [...f.flows.values()][0]!;
    flow.nodes[0]!.name = 'operator changed';
    assert.equal((await f.service.cancel('a', t.id)).state, 'cleanup-required');
    assert.equal(f.deleted, 0);
    await f.service.recover();
    assert.equal(f.added, 1);
    assert.equal(f.deleted, 0);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('missing loaded fixed component never deploys', async () => {
  const f = fixture();
  try {
    f.setModules(false);
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).cleanup === 'done');
    assert.equal(f.service.get('a', t.id).error?.code, 'COMPONENT_UNAVAILABLE');
    assert.equal(f.added, 0);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('expired lease cannot report, and task deadline cleans without a second claim', async () => {
  const f = fixture();
  try {
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).state === 'connecting');
    const readerId = f.store.get(t.id)!.readerId;
    const lease = f.service.claim('a', t.id, { readerId });
    f.advance(200000);
    assert.throws(() => f.service.complete('a', t.id, { readerId, leaseToken: lease.leaseToken, registers: [1, 2], durationMs: 1 }));
    await until(() => f.service.get('a', t.id).cleanup === 'done');
    assert.equal(f.service.get('a', t.id).error?.code, 'READ_TIMEOUT');
    assert.equal(f.added, 1);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('external references fence cleanup until removed, with no change to the foreign tab', async () => {
  const f = fixture();
  try {
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).state === 'connecting');
    const own = [...f.flows.values()][0]!;
    const configId = own.configs![0]!.id;
    f.flows.set('business', { id: 'business', nodes: [{ id: 'consumer', type: 'modbus-getter', z: 'business', server: configId }] });
    assert.equal((await f.service.cancel('a', t.id)).error?.code, 'FLOW_CHANGED');
    assert.equal(f.deleted, 0);
    f.flows.get('business')!.nodes[0]!.server = 'independent-client';
    assert.equal((await f.service.cancel('a', t.id)).cleanup, 'done');
    assert.equal(f.flows.has('business'), true);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('lost add response discovers only the fingerprinted tab and never retries deployment', async () => {
  const f = fixture();
  try {
    f.setLostResponse(true);
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).cleanup === 'done');
    assert.equal(f.added, 1);
    assert.equal(f.deleted, 1);
    assert.equal(f.service.get('a', t.id).state, 'failed');
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});
test('a changed generation remains fenced even when its original runtime is gone', async () => {
  const f = fixture();
  try {
    const t = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', t.id).state === 'connecting');
    await assert.rejects(f.gate.run('a', 'proxy-write', async () => { }));
    const readerId = f.store.get(t.id)!.readerId;
    f.setGeneration('replacement-generation');
    assert.throws(() => f.service.claim('a', t.id, { readerId }));
    assert.equal((await f.service.cancel('a', t.id)).error?.code, 'INSTANCE_CHANGED');
    assert.equal(f.deleted, 0);
    f.setRuntimeExists(false);
    assert.equal((await f.service.cancel('a', t.id)).cleanup, 'failed');
    assert.equal(f.deleted, 0);
  }
  finally {
    await f.service.close();
    f.db.close();
  }
});


test('a callback before verified deployment is retryable and cancellation during preparation never grants a read',async()=>{
 const f=fixture();const release=f.holdVerification();try{const t=await f.service.start('a',connection,'actor');await until(()=>f.added===1);const readerId=f.store.get(t.id)!.readerId;assert.throws(()=>f.service.claim('a',t.id,{readerId}),(error:unknown)=>(error as {status?:number}).status===503);const cancelling=f.service.cancel('a',t.id);assert.throws(()=>f.service.claim('a',t.id,{readerId}),(error:unknown)=>(error as {status?:number}).status===409);release();assert.equal((await cancelling).state,'cancelled');assert.equal(f.added,1);assert.equal(f.deleted,1);}finally{release();await f.service.close();f.db.close();}
});


test('an uncertain add response with no visible nodes cannot be reported as cleaned',async()=>{
 const f=fixture();try{f.setAmbiguousNoFlow();const t=await f.service.start('a',connection,'actor');await until(()=>f.service.get('a',t.id).cleanup==='failed');assert.equal(f.service.get('a',t.id).state,'cleanup-required');assert.equal((await f.service.cancel('a',t.id)).cleanup,'failed');assert.equal(f.added,1);assert.equal(f.deleted,0);f.setRuntimeExists(false);assert.equal((await f.service.cancel('a',t.id)).cleanup,'failed');}finally{await f.service.close();f.db.close();}
});


test('same-generation rebuild must actually delete the persisted temporary tab before declaring cleanup complete',async()=>{
 const f=fixture();try{const t=await f.service.start('a',connection,'actor');await until(()=>f.service.get('a',t.id).state==='connecting');f.setFailDelete(true);assert.equal((await f.service.cancel('a',t.id)).cleanup,'failed');f.setRuntimeExists(false);f.setRuntimeId('replacement-runtime');f.setFailDelete(false);assert.equal((await f.service.cancel('a',t.id)).cleanup,'done');assert.equal(f.deleted,1);assert.equal(f.flows.size,0);assert.equal(f.added,1);}finally{await f.service.close();f.db.close();}
});
test('removed runtime with stopped replacement cannot prove persistent flow cleanup',async()=>{
 const f=fixture();try{const t=await f.service.start('a',connection,'actor');await until(()=>f.service.get('a',t.id).state==='connecting');f.setRuntimeExists(false);f.setRuntimeId('replacement-runtime');f.setRunning(false);assert.equal((await f.service.cancel('a',t.id)).cleanup,'failed');assert.equal(f.flows.size,1);assert.equal(f.deleted,0);}finally{await f.service.close();f.db.close();}
});

test('a freshly constructed service cannot grant a saved task before recovery has run',async()=>{
 const f=fixture();try{const t=await f.service.start('a',connection,'actor');await until(()=>f.service.get('a',t.id).state==='connecting');const restarted=new ProtocolDiagnosticService({store:f.store,gate:f.gate,generationFor:()=> 'generation',admin:{} as import('./service.ts').DiagnosticAdminPort,runtime:{} as import('./service.ts').DiagnosticRuntimePort});assert.throws(()=>restarted.claim('a',t.id,{readerId:f.store.get(t.id)!.readerId}),(error:unknown)=>(error as {status?:number}).status===409);await restarted.close();await f.service.cancel('a',t.id);}finally{await f.service.close();f.db.close();}
});

test('expired read lease cleans promptly even when the connection budget has time remaining',async()=>{
 const f=fixture();try{const t=await f.service.start('a',{...connection,reconnectTimeout:60000},'actor');await until(()=>f.service.get('a',t.id).state==='connecting');const lease=f.service.claim('a',t.id,{readerId:f.store.get(t.id)!.readerId});f.advance(3000);assert.ok(t.deadline>lease.deadline+30000);await until(()=>f.service.get('a',t.id).cleanup==='done');assert.equal(f.service.get('a',t.id).error?.code,'READ_TIMEOUT');assert.equal(f.deleted,1);}finally{await f.service.close();f.db.close();}
});


test('unreadable existing graph fails before addFlow and never grants a read lease', async () => {
  const f = fixture();
  try {
    f.setFailList(true);
    const task = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', task.id).cleanup === 'done');
    const result = f.service.get('a', task.id);
    assert.equal(result.state, 'failed');
    assert.equal(result.error?.code, 'FLOW_GRAPH_UNREADABLE');
    assert.equal(f.added, 0);
    assert.equal(f.deleted, 0);
    assert.equal(f.store.get(task.id)?.deployAttempted, false);
    assert.throws(() => f.service.claim('a', task.id, { readerId: f.store.get(task.id)!.readerId }));
    assert.equal(JSON.stringify(result).includes('private upstream'), false);
  } finally { await f.service.close(); f.db.close(); }
});
test('oversize and near-limit existing graphs leave room for the full temporary tab before creating a connection', async () => {
  for (const size of [1_048_577, 1_048_576 - 1000]) {
    const f = fixture();
    try {
      f.flows.set('business', { id: 'business', nodes: [{ id: 'business-node', type: 'function', z: 'business', func: 'x'.repeat(size) }] });
      const task = await f.service.start('a', connection, 'actor');
      await until(() => f.service.get('a', task.id).cleanup === 'done');
      assert.equal(f.service.get('a', task.id).error?.code, 'FLOW_GRAPH_TOO_LARGE');
      assert.equal(f.added, 0);
      assert.equal(f.deleted, 0);
      assert.equal(f.flows.size, 1);
      assert.equal(f.store.get(task.id)?.deployAttempted, false);
      assert.ok(f.listReservations[0]! > 16384);
      assert.throws(() => f.service.claim('a', task.id, { readerId: f.store.get(task.id)!.readerId }));
    } finally { await f.service.close(); f.db.close(); }
  }
});


test('strict raw graph byte-limit errors are reported as capacity failure without deploying a client', async () => {
  const f = fixture();
  try {
    f.setRawGraphOversized();
    const task = await f.service.start('a', connection, 'actor');
    await until(() => f.service.get('a', task.id).cleanup === 'done');
    assert.equal(f.service.get('a', task.id).error?.code, 'FLOW_GRAPH_TOO_LARGE');
    assert.equal(f.added, 0);
    assert.equal(f.store.get(task.id)?.deployAttempted, false);
  } finally { await f.service.close(); f.db.close(); }
});
