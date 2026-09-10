import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { getBuiltinTemplate, renderBuiltinTemplate } from './catalog.ts';
import { parameterDefaults } from './parameters.ts';

function params(id: string): Record<string, unknown> {
  return {
    ...parameterDefaults(getBuiltinTemplate(id)!.parameters!),
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
  assert.ok(read.flows.some(node => node.type === 'modbus-read'));
  assert.ok(read.flows.some(node => node.type === 'tl-uplink'));
  assert.equal(read.flows.some(node => node.type === 'modbus-flex-write' || node.id === 'control-poll'), false);
  assert.ok(read.requirements!.some(requirement => requirement.module === 'node-red-contrib-modbus' && requirement.version === '5.60.2'));
});
