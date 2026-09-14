import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../db.ts';
import { DockerClient } from '../../instance/docker-client.ts';
import { ProtocolDiagnosticStore } from './store.ts';
import { diagnosticRemovalLifecycle } from './removal.ts';
const connection={host:'192.0.2.1',port:502,unitId:1,registerType:'HoldingRegister' as const,address:0,quantity:1,clientTimeout:100,reconnectTimeout:100};
test('only container/network/data absence settles durable diagnostics, including renamed survivors',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tle-diagnostic-purge-'));const db=openDb(':memory:');const store=new ProtocolDiagnosticStore(db);
 let container=false,network=false,survivor=false;const fake={opts:{instanceDataRoot:root},instanceNetwork:(id:string)=>`test-${id}`,docker:{getContainer:()=>({inspect:async()=>{if(container)return{};throw{statusCode:404};}}),getNetwork:()=>({inspect:async()=>{if(network)return{};throw{statusCode:404};}})}};
 const docker={assertBootstrapResourcesAbsent:(id:string)=>DockerClient.prototype.assertBootstrapResourcesAbsent.call(fake as unknown as DockerClient,id),raw:{listContainers:async()=>survivor?[{Id:'renamed'}]:[]}} as unknown as DockerClient;
 const hooks=diagnosticRemovalLifecycle(store,docker);
 try{
  store.create({id:'task',instanceId:'line-a',readerId:'reader',generation:'g',connection,deadline:1,fingerprint:'f',nodeIds:['reader']});
  assert.throws(()=>hooks.beforeRemove('line-a',{removeData:false}));assert.equal(await hooks.beforeRemove('line-a',{removeData:true}),true);
  mkdirSync(join(root,'line-a'));await assert.rejects(async () => { await hooks.afterDataRemoved('line-a'); });assert.equal(store.dto('task').cleanup,'pending');assert.equal(existsSync(join(root,'line-a')),true);
  rmSync(join(root,'line-a'),{recursive:true});container=true;await assert.rejects(async () => { await hooks.afterDataRemoved('line-a'); });container=false;network=true;await assert.rejects(async () => { await hooks.afterDataRemoved('line-a'); });network=false;survivor=true;await assert.rejects(async () => { await hooks.afterDataRemoved('line-a'); });survivor=false;
  await hooks.afterDataRemoved('line-a');assert.equal(store.dto('task').cleanup,'done');assert.equal(store.dto('task').state,'cancelled');assert.equal(await hooks.beforeRemove('line-a',{removeData:false}),false);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('a failed diagnostic settlement transaction keeps its cleanup intent after resources are gone',async()=>{
 const db=openDb(':memory:');const store=new ProtocolDiagnosticStore(db);store.create({id:'task',instanceId:'line-a',readerId:'r',generation:'g',connection,deadline:1,fingerprint:'f',nodeIds:['r']});
 const docker={assertBootstrapResourcesAbsent:async()=>{},raw:{listContainers:async()=>[]}} as unknown as DockerClient;const hooks=diagnosticRemovalLifecycle(store,docker);
 try{db.exec("CREATE TRIGGER reject_diagnostic_settlement BEFORE UPDATE ON protocol_diagnostic BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");await assert.rejects(async () => { await hooks.afterDataRemoved('line-a'); });assert.equal(store.dto('task').cleanup,'pending');db.exec('DROP TRIGGER reject_diagnostic_settlement');await hooks.afterDataRemoved('line-a');assert.equal(store.dto('task').cleanup,'done');}finally{db.close();}
});
