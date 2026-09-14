import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';
import { parameterDefaults } from '../parameters.ts';
import { controlledOpcuaRecipe } from './opcua-controlled.ts';

const configuration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...parameterDefaults(controlledOpcuaRecipe.parameters), nodeId: 'fixture-opcua', serviceCode: 'telemetry',
  endpoint: 'opc.tcp://192.0.2.10:4840/UA/Server', ...overrides,
});
const point = (source: string, extra: Record<string, unknown> = {}) => ({ source, property: 'temperature', dataType: 'Double', scale: 1, offset: 0, ...extra });

test('secure OPC UA recipe has no executable loopback default and keeps explicit catalogue previews', () => {
  assert.equal(controlledOpcuaRecipe.parameters.find(field => field.key === 'endpoint')?.default, '');
  assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ endpoint: '' })), /不能为空/);
  assert.match(String(getBuiltinTemplate(controlledOpcuaRecipe.id)!.flows.find(node => node.type === 'tier0-opcua-connection')?.endpoint), /192\.0\.2\./);
});

test('secure OPC UA shares strict row-aware NodeId and duplicate validation', () => {
  for (const source of ['ns=70000;i=1', 'ns=1;i=-1', 'ns=1;i=4294967296', 'ns=1;g=123', 'ns=1;b=AQ=', 'ns=1;s=Temp;datatype=Double']) {
    assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ points: [point(source)] })), /第 1 行.*temperature.*NodeId/);
  }
  assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ points: [point('ns=01;i=1'), point('ns=1;i=01', { property: 'copy' })] })), /第 2 行.*copy.*重复/);
  assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ points: [point('ns=1;s=Label', { dataType: 'String', offset: 2 })] })), /第 1 行.*temperature.*倍率|第 1 行.*temperature.*偏移/);
});

test('existing OPC UA security and write contracts remain explicit and unchanged', () => {
  const secure = { securityPolicy: 'Basic256Sha256', securityMode: 'SignAndEncrypt', certificateFile: '/data/certs/client.pem', privateKeyFile: '/data/certs/client.key', trustedCertificates: '/data/certs/server.pem' };
  const result = renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ ...secure, downlinkEnabled: true, commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }] }))!;
  const connection = result.flows.find(node => node.type === 'tier0-opcua-connection')!;
  assert.equal(connection.securityPolicy, 'Basic256Sha256'); assert.equal(connection.securityMode, 'SignAndEncrypt');
  assert.deepEqual(connection.trustedCertificates, ['/data/certs/server.pem']); assert.equal(connection.user, ''); assert.equal(connection.commandQueueSize, 1);
  assert.ok(result.flows.some(node => node.type === 'tier0-opcua-write')); assert.ok(result.flows.some(node => node.type === 'tl-uplink'));
  assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ ...secure, trustedCertificates: '' })), /信任证书/);
  assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ ...secure, securityMode: 'None' })), /策略与模式/);
  assert.throws(() => renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ ...secure, privateKeyFile: '../secret.key' })), /实例内.*路径/);
});

test('canonical NodeId is identical in returned parameters, native reads, read mapping and control targets', () => {
  const input = configuration({ points: [point('ns=0001;i=00042', { scale: 2, offset: 1 })], downlinkEnabled: true, commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }] });
  const result = renderBuiltinTemplate(controlledOpcuaRecipe.id, input)!;
  const canonical = 'ns=1;i=42';
  assert.equal((result.parameterValues!.points as Record<string, unknown>[])[0]!.source, canonical);
  assert.equal((input.points as Record<string, unknown>[])[0]!.source, 'ns=0001;i=00042', 'caller input must remain unchanged');
  assert.deepEqual(JSON.parse(String(result.flows.find(node => node.type === 'tier0-opcua-read')?.pointList)), [{ nodeId: canonical, alias: 'temperature' }]);
  const decode = String(result.flows.find(node => node.id === 'decode')?.func), errors: string[] = [];
  const message = { payload: [{ nodeId: canonical, alias: 'temperature', statusCode: 'Good', value: 5 }], opcua: { operation: 'read', total: 1, good: 1, resultDetail: 'compact' } };
  const mapped = vm.runInNewContext(`(function(){${decode}})()`, { msg: message, Buffer, node: { error: (error: string) => errors.push(error) } }) as { payload: Record<string, unknown> };
  assert.equal(errors.length, 0); assert.equal(mapped.payload.temperature, 11);
  const prepare = String(result.flows.find(node => node.id === 'control-opcua-prepare')?.func);
  const write = vm.runInNewContext(`(function(){${prepare}})()`, { msg: { topic: canonical + ';datatype=Double', payload: 5, _tleCommand: { leaseDeadline: Date.now() + 30000 } }, node: { error: (error: string) => errors.push(error) } }) as { payload: Array<{ nodeId: string }> };
  assert.equal(write.payload[0]!.nodeId, canonical); assert.deepEqual(errors, []);
});

test('String NodeId identifiers retain trailing spaces through validation and every generated target', () => {
  const source = 'ns=1;s= Temperature ';
  const result = renderBuiltinTemplate(controlledOpcuaRecipe.id, configuration({ points: [point(source)] }))!;
  assert.equal((result.parameterValues!.points as Record<string, unknown>[])[0]!.source, source);
  assert.equal(JSON.parse(String(result.flows.find(node => node.type === 'tier0-opcua-read')?.pointList))[0].nodeId, source);
  assert.equal(controlledOpcuaRecipe.parameters.find(field => field.key === 'points')?.columns?.find(column => column.key === 'source')?.preserveWhitespace, true);
});
