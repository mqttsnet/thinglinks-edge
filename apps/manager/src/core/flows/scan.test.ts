import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanInlineSecrets } from './scan.ts';
import type { FlowNode } from './types.ts';
import { getBuiltinTemplate, renderBuiltinTemplate, listBuiltinTemplates } from './templates/catalog.ts';
import { parameterDefaults } from './templates/parameters.ts';

const flows = (): FlowNode[] => [
  { id: 'tab1', type: 'tab', label: '一号产线' },
  { id: 'fn1', type: 'function', z: 'tab1', name: '换算', func: 'return msg;' },
];

test('扫得出 function 节点里硬编码的密钥，并指出是哪个节点', () => {
  const hits = scanInlineSecrets([
    ...flows(),
    { id: 'fn2', type: 'function', name: '上云', func: "const apiKey = 'sk-live-0011223344';" },
  ]);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /function/);
  assert.match(hits[0]!, /上云/, '必须报出是哪个节点，否则等于让人翻几百个节点');
});

test('干净的模板扫不出东西', () => {
  assert.deepEqual(scanInlineSecrets(flows()), []);
});

test('扫描只告警不改内容 —— 剥离会把 function 代码改坏', () => {
  const src: FlowNode[] = [
    { id: 'fn', type: 'function', name: 'f', func: "const password = 'hunter2xyz';" },
  ];
  const copy = JSON.parse(JSON.stringify(src));
  scanInlineSecrets(src);
  assert.deepEqual(src, copy, '扫描必须是只读的');
});

test('真实内置模板含TCP控制和HTTP轮询的运行期令牌不误报固定凭据', () => {
  for (const {id} of listBuiltinTemplates()) {
    const template=getBuiltinTemplate(id)!;
    const controlAvailable = !template.parameters?.find(field => field.key === 'downlinkEnabled')?.disabledReason;
    const parameters:Record<string,unknown>={...parameterDefaults(template.parameters??[]),nodeId:'ui-test',serviceCode:'telemetry',
      downlinkEnabled:controlAvailable,commands:[{cmd:'setTemperature',param:'value',property:'temperature'}]};
    if('host' in parameters)parameters.host='protocol-simulator';
    if('commandHost' in parameters)parameters.commandHost='protocol-simulator';
    if('url' in parameters)parameters.url='http://protocol-simulator:18080/data';
    if('commandUrl' in parameters)parameters.commandUrl='http://protocol-simulator:18080/control';
    const rendered=renderBuiltinTemplate(id,parameters)!;
    assert.deepEqual(scanInlineSecrets(rendered.flows),[],id);
  }
});

test('动态读取、动态Bearer拼接、请求关联token和比较运算均不是固定凭据',()=>{
  const cases=[
    "const token=env.get('TLE_INGEST_TOKEN');msg.headers={authorization:'Bearer '+token};return msg;",
    'const token=process.env.ACCESS_TOKEN;msg.headers["Authorization"]="Bearer "+token;return msg;',
    "const token=String(Date.now())+':'+String(sequence);if(pending.token===request.token)return msg;",
    "if(password === 'string' || token !== 'undefined') return msg;",
    'const token=env.get("ACCESS_TOKEN");msg.headers.Authorization=`Bearer ${token}`;',
    "const signKey=env.get('SIGN_KEY');return msg;",
  ];
  for(const func of cases)assert.deepEqual(scanInlineSecrets([{id:'n',type:'function',func}]),[],func);
});

test('真实固定密码、token、signKey、示例令牌、fallback和URL凭据仍逐节点命中',()=>{
  const cases=[
    "const password='actual-password';return msg;",
    "const token='example-token';msg.headers={authorization:'Bearer '+token};",
    "const signKey='example-sign-key';return msg;",
    "const token=env.get('TOKEN') || 'example-fallback';return msg;",
    "const token=env.get('TOKEN') ?? 'example-fallback';return msg;",
    "const token=flag ? env.get('TOKEN') : 'example-fallback';",
    "msg.headers={'Authorization':'Bearer example-token'};",
    "msg.headers.Authorization='Bearer '+'example-token';",
    "const value='example-token';msg.headers.Authorization='Bearer '+value;",
    'const token=`example-token`;return msg;',
    "const endpoint='mqtts://user:actual-password@broker.example';",
    '// token=example-token\nreturn msg;',
    "const example='Authorization: Bearer example-token';return msg;",
  ];
  for(const func of cases){const nodes:FlowNode[]=[{id:'n',type:'function',name:'登记命令映射与轮询',func}];
    const before=JSON.stringify(nodes);assert.equal(scanInlineSecrets(nodes).length,1,func);assert.equal(JSON.stringify(nodes),before);}
  assert.equal(scanInlineSecrets([{id:'template',type:'template',template:'token=example-token'}]).length,1);
  assert.equal(scanInlineSecrets([{id:'http',type:'http request',url:'https://user:password@device.example/data'}]).length,1);
});

test('tier0 privateKey file references stay clean while inline key material remains visible', () => {
  const connection = { id: 'opc', type: 'tier0-opcua-connection', privateKey: '/data/opcua/client.key' };
  assert.deepEqual(scanInlineSecrets([connection]), []);
  for (const privateKey of ['-----BEGIN PRIVATE KEY-----\nfixture-content\n-----END PRIVATE KEY-----', 'opaque-private-key-value']) {
    assert.equal(scanInlineSecrets([{ ...connection, privateKey }]).length, 1);
  }
  assert.equal(scanInlineSecrets([{ id: 'other', type: 'template', template: '-----BEGIN PRIVATE KEY-----\nfixture-content' }]).length, 1);
});

test('encrypted private keys and privateKeyPassword literals are detected without flagging dynamic credentials', () => {
  const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture-not-a-real-key\n-----END ENCRYPTED PRIVATE KEY-----';
  assert.equal(scanInlineSecrets([{ id: 'template', type: 'template', template: pem }]).length, 1);
  assert.equal(scanInlineSecrets([{ id: 'function', type: 'function', func: `const material=${JSON.stringify(pem)};return msg;` }]).length, 1);
  for (const func of [
    "const privateKeyPassword='fixture-not-a-real-password';return msg;",
    "const private_key_password='fixture-not-a-real-password';return msg;",
    "msg['privateKeyPassword']='fixture-not-a-real-password';return msg;",
    "const privateKeyPassword=env.get('PRIVATE_KEY_PASSWORD') || 'literal-fallback';return msg;",
  ]) assert.equal(scanInlineSecrets([{ id: 'function', type: 'function', func }]).length, 1);
  assert.deepEqual(scanInlineSecrets([{ id: 'function', type: 'function', func: "const privateKeyPassword=env.get('PRIVATE_KEY_PASSWORD');return msg;" }]), []);
  assert.deepEqual(scanInlineSecrets([{ id: 'connection', type: 'tier0-opcua-connection', privateKey: '/data/opcua/client.key' }]), []);
});

test('ordinary node credential objects cannot hide a literal private-key password', () => {
  const node = { id: 'connection', type: 'tier0-opcua-connection', credentials: { privateKeyPassword: 'fixture-not-a-real-password' } };
  assert.equal(scanInlineSecrets([node]).length, 1);
  assert.deepEqual(scanInlineSecrets([{ ...node, credentials: { privateKeyPassword: '' } }]), []);
  assert.deepEqual(scanInlineSecrets([{ ...node, credentials: { privateKeyPassword: '${PRIVATE_KEY_PASSWORD}' } }]), []);
});
