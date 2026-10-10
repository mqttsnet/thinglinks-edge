import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';

const point = (source: string, serviceCode: string, property = 'value', dataType = 'number') => ({ source, serviceCode, property, dataType, scale: 1, offset: 0 });
const render = (id: string, points: Record<string, unknown>[], extra = {}) => renderBuiltinTemplate(id, { nodeId: 'multi-device', serviceCode: '', ...(id.includes('opcua') ? { endpoint: 'opc.tcp://192.0.2.1:4840' } : { host: '192.0.2.1' }), points, ...extra })!;
const decode = (flow: ReturnType<typeof render>, msg: Record<string, unknown>) => {
  const errors: string[] = [];
  const result = runInNewContext(`(function(msg,node){${flow.flows.find(n => n.id === 'decode')!.func}})(msg,node)`, { msg, Buffer, node: { error: (s: string) => errors.push(s) } });
  return { result, errors };
};

test('all template schemas expose a default service plus an optional per-point service', () => {
  for (const id of ['tcp', 'udp', 'http-poll', 'http-receive', 'modbus-tcp', 's7', 'opcua', 'opcua-controlled']) {
    const template = getBuiltinTemplate(`builtin:${id}`)!;
    assert.equal(template.parameters!.find(p => p.key === 'serviceCode')!.required, false);
    assert.equal(template.parameters!.find(p => p.key === 'points')!.columns!.find(c => c.key === 'serviceCode')!.required, undefined);
  }
});

test('S7 reads each physical source/type once and maps equal property names by service', () => {
  const points = [point('DB1,REAL0', 'a'), point('DB1,REAL4', 'b'), point('DB1,REAL0', 'b', 'copy')];
  const flow = render('builtin:s7', points);
  assert.deepEqual(flow.flows.find(n => n.type === 's7 endpoint')!.vartable, [
    { name: 'raw_0', addr: 'DB1,REAL0' }, { name: 'raw_1', addr: 'DB1,REAL4' },
  ]);
  const r = decode(flow, { payload: { raw_0: 20, raw_1: 8 } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result._tleServices)), [{ serviceCode: 'a', values: { value: 20 } }, { serviceCode: 'b', values: { value: 8, copy: 20 } }]);
  assert.equal(flow.flows.filter(n => n.type === 's7 in').length, 1);
  assert.equal(flow.flows.find(n => n.type === 'tl-uplink')!.serviceId, '');
  assert.equal(flow.parameterValues!.points && JSON.stringify(flow.parameterValues!.points).includes('raw_'), false);
});

test('secure OPC UA aliases and complete-result validation retain each service without rereading reused variables', () => {
  const flow = render('builtin:opcua-controlled', [point('ns=2;s=A', 'a', 'value', 'Double'), point('ns=2;s=B', 'b', 'value', 'Double'), point('ns=2;s=A', 'b', 'copy', 'Double')]);
  assert.deepEqual(JSON.parse(String(flow.flows.find(n => n.type === 'tier0-opcua-read')!.pointList)), [{ nodeId: 'ns=2;s=A', alias: 'raw_0' }, { nodeId: 'ns=2;s=B', alias: 'raw_1' }]);
  const msg = { payload: [{ nodeId: 'ns=2;s=B', alias: 'raw_1', value: 8, statusCode: 'Good' }, { nodeId: 'ns=2;s=A', alias: 'raw_0', value: 20, statusCode: 'Good' }], opcua: { operation: 'read', total: 2, good: 2, resultDetail: 'compact' } };
  const r = decode(flow, msg);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result._tleServices)), [{ serviceCode: 'a', values: { value: 20 } }, { serviceCode: 'b', values: { value: 8, copy: 20 } }]);
});

test('OPC UA compatibility subscriptions subscribe once per source and fan out each valid notification', () => {
  const flow = render('builtin:opcua', [point('ns=2;s=A', 'a', 'value', 'Double'), point('ns=2;s=A', 'b', 'value', 'Double')], { action: 'subscribe' });
  assert.equal(flow.flows.filter(n => n.type === 'OpcUa-Item').length, 2, 'one primary plus one independent health read');
  const r = decode(flow, { topic: 'ns=2;s=A', payload: 12, statusCode: { value: 0 } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result._tleServices)), [{ serviceCode: 'a', values: { value: 12 } }, { serviceCode: 'b', values: { value: 12 } }]);
});

test('template validation permits repeated property names only across different services', () => {
  assert.doesNotThrow(() => render('builtin:tcp', [point('a', 'a'), point('b', 'b')]));
  assert.throws(() => render('builtin:tcp', [point('a', 'a'), point('b', 'a')]), /重复/);
  assert.throws(() => render('builtin:tcp', [point('a', '')]), /服务编码/);
});

test('300 Modbus points share one physical round and split into service groups only after decoding', () => {
  const points = Array.from({ length: 300 }, (_, i) => point(String(i * 2), i < 150 ? 'a' : 'b', `p${i % 150}`, 'uint32be'));
  const flow = render('builtin:modbus-tcp', points, { quantity: 600 });
  assert.equal(flow.flows.filter(n => n.type === 'modbus-client').length, 1);
  assert.equal(flow.flows.filter(n => n.type === 'modbus-flex-getter').length, 1);
  assert.equal(flow.flows.filter(n => n.id === 'modbus-cycle').length, 1);
  const r = decode(flow, { payload: Array.from({ length: 600 }, (_, i) => i % 2 ? Math.floor(i / 2) : 0) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Array.from(r.result._tleServices, (group: { values: object }) => Object.keys(group.values).length), [150, 150]);
  assert.equal(r.result._tleServices[0].values.p149, 149);
  assert.equal(r.result._tleServices[1].values.p149, 299);
  assert.equal(flow.flows.filter(n => n.type === 'tl-uplink').length, 1);
});
