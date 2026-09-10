import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTemplates, initialParameters, newTableRow, previewAllowsDeploy, createPreviewGate } from './template-model.ts';
import type { FlowTemplate, TemplateParameter, ApplyPreview } from '../../api/types.ts';

const template = (overrides: Partial<FlowTemplate>): FlowTemplate => ({
  id: 'custom-1', name: '产线采集', description: '', nodeCount: 2, tabCount: 1,
  nodeTypes: [], source: 'upload', warnings: [], createdBy: 'admin', createdAt: '', ...overrides,
});

test('legacy custom templates filter by custom source/category and protocol search is case insensitive', () => {
  const legacy = template({});
  const modbus = template({ id: 'builtin:modbus', origin: 'builtin', category: 'industrial', protocols: ['modbus-tcp'], name: '电表' });
  assert.deepEqual(filterTemplates([legacy, modbus], { source: 'custom', category: 'custom', protocol: '', search: '' }), [legacy]);
  assert.deepEqual(filterTemplates([legacy, modbus], { source: '', category: '', protocol: '', search: 'MODBUS' }), [modbus]);
  assert.deepEqual(filterTemplates([legacy, modbus], { source: '', category: '', protocol: 's7', search: '' }), []);
});

test('parameter and table row defaults never share mutable values with the schema or another dialog', () => {
  const fields: TemplateParameter[] = [{ key: 'points', label: '点表', type: 'table', default: [{ address: 0 }], columns: [
    { key: 'address', label: '地址', type: 'number', default: 0 }, { key: 'enabled', label: '启用', type: 'boolean', default: true },
  ] }];
  const a = initialParameters(fields); const b = initialParameters(fields);
  (a.points as { address: number }[])[0]!.address = 9;
  assert.equal((b.points as { address: number }[])[0]!.address, 0);
  assert.equal(((fields[0]!.default) as { address: number }[])[0]!.address, 0);
  assert.deepEqual(newTableRow(fields[0]!.columns!), { address: 0, enabled: true });
});

test('builtin deployment fails closed when compatibility or deployable evidence is absent', () => {
  const builtin = template({ origin: 'builtin' });
  const preview: ApplyPreview = { dryRun: true, nodeCount: 2, tabCount: 1, nodeTypes: [], warnings: [], note: '', compat: { ok: true, checked: true, missing: [] } };
  assert.equal(previewAllowsDeploy(builtin, preview), false);
  assert.equal(previewAllowsDeploy(builtin, { ...preview, deployable: true }), true);
  assert.equal(previewAllowsDeploy(builtin, { ...preview, deployable: true, dependencyIssues: ['版本不一致'] }), false);
  assert.equal(previewAllowsDeploy(template({}), preview), true);
  assert.equal(previewAllowsDeploy(template({}), { ...preview, deployable: false }), false);
});

test('changing configuration or starting a newer request invalidates every earlier preview ticket', () => {
  const gate = createPreviewGate();
  const a = gate.begin(); const b = gate.begin();
  assert.equal(gate.current(a), false); assert.equal(gate.current(b), true);
  gate.invalidate(); assert.equal(gate.current(b), false);
});

test('reactive schema objects can initialize table defaults without structuredClone DataCloneError', () => {
  const tableDefault = new Proxy([{ property: 'temperature' }], {});
  const fields: TemplateParameter[] = [{ key: 'points', label: '点表', type: 'table', default: tableDefault }];
  assert.deepEqual(initialParameters(fields), { points: [{ property: 'temperature' }] });
});

test('append deployment requires the server to explicitly confirm append semantics', () => {
  const legacy: ApplyPreview = { dryRun: true, nodeCount: 2, tabCount: 1, nodeTypes: [], warnings: [], note: '', compat: { ok: true, checked: true, missing: [] } };
  assert.equal(previewAllowsDeploy(template({}), legacy, 'append'), false);
  assert.equal(previewAllowsDeploy(template({}), { ...legacy, mode: 'replace' }, 'append'), false);
  assert.equal(previewAllowsDeploy(template({}), { ...legacy, mode: 'append' }, 'append'), true);
});

test('configured custom copies retain the same fail-closed dependency rule as builtin recipes', () => {
  const copy = template({ origin: 'custom', requirements: [{ module: 'driver', version: '1.0.0', nodeTypes: ['driver-in'] }] });
  const preview: ApplyPreview = { dryRun: true, mode: 'append', nodeCount: 2, tabCount: 1, nodeTypes: [], warnings: [], note: '', compat: { ok: true, checked: true, missing: [] } };
  assert.equal(previewAllowsDeploy(copy, preview, 'append'), false);
  assert.equal(previewAllowsDeploy(copy, { ...preview, deployable: true }, 'append'), true);
  assert.equal(previewAllowsDeploy(copy, { ...preview, deployable: true, compat: { ok: true, checked: false, missing: [] } }, 'append'), false);
});

