import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modbusRecipe } from './modbus.ts';
import { TemplateError } from '../../types.ts';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';
import { parameterDefaults, validateParameters } from '../parameters.ts';

const point = (source = '0', dataType = 'uint16be', property = 'temperature') => ({
  source, dataType, property, scale: 0.1, offset: 1,
});
function input(overrides: Record<string, unknown> = {}) {
  return { nodeId: 'plc-1', serviceCode: 'telemetry', host: '192.0.2.10', ...overrides };
}
function build(overrides: Record<string, unknown> = {}) {
  return modbusRecipe.build(validateParameters(modbusRecipe.parameters, input(overrides)));
}

test('Modbus requires an explicit device host while the disabled catalogue remains readable', () => {
  const metadata = getBuiltinTemplate(modbusRecipe.id)!;
  assert.equal(metadata.parameters?.find(field => field.key === 'host')?.default, '');
  assert.equal(parameterDefaults(modbusRecipe.parameters).host, '');
  assert.ok(metadata.flows.find(node => node.type === 'tab')?.disabled);
  for (const host of [undefined, '', '  ']) {
    assert.throws(() => renderBuiltinTemplate(modbusRecipe.id, input({ host })), /设备地址.*不能为空/);
  }
});

test('Modbus guidance distinguishes the remote port, zero-based range and register widths', () => {
  const field = (key: string) => modbusRecipe.parameters.find(item => item.key === key)!;
  assert.match(field('host').description!, /127\.0\.0\.1.*实例/);
  assert.match(field('port').description!, /远端.*不需要.*入站/);
  assert.match(field('address').description!, /40001.*0/);
  assert.match(field('quantity').description!, /16.*1.*32.*2/);
  assert.match(field('points').description!, /相对.*0/);
  assert.match(field('interval').description!, /超时/);
  assert.equal(modbusRecipe.revision, '1.3.0');
});

test('old Modbus parameter archives retain the previous timeout and reconnect defaults', () => {
  const rendered = renderBuiltinTemplate(modbusRecipe.id, input({ interval: 1 }))!;
  const client = rendered.flows.find(node => node.type === 'modbus-client')!;
  assert.equal(client.clientTimeout, 2000);
  assert.equal(client.reconnectTimeout, 5000);
  assert.equal(rendered.flows.find(node => node.id === 'modbus-poll')?.repeat, '1');
  assert.equal(rendered.parameterValues?.clientTimeout, 2000);
  assert.equal(rendered.parameterValues?.reconnectTimeout, 5000);
});

test('Modbus advanced timing values reach the actual Node-RED client without silent adjustment', () => {
  const client = build({ interval: 0.1, clientTimeout: 3500, reconnectTimeout: 7000 })
    .find(node => node.type === 'modbus-client')!;
  assert.equal(client.clientTimeout, 3500);
  assert.equal(client.reconnectTimeout, 7000);
  for (const key of ['clientTimeout', 'reconnectTimeout']) {
    const field = modbusRecipe.parameters.find(item => item.key === key)!;
    assert.equal(field.group, 'advanced');
    assert.equal(field.min, 100);
    assert.equal(field.max, 60000);
  }
});

for (const key of ['clientTimeout', 'reconnectTimeout']) {
  test(`Modbus ${key} accepts boundary milliseconds and rejects invalid or fractional values`, () => {
    for (const value of [100, 60000]) {
      assert.equal(build({ [key]: value }).find(node => node.type === 'modbus-client')?.[key], value);
    }
    for (const value of [0, -1, 99, 60001, 500.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '2000', null]) {
      assert.throws(() => build({ [key]: value }), TemplateError, `${key}: ${String(value)}`);
    }
  });
}

