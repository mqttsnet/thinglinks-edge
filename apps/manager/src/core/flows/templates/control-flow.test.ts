import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { getBuiltinTemplate, renderBuiltinTemplate } from './catalog.ts';
import { parameterDefaults } from './parameters.ts';

function params(id: string): Record<string, unknown> {
  const fields = getBuiltinTemplate(id)!.parameters!;
  return {
    ...parameterDefaults(fields),
    ...(fields.some(field => field.key === 'url') ? { url: 'http://192.0.2.10/data' } : {}),
    ...(fields.some(field => field.key === 'endpoint') ? { endpoint: 'opc.tcp://192.0.2.10:4840' } : {}),
    nodeId: 'plc-1',
    serviceCode: 'env',
    host: '127.0.0.1',
    downlinkEnabled: true,
    commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }],
  };
}
test('available control templates expose opt-in command handling without embedding credentials', () => {
  for (const id of ['tcp', 'udp', 'http-poll', 'http-receive', 's7']) {
    const p = params(`builtin:${id}`);
    if (!getBuiltinTemplate(`builtin:${id}`)!.parameters!.some((f) => f.key === 'host')) delete p.host;
    const flow = renderBuiltinTemplate(`builtin:${id}`, p)!;
    assert.ok(flow.flows.some((n) => n.id === 'control-poll'));
    assert.ok(flow.flows.some((n) => n.id === 'control-result-http'));
    for (const node of flow.flows)
      if (node.type === 'function') {
        assert.doesNotThrow(() => new Script(`(function(msg){${String(node.func)}})`), `${id}: ${node.id}`);
      }
    assert.ok(!JSON.stringify(flow.flows).includes('protocol-fixture-only'));
    const writer = flow.flows.find((n) => n.id === 'control-writer')!;
    assert.ok(writer);
    if (id === 's7')
      assert.ok(
        flow.flows.some((n) => n.type === 'complete' && (n.scope as string[]).includes('control-writer')),
      );
  }
});
test('control rejects undeclared properties, duplicate commands, zero scale and binary network control', () => {
  const p = params('builtin:tcp');
  assert.throws(() =>
    renderBuiltinTemplate('builtin:tcp', {
      ...p,
      commands: [{ cmd: 'setTemperature', param: 'value', property: 'missing' }],
    }),
  );
  assert.throws(() =>
    renderBuiltinTemplate('builtin:tcp', {
      ...p,
      commands: [...(p.commands as unknown[]), ...(p.commands as unknown[])],
    }),
  );
  assert.throws(() =>
    renderBuiltinTemplate('builtin:tcp', {
      ...p,
      points: [{ source: 'temperature', property: 'temperature', dataType: 'number', scale: 0, offset: 0 }],
    }),
  );
  assert.throws(() =>
    renderBuiltinTemplate('builtin:tcp', {
      ...p,
      format: 'binary',
      points: [{ source: '0', property: 'temperature', dataType: 'uint16be', scale: 1, offset: 0 }],
    }),
  );
});

test('multi-service S7 commands use one private controller and the same raw aliases as its one endpoint', () => {
  const flow = renderBuiltinTemplate('builtin:s7', {
    ...params('builtin:s7'), serviceCode: '',
    points: [
      { serviceCode: 'motor', property: 'speed', source: 'DB1,WORD0', dataType: 'number', scale: 1, offset: 0 },
      { serviceCode: 'fan', property: 'speed', source: 'DB1,WORD2', dataType: 'number', scale: 2, offset: 0 },
    ],
    commands: [
      { serviceCode: 'motor', cmd: 'set', param: 'value', property: 'speed' },
      { serviceCode: 'fan', cmd: 'set', param: 'value', property: 'speed' },
    ],
  })!.flows;
  assert.equal(flow.filter(node => node.id === 'control-controller').length, 1);
  assert.equal(flow.filter(node => node.type === 's7 out').length, 1);
  const controller = flow.find(node => node.id === 'control-controller')!;
  assert.match(String(controller.initialize), /globalThis/);
  assert.doesNotMatch(String(controller.func), /flow\.(get|set)/);
  assert.deepEqual((controller.wires as string[][])[5], ['control-writer']);
  const encoder = flow.find(node => node.id === 'control-encode')!;
  assert.deepEqual(encoder.wires, [['control-controller']], 'encoded writes return to the lease/generation gate');
  const msg = { payload: { command: { id: 'service-write', leaseToken: 'lease-fixture', leaseDeadline: Date.now() + 30000,
    deviceIdentification: 'plc-1', serviceCode: 'fan', cmd: 'set', params: { value: 20 } } } };
  const encoded = runInNewContext(`(function(msg){${String(encoder.func)}})(msg)`, { msg, Buffer, URL,
    node: { error(message: string) { assert.fail(message); } } });
  assert.equal(encoded.variable, 'raw_1'); assert.equal(encoded.payload, 10); assert.equal(encoded._tlePrepared, true);
  assert.equal(encoded._tleWriteAttempted, false);
});


test('OPC UA remains acquisition-capable but declares unavailable control and refuses enabling it', () => {
  const template = getBuiltinTemplate('builtin:opcua')!;
  const toggle = template.parameters!.find(field => field.key === 'downlinkEnabled')!;
  assert.equal(toggle.default, false);
  assert.match(toggle.disabledReason ?? '', /当前受管实例支持采集.*独立受控执行节点/);
  const input = params('builtin:opcua'); delete input.host;
  assert.throws(() => renderBuiltinTemplate(template.id, input), /当前受管实例支持采集.*独立受控执行节点/);
  const read = renderBuiltinTemplate(template.id, {...input,downlinkEnabled:false})!;
  assert.ok(read.flows.some(node => node.type === 'OpcUa-Client'));
  assert.equal(read.flows.some(node => node.type === 'exec'), false);
});

test('Modbus acquisition stays available but late-write risk disables and rejects generated cloud control', () => {
  const template = getBuiltinTemplate('builtin:modbus-tcp')!;
  const toggle = template.parameters!.find(field => field.key === 'downlinkEnabled')!;
  const commands = template.parameters!.find(field => field.key === 'commands')!;
  assert.equal(toggle.default, false);
  assert.match(toggle.disabledReason ?? '', /Modbus.*采集.*断网.*迟到/);
  assert.doesNotMatch(toggle.disabledReason ?? '', /独立受控执行节点/);
  assert.equal(commands.disabledReason, toggle.disabledReason);
  assert.throws(() => renderBuiltinTemplate(template.id, params(template.id)), /Modbus.*采集.*断网.*迟到/);
  const read = renderBuiltinTemplate(template.id, { ...params(template.id), downlinkEnabled: false })!;
  assert.ok(read.flows.some(node => node.type === 'modbus-flex-getter'));
  assert.ok(read.flows.some(node => node.type === 'tl-uplink'));
  assert.equal(read.flows.some(node => node.type === 'modbus-flex-write' || node.id === 'control-poll'), false);
  assert.ok(read.requirements!.some(requirement => requirement.module === 'node-red-contrib-modbus' && requirement.version === '5.60.2'));
});
