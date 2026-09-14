import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InstanceRepo } from '../../instance/repo.ts';
import type { DockerClient } from '../../instance/docker-client.ts';
import { diagnosticRuntime } from './adapters.ts';

test('runtime adapter verifies owner and exact callback environment without exposing it',async()=>{
 const repo={get:()=>({credSecret:'fake-generation-secret'}),ingestToken:()=> 'fake-ingest-token'} as unknown as InstanceRepo;
 const info={Id:'immutable-runtime',Config:{Labels:{'com.mqttsnet.thinglinks-edge.managed':'true','com.mqttsnet.thinglinks-edge.instance':'a'},Env:['TLE_INGEST_TOKEN=fake-ingest-token','TLE_MANAGER_URL=http://manager:9100']},State:{Running:true}};
 const docker={containerRef:()=>({inspect:async()=>info}),expectedMigrationEnvironment:()=>({managerUrl:'http://manager:9100'})} as unknown as DockerClient;
 const runtime=diagnosticRuntime(repo,docker);assert.equal((await runtime.inspect('a'))?.callbackReady,true);
 assert.equal(JSON.stringify(await runtime.inspect('a')).includes('fake-ingest'),false);
 info.Config.Env.push('TLE_MANAGER_URL=http://other:9100');assert.equal((await runtime.inspect('a'))?.callbackReady,false);
 info.Config.Labels['com.mqttsnet.thinglinks-edge.instance']='b';await assert.rejects(runtime.inspect('a'));
});
test('only a daemon 404 proves an old runtime is gone; authorization and transport failures stay unresolved',async()=>{
 const repo={} as InstanceRepo;let statusCode=403;
 const docker={raw:{getContainer:()=>({inspect:async()=>{throw Object.assign(new Error('daemon error'),{statusCode});}})}} as unknown as DockerClient;
 const runtime=diagnosticRuntime(repo,docker);await assert.rejects(runtime.exists('immutable-runtime'));statusCode=503;await assert.rejects(runtime.exists('immutable-runtime'));statusCode=404;assert.equal(await runtime.exists('immutable-runtime'),false);
});