test('Modbus keeps FC3 and FC4, zero-based read addresses and mapped pipeline unchanged', () => {
  for (const registerType of ['HoldingRegister', 'InputRegister']) {
    const flows = build({ registerType, address: 100, quantity: 3,
      points: [point('0'), point('1', 'float32swap', 'pressure')] });
    const read = flows.find(node => node.type === 'modbus-flex-getter')!;
    assert.equal(read.server, 'connection');
    assert.deepEqual(read.wires, [['modbus-cycle'], []]);
    const cycle = String(flows.find(node => node.id === 'modbus-cycle')?.func);
    assert.match(cycle, /"address":100,"quantity":3/);
    assert.match(cycle, new RegExp(`"fc":${registerType === 'InputRegister' ? 4 : 3}`));
    assert.equal(flows.find(node => node.type === 'tl-uplink')?.serviceId, 'telemetry');
    assert.match(String(flows.find(node => node.id === 'decode')?.func), /"source":"1"/);
    assert.match(String(flows.find(node => node.id === 'decode')?.func), /"scale":0\.1,"offset":1/);
  }
  assert.throws(() => build({ registerType: 'Coil' }));
  assert.equal(modbusRecipe.controlSupported, false);
  assert.throws(() => renderBuiltinTemplate(modbusRecipe.id, input({ downlinkEnabled: true })));
});

test('Modbus register address and quantity reject fractional, negative and unsafe integers', () => {
  for (const [key, values] of Object.entries({
    address: [-1, 1.5, 65536, Number.MAX_SAFE_INTEGER + 1],
    quantity: [-1, 0, 1.5, 601, Number.MAX_SAFE_INTEGER + 1],
    unitId: [-1, 1.5, 256, Number.MAX_SAFE_INTEGER + 1],
    port: [0, 502.5, 65536, Number.MAX_SAFE_INTEGER + 1],
  })) {
    for (const value of values) assert.throws(() => build({ [key]: value }), TemplateError, `${key}: ${value}`);
  }
  assert.doesNotThrow(() => build({ address: 65535, quantity: 1, points: [point()] }));
  assert.throws(() => build({ address: 65535, quantity: 2 }), /65535–65536.*0–65535/);
});

test('TCP Unit ID supports native 0 and 255 without changing the default or read-only function codes', () => {
  const field = modbusRecipe.parameters.find(item => item.key === 'unitId')!;
  assert.equal(field.default, 1); assert.equal(field.min, 0); assert.equal(field.max, 255);
  assert.match(field.description!, /串口网关.*1–247.*直连.*0.*255/);
  for (const unitId of [0, 248, 255]) {
    for (const registerType of ['HoldingRegister', 'InputRegister']) {
      const nodes = build({ unitId, registerType });
      assert.equal(nodes.find(node => node.type === 'modbus-client')?.unit_id, unitId);
      const cycle = String(nodes.find(node => node.id === 'modbus-cycle')?.func);
      assert.match(cycle, new RegExp(`"unitId":${unitId},"fc":${registerType === 'InputRegister' ? 4 : 3}`));
    }
  }
});

test('Modbus point overflow identifies the row, cloud property and full required register interval', () => {
  assert.throws(() => build({ address: 100, quantity: 2,
    points: [point(), point('1', 'float32be', 'pressure')] }),
  /第 2 行（pressure）.*2 个寄存器.*1–2.*101–102.*0–1/);
  assert.throws(() => build({ quantity: 1, points: [point('0', 'float32swap')] }),
    /第 1 行（temperature）.*2 个寄存器.*0–1.*0–0/);
  assert.doesNotThrow(() => build({ quantity: 2, points: [point('1', 'uint16be')] }));
  assert.doesNotThrow(() => build({ quantity: 2, points: [point('0', 'float32be')] }));
});

test('Modbus offsets reject fractional, negative and unsafe numbers with an actionable row error', () => {
  for (const source of ['-1', '0.5', '9007199254740992', '1e0', 'Infinity']) {
    assert.throws(() => build({ points: [point(source)] }),
      /第 1 行（temperature）.*非负安全整数.*0–1/, source);
  }
});

test('large Modbus read ranges use a serial native reader and publish only a complete collection round', () => {
  const flows = build({ address: 100, quantity: 300, points: [point('299')] });
  const reader = flows.find(node => node.type === 'modbus-flex-getter');
  assert.ok(reader, 'large ranges require the native flexible reader');
  assert.equal(reader.keepMsgProperties, true);
  assert.deepEqual(reader.wires, [['modbus-cycle'], []]);
  assert.equal(flows.find(node => node.id === 'connection')?.bufferCommands, false);
  const cycle = flows.find(node => node.id === 'modbus-cycle');
  assert.deepEqual(cycle?.wires, [['input'], ['decode']]);
  assert.equal(flows.some(node => node.type === 'modbus-read'), false);
  assert.equal(flows.some(node => node.type === 'exec'), false);
});
