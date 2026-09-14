import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';
import { parameterDefaults } from '../parameters.ts';
import { s7Recipe } from './s7.ts';

const configuration = (overrides: Record<string, unknown> = {}) => ({ ...parameterDefaults(s7Recipe.parameters), nodeId: 'fixture-s7', serviceCode: 'telemetry', host: '192.0.2.20', ...overrides });
const point = (source: string, dataType = 'number', extra: Record<string, unknown> = {}) => ({ source, property: 'temperature', dataType, scale: 1, offset: 0, ...extra });

test('S7 requires an explicit PLC host and provides an independent safe preview', () => {
  assert.equal(s7Recipe.parameters.find(field => field.key === 'host')?.default, '');
  assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ host: '' })), /不能为空/);
  assert.match(String(getBuiltinTemplate(s7Recipe.id)!.flows.find(node => node.type === 's7 endpoint')?.address), /192\.0\.2\./);
});

test('S7 forwards native request timeout, Rack/Slot and reporting mode without changing control', () => {
  const rendered = renderBuiltinTemplate(s7Recipe.id, configuration({ timeoutMs: 1700, rack: 2, slot: 3, interval: 2.5, changesOnly: true, downlinkEnabled: true, commands: [{ cmd: 'set', param: 'value', property: 'temperature' }] }))!;
  const connection = rendered.flows.find(node => node.type === 's7 endpoint')!;
  assert.equal(connection.timeout, 1700); assert.equal(connection.rack, '2'); assert.equal(connection.slot, '3'); assert.equal(connection.cycletime, 2500);
  assert.equal(rendered.flows.find(node => node.type === 's7 in')?.diff, false); assert.ok(rendered.flows.some(node => node.type === 's7 out'));
  assert.equal(renderBuiltinTemplate(s7Recipe.id, configuration())!.flows.find(node => node.type === 's7 endpoint')?.timeout, 3000);
  for (const timeoutMs of [0, 99, 500.5, 60001]) assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ timeoutMs })), /超时/);
  assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ rack: 1.5 })), /整数/);
});

test('S7 diagnoses wrong PLC address and unsupported arrays/date values before deployment, with row labels', () => {
  for (const source of ['DB1.DBD0', 'DB0,REAL0', 'DB65536,REAL0', 'DB1,X0.8', 'DB1,X0', 'DB1,REAL0.2', 'DB1,DT0', 'DB1,STRING0', 'DB1,STRING0.255', 'DB1,REAL2097150', 'MW-1', 'PZB0']) {
    assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ points: [point(source)] })), /第 1 行.*temperature.*(地址|数组|日期|文本|数据块|位)/);
  }
});

test('S7 preserves actual scalar aliases, text arrays, and existing useful scalar conversions', () => {
  for (const [source, dataType] of [['DB1,R0', 'number'], ['DB1,RWORD4', 'number'], ['EW0', 'number'], ['AD0', 'number'], ['MRW4', 'number'], ['PIW0', 'number'], ['DB1,C0.10', 'string'], ['DB1,S0.10', 'string'], ['DB1,REAL0.1', 'number'], ['T0', 'number'], ['C0', 'number'], ['DB1,X0.1', 'boolean'], ['DB1,INT0', 'string'], ['DB1,BYTE0', 'boolean']]) {
    const flows = renderBuiltinTemplate(s7Recipe.id, configuration({ points: [point(source!, dataType)] }))!.flows;
    assert.deepEqual(flows.find(node => node.type === 's7 endpoint')?.vartable, [{ name: 'raw_0', addr: source }]);
  }
  assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ points: [point('DB1,X0.1', 'number')] })), /第 1 行.*temperature.*布尔/);
  assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ points: [point('DB1,C0.10', 'boolean')] })), /第 1 行.*temperature.*文本/);
  assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ points: [point('DB1,INT0', 'string', { scale: 2 })] })), /第 1 行.*temperature.*倍率/);
});


test('S7 observes every real poll and routes decoded samples plus native-only failures through the published uplink', () => {
  const flows = renderBuiltinTemplate(s7Recipe.id, configuration({ changesOnly: true }))!.flows;
  assert.deepEqual(flows.find(node => node.id === 'decode')?.wires, [['presence']]);
  assert.deepEqual(flows.find(node => node.id === 'presence')?.wires, [['device'], ['presence-http']]);
  assert.deepEqual(flows.find(node => node.id === 'presence-status')?.scope, ['input', 'connection']);
  assert.deepEqual(flows.find(node => node.id === 'presence-errors')?.scope, ['input', 'connection']);
  assert.equal(flows.filter(node => node.type === 'tl-uplink').length, 1);
  assert.equal(flows.some(node => node.type === 'exec'), false);
  assert.throws(() => renderBuiltinTemplate(s7Recipe.id, configuration({ nodeId: 'bad/device' })), /子设备标识/);
});