test('trusted configured copies restore saved values over schema defaults without sharing mutable state', async () => {
  const { configurableTemplate, templateParameters, sourceBuiltinId } = await import('./template-model.ts');
  const copy = template({ origin: 'custom', derivedFrom: { templateId: 'builtin:tcp', revision: '1.0.0' },
    parameters: [{ key: 'nodeId', label: '设备', type: 'text', default: '' },
      { key: 'downlinkEnabled', label: '控制', type: 'boolean', default: false },
      { key: 'interval', label: '周期', type: 'number', default: 5 },
      { key: 'points', label: '点表', type: 'table', default: [] }],
    parameterValues: { nodeId: 'line-device', downlinkEnabled: true, points: [{ property: 'pressure' }] },
  });
  assert.equal(configurableTemplate(copy), true);
  assert.equal(sourceBuiltinId(copy), 'builtin:tcp');
  const values = templateParameters(copy);
  assert.deepEqual(values, { nodeId: 'line-device', downlinkEnabled: true, interval: 5, points: [{ property: 'pressure' }] });
  (values.points as {property:string}[])[0]!.property = 'edited';
  assert.equal(((copy.parameterValues!.points) as {property:string}[])[0]!.property, 'pressure');
});

test('legacy snapshots and untrusted custom schema cannot invent editable parameters or request rerender', async () => {
  const { configurableTemplate, templateParameters, templateApplyOptions, sourceBuiltinId } = await import('./template-model.ts');
  const legacy = template({ origin: 'custom', derivedFrom: { templateId: 'builtin:tcp', revision: '1.0.0' } });
  const untrusted = template({ origin: 'custom', parameters: [{ key: 'downlinkEnabled', label: '控制', type: 'boolean', default: true }], parameterValues: {downlinkEnabled:true} });
  for (const item of [legacy, untrusted]) {
    assert.equal(configurableTemplate(item), false);
    assert.deepEqual(templateParameters(item), {});
    assert.deepEqual(templateApplyOptions(item, 'append', { downlinkEnabled: true }, 'r1'), { mode: 'append', expectedRevision: 'r1' });
    assert.equal(sourceBuiltinId(item), undefined);
  }
});

test('configured copy apply includes edited parameters and uses the saved instance revision', async () => {
  const { templateApplyOptions } = await import('./template-model.ts');
  const copy = template({ origin: 'custom', derivedFrom: { templateId: 'builtin:tcp', revision: '1.0.0' },
    parameters: [{key:'nodeId',label:'设备',type:'text'}], parameterValues: {nodeId:'saved'} });
  assert.deepEqual(templateApplyOptions(copy, 'replace', {nodeId:'edited'}, 'r2'), { mode:'replace', parameters:{nodeId:'edited'}, expectedRevision:'r2' });
});

test('deploying has an explicit progress state and never renders as missing deployment conditions', async () => {
  const { deploymentFeedback } = await import('./template-model.ts');
  const preview: ApplyPreview = {dryRun:true,mode:'append',deployable:true,nodeCount:1,tabCount:1,nodeTypes:[],warnings:[],note:'检查通过',compat:{ok:true,checked:true,missing:[]}};
  assert.equal(deploymentFeedback(preview, true, false).type, 'success');
  assert.match(deploymentFeedback(preview, true, true).text, /正在部署/);
  assert.equal(deploymentFeedback(preview, true, true).type, 'info');
  assert.doesNotMatch(deploymentFeedback(preview, true, true).text, /尚未满足/);
});

test('a trusted copy uses explicit saved-snapshot selection without changing append/replace or losing edits', async () => {
  const { templateApplyOptions, parameterEditingAllowed, effectiveTemplateParameters } = await import('./template-model.ts');
  const copy = template({ origin: 'custom', derivedFrom: { templateId: 'builtin:tcp', revision: 'obsolete-version' },
    parameters: [{key:'nodeId',label:'设备',type:'text'}], parameterValues: {nodeId:'saved-device'} });
  const edited = {nodeId:'edited-device'};
  assert.deepEqual(templateApplyOptions(copy,'append',edited,'r1'), {mode:'append',parameters:edited,expectedRevision:'r1'}, 'recipe drift must not silently select snapshot');
  for (const mode of ['append','replace'] as const) {
    assert.deepEqual(templateApplyOptions(copy,mode,edited,'r1','snapshot'), {mode,expectedRevision:'r1'});
  }
  assert.equal(parameterEditingAllowed(copy,'snapshot'),false);
  assert.equal(parameterEditingAllowed(copy,'parameters'),true);
  assert.deepEqual(effectiveTemplateParameters(copy,edited,'snapshot'),{nodeId:'saved-device'});
  assert.deepEqual(effectiveTemplateParameters(copy,edited,'parameters'),edited);
  assert.equal(edited.nodeId,'edited-device');
});

test('snapshot selection is reserved for trusted configured copies; builtins still require parameters', async () => {
  const { configurableCopy, templateApplyOptions } = await import('./template-model.ts');
  const builtin = template({id:'builtin:tcp',origin:'builtin'});
  const legacy = template({origin:'custom',derivedFrom:{templateId:'builtin:tcp',revision:'1.0.0'}});
  assert.equal(configurableCopy(builtin),false);
  assert.equal(configurableCopy(legacy),false);
  assert.deepEqual(templateApplyOptions(builtin,'append',{nodeId:'device'},undefined,'snapshot'),{mode:'append',parameters:{nodeId:'device'}});
  assert.deepEqual(templateApplyOptions(legacy,'append',{},undefined,'snapshot'),{mode:'append'});
});
