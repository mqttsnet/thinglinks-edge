import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autocompleteChoices, modelFieldOptions, mappingIssues, parameterGroups, modelQueryIdentity } from './cloud-model.ts';
import type { CloudProductModel, TemplateParameter } from '../../api/types.ts';
const model: CloudProductModel = { productIdentification: 'meter-product', services: [
  { serviceCode: 'electrical', serviceName: '电力数据', properties: [
    { propertyCode: 'voltage', propertyName: '电压', datatype: 'float', unit: 'V', method: 'r' },
    { propertyCode: 'setpoint', propertyName: '目标值', datatype: 'int', unit: '', method: 'rw' },
  ], commands: [
    { commandCode: 'set', commandName: '设置目标值', requests: [{ parameterCode: 'target', datatype: 'int', required: true, min: 0, max: 100 }], responses: [] },
    { commandCode: 'reset', commandName: '复位', requests: [{ parameterCode: 'mode', datatype: 'int', required: true }], responses: [] },
  ] },
] };
const values = { serviceCode: 'electrical', points: [{ property: 'voltage' }, { property: 'setpoint' }] };

test('model suggestions use actual cloud codes and scoped command parameters', () => {
  assert.deepEqual(modelFieldOptions('serviceCode', values, model).map(o => o.value), ['electrical']);
  assert.match(modelFieldOptions('serviceCode', values, model)[0]!.label, /电力数据/);
  assert.deepEqual(modelFieldOptions('property', values, model, 'points').map(o => o.value), ['voltage', 'setpoint']);
  assert.deepEqual(modelFieldOptions('cmd', values, model, 'commands').map(o => o.value), ['set', 'reset']);
  assert.deepEqual(modelFieldOptions('param', values, model, 'commands', { cmd: 'reset' }).map(o => o.value), ['mode']);
  assert.match(modelFieldOptions('param', values, model, 'commands', { cmd: 'set' })[0]!.label, /必填.*最小 0.*最大 100/);
  assert.deepEqual(modelFieldOptions('property', values, model, 'commands').map(o => o.value), ['voltage', 'setpoint']);
  assert.deepEqual(modelFieldOptions('param', values, model, 'commands', { cmd: 'unknown' }), []);
});

test('manual values survive missing cloud metadata and unmatched mappings are explicit', () => {
  const configured = { serviceCode: 'electrical', points: [{ property: 'old-code' }], commands: [{ cmd: 'set', param: 'obsolete', property: 'old-code' }], downlinkEnabled: true };
  const before = JSON.stringify(configured);
  assert.deepEqual(modelFieldOptions('serviceCode', configured, null), []);
  assert.ok(mappingIssues(configured, model).some(issue => issue.includes('old-code')));
  assert.ok(mappingIssues(configured, model).some(issue => issue.includes('obsolete')));
  assert.equal(JSON.stringify(configured), before);
});

test('hidden command fields preserve values and advanced fields stay separate', () => {
  const fields: TemplateParameter[] = [
    { key: 'host', label: '设备地址', type: 'text', group: 'device' },
    { key: 'timeout', label: '超时', type: 'number', group: 'advanced' },
    { key: 'commands', label: '命令映射', type: 'table', group: 'commands', visibleWhen: { key: 'downlinkEnabled', value: true } },
  ];
  const input = { downlinkEnabled: false, commands: [{ cmd: 'set' }] };
  assert.deepEqual(parameterGroups(fields, input).flatMap(group => group.fields.map(f => f.key)), ['host', 'timeout']);
  assert.equal(input.commands[0]!.cmd, 'set');
  assert.ok(parameterGroups(fields, { ...input, downlinkEnabled: true }).some(group => group.id === 'commands'));
});

test('model query identity requires an explicit product and includes version changes', () => {
  assert.equal(modelQueryIdentity({ productIdentification: ' ', versionNo: 'v1' }), '');
  assert.notEqual(modelQueryIdentity({ productIdentification: 'a', versionNo: 'v1' }), modelQueryIdentity({ productIdentification: 'a', versionNo: 'v2' }));
});

test('autocomplete stores protocol codes while displaying human readable names', () => {
  assert.deepEqual(autocompleteChoices([{ value: 'environment', label: '环境数据（environment）' }]), [
    { value: 'environment', label: 'environment', displayLabel: '环境数据（environment）' },
  ]);
});

const multiModel: CloudProductModel = { ...model, services: [...(model.services ?? []), {
  serviceCode: 'environment', serviceName: '环境', properties: [{ propertyCode: 'voltage', propertyName: '另一组电压', datatype: 'float' }],
  commands: [{ commandCode: 'set', requests: [{ parameterCode: 'value', datatype: 'float' }], responses: [] }],
}] };
test('row service scopes point, command and parameter suggestions without erasing the default', () => {
  assert.equal(modelFieldOptions('serviceCode', values, multiModel, 'points').length, 2);
  assert.deepEqual(modelFieldOptions('property', values, multiModel, 'points', { serviceCode: 'environment' }).map(x => x.value), ['voltage']);
  assert.deepEqual(modelFieldOptions('param', values, multiModel, 'commands', { serviceCode: 'environment', cmd: 'set' }).map(x => x.value), ['value']);
  const mapped = { ...values, points: [{ property: 'setpoint' }, { serviceCode: 'environment', property: 'voltage' }] };
  assert.deepEqual(modelFieldOptions('property', mapped, multiModel, 'commands', { targetServiceCode: 'environment' }).map(x => x.value), ['voltage']);
});
test('cross-service identical property names remain distinct and command targets match the selected target service', () => {
  const configured = { serviceCode: '', points: [
    { serviceCode: 'electrical', property: 'voltage' }, { serviceCode: 'environment', property: 'voltage' },
  ], downlinkEnabled: true, commands: [{ serviceCode: 'environment', cmd: 'set', param: 'value', targetServiceCode: 'electrical', property: 'voltage' }] };
  assert.deepEqual(mappingIssues(configured, multiModel), []);
  assert.ok(mappingIssues({ ...configured, points: [...configured.points, configured.points[0]] }, multiModel).some(x => /重复/.test(x)));
  assert.ok(mappingIssues({ ...configured, commands: [{ ...configured.commands[0], targetServiceCode: 'missing' }] }, multiModel).some(x => /missing/.test(x)));
  assert.ok(mappingIssues({ serviceCode: '', points: [{ property: 'voltage' }] }, null).some(x => /服务/.test(x)));
});
