import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';
import { parameterDefaults } from '../parameters.ts';
import { opcuaRecipe } from './opcua.ts';

const configuration = (overrides: Record<string, unknown> = {}) => ({
  ...parameterDefaults(opcuaRecipe.parameters), nodeId: 'fixture-opcua', serviceCode: 'telemetry',
  endpoint: 'opc.tcp://192.0.2.10:4840/UA/Server', ...overrides,
});
const point = (source: string, dataType = 'Double', extra: Record<string, unknown> = {}) => ({ source, property: 'temperature', dataType, scale: 1, offset: 0, ...extra });

test('OPC UA compatibility requires a real endpoint while catalogue previews remain available', () => {
  assert.equal(opcuaRecipe.parameters.find(field => field.key === 'endpoint')?.default, '');
  assert.throws(() => renderBuiltinTemplate(opcuaRecipe.id, configuration({ endpoint: '' })), /不能为空/);
  const preview = getBuiltinTemplate(opcuaRecipe.id)!;
  assert.ok(preview.flows.some(node => node.type === 'tab' && node.disabled === true));
  assert.match(String(preview.flows.find(node => node.type === 'OpcUa-Endpoint')?.endpoint), /192\.0\.2\./);
});

test('compatibility NodeId errors identify the affected row and reject nonstandard numeric/GUID/opaque values', () => {
  for (const source of ['ns=65536;i=1', 'ns=1;i=1oops', 'ns=1;i=4294967296', 'ns=1;g=not-a-guid', 'ns=1;b=%%%=', 'ns=1;s=Temp;datatype=Float', 'ns=1;s=Temp\u0000']) {
    assert.throws(() => renderBuiltinTemplate(opcuaRecipe.id, configuration({ points: [point(source)] })), /第 1 行.*temperature.*NodeId/);
  }
  assert.throws(() => renderBuiltinTemplate(opcuaRecipe.id, configuration({ points: [point('i=42'), point('ns=0;i=42', 'Double', { property: 'copy' })] })), /第 2 行.*copy.*重复/);
});

test('compatibility preserves anonymous read/subscription and rejects ignored scalar conversion settings', () => {
  const flows = renderBuiltinTemplate(opcuaRecipe.id, configuration({ action: 'subscribe', points: [point('ns=1;s=Alarm', 'Boolean')] }))!.flows;
  assert.equal(flows.find(node => node.id === 'poll')?.repeat, '');
  assert.equal(flows.find(node => node.type === 'OpcUa-Client')?.action, 'subscribe');
  const endpoint = flows.find(node => node.type === 'OpcUa-Endpoint')!;
  assert.equal(endpoint.secpol, 'None'); assert.equal(endpoint.login, false);
  assert.ok(flows.some(node => node.type === 'tl-uplink'));
  assert.throws(() => renderBuiltinTemplate(opcuaRecipe.id, configuration({ points: [point('ns=1;s=Alarm', 'Boolean', { scale: 2 })] })), /第 1 行.*temperature.*倍率/);
  assert.throws(() => renderBuiltinTemplate(opcuaRecipe.id, configuration({ downlinkEnabled: true, commands: [{ cmd: 'set', param: 'value', property: 'temperature' }] })), /控制/);
});

test('OPC UA endpoint must not silently accept query strings, invalid target ports or URL control characters', () => {
  for (const endpoint of ['opc.tcp://server:4840/?token=x', 'opc.tcp://server:0', 'opc.tcp://ser\nver:4840', 'opc.tcp://user:password@server:4840']) {
    assert.throws(() => renderBuiltinTemplate(opcuaRecipe.id, configuration({ endpoint })), /地址|URL|端口/);
  }
});

test('compatibility uses the same canonical identifier in native item, mapping and returned values', () => {
  const result = renderBuiltinTemplate(opcuaRecipe.id, configuration({ points: [point('ns=0001;i=00042')] }))!;
  assert.equal(result.flows.find(node => node.type === 'OpcUa-Item')?.item, 'ns=1;i=42');
  assert.equal((result.parameterValues!.points as Record<string, unknown>[])[0]!.source, 'ns=1;i=42');
  assert.match(String(result.flows.find(node => node.id === 'decode')?.func), /ns=1;i=42/);
  const source = 'ns=1;s= Temperature ';
  const stringResult = renderBuiltinTemplate(opcuaRecipe.id, configuration({ points: [point(source)] }))!;
  assert.equal(stringResult.flows.find(node => node.type === 'OpcUa-Item')?.item, source);
  assert.equal((stringResult.parameterValues!.points as Record<string, unknown>[])[0]!.source, source);
});

test('subscription health uses a separate native read client without replacing or disconnecting the subscription',()=>{
 const flows=renderBuiltinTemplate(opcuaRecipe.id,configuration({action:'subscribe'}))!.flows;
 const subscription=flows.find(n=>n.id==='input')!,health=flows.find(n=>n.id==='health-input')!;
 assert.equal(subscription.action,'subscribe');assert.equal(health?.type,'OpcUa-Client');assert.equal(health.action,'read');
 assert.notEqual(health.id,subscription.id);assert.equal(health.endpoint,subscription.endpoint);
 assert.equal(flows.find(n=>n.id==='health-poll')!.repeat,'60');
 assert.deepEqual(health.wires,[['health-decode'],['opc-status','health-presence-source'],[]]);
 assert.deepEqual(flows.find(n=>n.id==='health-decode')!.wires,[['health-presence']]);
 assert.deepEqual(flows.find(n=>n.id==='health-presence')!.wires,[['device'],['health-presence-http']]);
 assert.equal(flows.find(n=>n.id==='health-item-0')!.item,flows.find(n=>n.id==='item-0')!.item);
 for(const id of ['presence-status','presence-errors']){
  assert.deepEqual(flows.find(n=>n.id===id)!.scope,['input']);
  assert.deepEqual(flows.find(n=>n.id==='health-'+id)!.scope,['health-input'],'independent observation scopes protect healthy peer connections');
 }
 assert.match(opcuaRecipe.parameters.find(p=>p.key==='healthInterval')!.description!,/额外.*会话/);
});

test('subscription health interval is configurable, explicitly disabled at zero, and unused in polling mode',()=>{
 assert.equal(parameterDefaults(opcuaRecipe.parameters).healthInterval,60);
 const build=(action:string,healthInterval:number)=>renderBuiltinTemplate(opcuaRecipe.id,configuration({action,healthInterval}))!.flows;
 assert.equal(build('subscribe',30).find(n=>n.id==='health-poll')!.repeat,'30');
 assert.equal(build('subscribe',0).some(n=>n.id==='health-input'),false);
 assert.equal(build('read',60).some(n=>n.id==='health-input'),false);
 for(const n of [-1,0.5,86401])assert.throws(()=>build('subscribe',n));
 assert.match(opcuaRecipe.notes.join('\n'),/关闭.*新.*通知/);
});
