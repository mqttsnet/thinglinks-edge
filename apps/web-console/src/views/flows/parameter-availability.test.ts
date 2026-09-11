import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityFields, parameterDisabled, unavailableParameterIssues, snapshotControlWarnings } from './parameter-availability.ts';
import { templateApplyOptions } from './template-model.ts';
import type { FlowTemplate, TemplateParameter } from '../../api/types.ts';
const field: TemplateParameter = {key:'downlinkEnabled',label:'控制',type:'boolean',default:false,disabledReason:'控制待交付'};

test('unavailable control cannot be enabled, but a saved enabled value can be explicitly turned off', () => {
  assert.equal(parameterDisabled(field,false,false),true);
  assert.equal(parameterDisabled(field,true,false),false);
  assert.equal(parameterDisabled(field,true,true),true);
  assert.deepEqual(unavailableParameterIssues([field],{downlinkEnabled:true}),['控制待交付']);
  assert.deepEqual(unavailableParameterIssues([field],{downlinkEnabled:false}),[]);
});

test('current builtin availability also constrains historical configured copies without mutating their archives', () => {
  const base={name:'OPC',description:'',nodeCount:1,tabCount:1,nodeTypes:[],warnings:[],source:'builtin',createdBy:'system',createdAt:''};
  const builtin:FlowTemplate={...base,id:'builtin:opcua',origin:'builtin',parameters:[field]};
  const archived:TemplateParameter={key:'downlinkEnabled',label:'控制',type:'boolean',default:false};
  const copy:FlowTemplate={...base,id:'saved',origin:'custom',derivedFrom:{templateId:builtin.id,revision:'1'},parameters:[archived],parameterValues:{downlinkEnabled:true}};
  const fields=availabilityFields(copy,[builtin]);
  assert.equal(fields[0]!.disabledReason,'控制待交付');
  assert.equal(archived.disabledReason,undefined);
  assert.equal(copy.parameterValues!.downlinkEnabled,true);
});

function snapshotFixture() {
  const base = { name: 'Modbus', description: '', nodeCount: 2, tabCount: 1, nodeTypes: ['modbus-flex-write'], warnings: [], source: 'builtin', createdBy: 'system', createdAt: '' };
  const restricted = { ...field, disabledReason: 'Modbus 断线后可能迟到写入，请明确关闭旧控制流程并重新部署。' };
  const builtin: FlowTemplate = { ...base, id: 'builtin:modbus-tcp', origin: 'builtin', parameters: [restricted] };
  const archived = { ...field }; delete archived.disabledReason;
  const copy: FlowTemplate = { ...base, id: 'old-copy', origin: 'custom', derivedFrom: { templateId: builtin.id, revision: '1' },
    parameters: [archived], parameterValues: { downlinkEnabled: true }, notes: ['历史说明'] };
  return { builtin, copy, reason: restricted.disabledReason };
}

test('saved control snapshots show current trusted restrictions without changing snapshot deployment', () => {
  const { builtin, copy, reason } = snapshotFixture();
  const before = JSON.stringify(copy);
  assert.deepEqual(snapshotControlWarnings(copy, [builtin], 'snapshot'), [reason]);
  assert.deepEqual(templateApplyOptions(copy, 'append', {}, undefined, 'snapshot'), { mode: 'append' });
  assert.equal(JSON.stringify(copy), before);
  assert.deepEqual(snapshotControlWarnings(copy, [builtin], 'parameters'), []);
  assert.deepEqual(snapshotControlWarnings({ ...copy, parameterValues: { downlinkEnabled: false } }, [builtin], 'snapshot'), []);
});

test('legacy snapshots without parameter archives retain the current control risk notice', () => {
  const { builtin, copy, reason } = snapshotFixture();
  const legacy = { ...copy }; delete legacy.parameters; delete legacy.parameterValues;
  assert.deepEqual(snapshotControlWarnings(legacy, [builtin], 'parameters'), [reason]);
});

test('snapshot warnings cannot come from editable protocol tags or stale archived restrictions', () => {
  const { builtin, copy } = snapshotFixture();
  const uploaded = { ...copy, protocols: ['modbus-tcp'] }; delete uploaded.derivedFrom;
  assert.deepEqual(snapshotControlWarnings(uploaded, [builtin], 'snapshot'), []);
  assert.deepEqual(snapshotControlWarnings(copy, [], 'snapshot'), []);
  assert.deepEqual(snapshotControlWarnings(copy, [{ ...builtin, origin: 'custom' }], 'snapshot'), []);
  const enabled = { ...field }; delete enabled.disabledReason;
  const available = { ...builtin, parameters: [enabled] };
  assert.deepEqual(snapshotControlWarnings({ ...copy, parameters: [field] }, [available], 'snapshot'), []);
});
