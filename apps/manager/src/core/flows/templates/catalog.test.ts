import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listBuiltinTemplates, getBuiltinTemplate, renderBuiltinTemplate } from './catalog.ts';
import { parameterDefaults } from './parameters.ts';

test('categorized recipes preserve the first seven and add an independent controlled OPC UA template', () => {
  const list = listBuiltinTemplates();
  assert.equal(list.length, 8);
  assert.equal(new Set(list.map((t) => t.id)).size, list.length);
  assert.deepEqual(
    new Set(list.flatMap((t) => t.protocols ?? [])),
    new Set(['tcp', 'udp', 'http', 'modbus-tcp', 'opcua', 's7']),
  );
  for (const template of list) {
    assert.equal(template.origin, 'builtin');
    const example = getBuiltinTemplate(template.id)!;
    assert.ok(example.flows.filter((n) => n.type === 'tab').every((n) => n.disabled === true));
    assert.ok(example.requirements?.some((r) => r.nodeTypes.includes('tl-uplink')));
    example.flows[0]!.label = 'modified';
    assert.notEqual(getBuiltinTemplate(template.id)!.flows[0]!.label, 'modified');
  }
});
test('all recipes render cloud identity and actual upstream node configuration', () => {
  for (const t of listBuiltinTemplates()) {
    const parameters = {
      ...parameterDefaults(t.parameters ?? []),
      nodeId: 'plc-1',
      serviceCode: 'telemetry',
    };
    if ('host' in parameters) Object.assign(parameters, { host: '192.168.1.10' });
    const result = renderBuiltinTemplate(t.id, parameters)!;
    assert.equal(result.flows.find((n) => n.type === 'tab')!.disabled, false);
    assert.equal(result.flows.find((n) => n.type === 'tl-uplink')!.deviceId, 'plc-1');
    assert.equal(result.flows.find((n) => n.type === 'tl-uplink')!.serviceId, 'telemetry');
    const ids = new Set(result.flows.map((n) => n.id));
    assert.equal(ids.size, result.flows.length);
    for (const n of result.flows)
      for (const wire of (n.wires ?? []) as string[][]) {
        for (const id of wire) assert.ok(ids.has(id), `dangling ${t.id} wire ${id}`);
      }
  }
});
test('required cloud identity, duplicate mappings and unsafe endpoints are rejected', () => {
  assert.throws(() => renderBuiltinTemplate('builtin:tcp', {}));
  const t = getBuiltinTemplate('builtin:http-poll')!;
  const p: Record<string, unknown> = {
    ...parameterDefaults(t.parameters ?? []),
    nodeId: 'plc-1',
    serviceCode: 'telemetry',
  };
  assert.throws(() => renderBuiltinTemplate(t.id, { ...p, url: 'file:///etc/passwd' }));
  assert.throws(() => renderBuiltinTemplate(t.id, { ...p, url: 'https://user:password@example.com' }));
  const row = (p.points as Record<string, unknown>[])[0]!;
  assert.throws(() => renderBuiltinTemplate(t.id, { ...p, points: [row, row] }));
});

test('configured renders expose an isolated normalized parameter archive including control mappings', () => {
  const input = { nodeId: '  saved-device  ', serviceCode: 'telemetry', downlinkEnabled: true,
    commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }] };
  const rendered = renderBuiltinTemplate('builtin:tcp', input)!;
  assert.equal(rendered.parameterValues?.nodeId, 'saved-device');
  assert.equal(rendered.parameterValues?.port, 15001);
  assert.equal(rendered.parameterValues?.downlinkEnabled, true);
  assert.deepEqual(rendered.parameterValues?.commands, input.commands);
  input.commands[0]!.cmd = 'changed-outside';
  assert.equal((rendered.parameterValues?.commands as { cmd: string }[])[0]?.cmd, 'setTemperature');
});
