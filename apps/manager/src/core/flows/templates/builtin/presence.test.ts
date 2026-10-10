import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listBuiltinTemplates,renderBuiltinTemplate } from '../catalog.ts';
import { parameterDefaults } from '../parameters.ts';
test('every protocol recipe routes only decoded data through an independently leased observer',()=>{
 for(const template of listBuiltinTemplates()){
 const p={...parameterDefaults(template.parameters??[]),nodeId:'device',serviceCode:'telemetry'};
 if('host' in p)p.host='192.0.2.1';if('url' in p)p.url='http://192.0.2.1/data';if('endpoint' in p)p.endpoint='opc.tcp://192.0.2.1:4840';
 const flows=renderBuiltinTemplate(template.id,p)!.flows;
 assert.deepEqual(flows.find(n=>n.id==='decode')?.wires,[['presence']],template.id);
 assert.ok(flows.find(n=>n.id==='presence')?.initialize,template.id);
 assert.ok(flows.find(n=>n.id==='presence-http'),template.id);
 if(template.id==='builtin:http-receive')assert.equal(flows.some(n=>n.type==='tl-uplink'),false);
 else assert.deepEqual(flows.find(n=>n.id==='device')!.wires,[['uplink']]);
 }
});
test('connectionless recipes default to no silence deadline; opted in deadlines are validated',()=>{
 for(const id of ['builtin:udp','builtin:http-receive']){
  const template=listBuiltinTemplates().find(t=>t.id===id)!;
  assert.equal(parameterDefaults(template.parameters??[]).silenceTimeout,0);
  const identity={nodeId:'device',serviceCode:'telemetry'};
  assert.match(String(renderBuiltinTemplate(id,{...identity,silenceTimeout:30})!.flows.find(n=>n.id==='presence')!.func),/"silenceTimeoutMs":30000/);
  for(const value of [-1,NaN,Infinity])assert.throws(()=>renderBuiltinTemplate(id,{...identity,silenceTimeout:value}));
 }
});
test('template-owned connection settings belong to the same tab for independent deployment',()=>{
 for(const id of ['builtin:s7','builtin:modbus-tcp','builtin:opcua','builtin:opcua-controlled']){
  const template=listBuiltinTemplates().find(t=>t.id===id)!;
  const p={...parameterDefaults(template.parameters??[]),nodeId:'device',serviceCode:'telemetry'};
  if('host' in p)p.host='192.0.2.1';if('endpoint' in p)p.endpoint='opc.tcp://192.0.2.1:4840';
  const flows=renderBuiltinTemplate(id,p)!.flows;
  assert.equal(flows.find(n=>n.id==='connection')!.z,'tab',id);
 }
});
