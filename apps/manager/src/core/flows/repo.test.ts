import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { TemplateRepo } from './repo.ts';
import { TemplateError, type FlowNode } from './types.ts';

const flows = (): FlowNode[] => [
  { id: 'tab1', type: 'tab', label: '一号产线' },
  { id: 'in1', type: 'mqtt in', z: 'tab1', name: '温度', topic: 'plant/temp' },
  { id: 'fn1', type: 'function', z: 'tab1', name: '换算', func: 'return msg;' },
  { id: 'out1', type: 'debug', z: 'tab1', name: '输出' },
];
const fresh = () => new TemplateRepo(openDb(':memory:'));

test('保存后可读回，体检结果一并落库', () => {
  const repo = fresh();
  const t = repo.save({ name: '产线基线', description: '标准采集', content: flows(), source: 'line-a' }, 'admin');
  assert.equal(t.name, '产线基线');
  assert.equal(t.nodeCount, 4);
  assert.equal(t.tabCount, 1);
  assert.deepEqual(t.nodeTypes, ['debug', 'function', 'mqtt in', 'tab']);
  assert.equal(t.source, 'line-a');
  assert.equal(t.createdBy, 'admin');
  assert.deepEqual(t.warnings, []);
});

test('内联凭据告警随模板一起存下来，分发前就能看到', () => {
  const repo = fresh();
  const t = repo.save({
    name: '带密钥的',
    content: [{ id: 'fn', type: 'function', name: '上云', func: "const token = 'abcdefghijklmn';" }],
  }, 'admin');
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0]!, /上云/);
});

test('列表不带内容 —— 一个模板可能几百 KB', () => {
  const repo = fresh();
  repo.save({ name: 'a', content: flows() }, 'admin');
  const list = repo.list();
  assert.equal(list.length, 1);
  assert.ok(!('flows' in list[0]!), '列表项不该带 flows');
  assert.equal(list[0]!.nodeCount, 4, '但摘要信息要有，否则列表没法用');
});

test('取完整模板时内容能原样还原', () => {
  const repo = fresh();
  const saved = repo.save({ name: 'a', content: flows() }, 'admin');
  const full = repo.getWithContent(saved.id);
  assert.ok(full);
  assert.deepEqual(full.flows, flows());
});

test('名称为空或过长要拒绝', () => {
  const repo = fresh();
  assert.throws(() => repo.save({ name: '  ', content: flows() }, 'a'), /名称不能为空/);
  assert.throws(() => repo.save({ name: 'x'.repeat(65), content: flows() }, 'a'), /名称过长/);
});

test('内容非法时不落库', () => {
  const repo = fresh();
  assert.throws(() => repo.save({ name: 'bad', content: '{}' }, 'a'), TemplateError);
  assert.equal(repo.list().length, 0, '失败的保存不该留下记录');
});

test('删除与改名', () => {
  const repo = fresh();
  const t = repo.save({ name: '旧名', content: flows() }, 'admin');
  const renamed = repo.rename(t.id, '新名', '新说明');
  assert.equal(renamed?.name, '新名');
  assert.equal(renamed?.description, '新说明');

  assert.equal(repo.remove(t.id), true);
  assert.equal(repo.remove(t.id), false, '删不存在的应回 false 而不是抛错');
  assert.equal(repo.get(t.id), undefined);
});

test('不存在的模板读回 undefined', () => {
  const repo = fresh();
  assert.equal(repo.get('no-such-id'), undefined);
  assert.equal(repo.getWithContent('no-such-id'), undefined);
});

test('custom metadata persists and rename preserves unspecified metadata', () => {
  const repo = fresh();
  const saved = repo.save({ name: '工业采集', content: flows(), category: 'industrial', protocols: ['modbus-tcp', 's7', 's7'] }, 'admin');
  assert.equal(saved.origin, 'custom');
  assert.equal(saved.category, 'industrial');
  assert.deepEqual(saved.protocols, ['modbus-tcp', 's7']);
  assert.equal(repo.getWithContent(saved.id)?.category, 'industrial');
  const renamed = repo.rename(saved.id, '新名称', '', { protocols: ['opcua'] });
  assert.equal(renamed?.category, 'industrial');
  assert.deepEqual(renamed?.protocols, ['opcua']);
});

test('legacy metadata defaults to custom and malformed metadata is refused before write', () => {
  const repo = fresh();
  const saved = repo.save({ name: 'legacy', content: flows() }, 'admin');
  assert.equal(saved.category, 'custom');
  assert.deepEqual(saved.protocols, []);
  for (const metadata of [{ category: 'unknown' }, { category: 12 }, { protocols: 'tcp' }, { protocols: ['TCP unsafe'] }, { protocols: Array.from({ length: 33 }, (_, i) => `p-${i}`) }]) {
    assert.throws(() => repo.save({ name: 'bad', content: flows(), ...metadata } as never, 'admin'), TemplateError);
  }
  assert.equal(repo.list().length, 1);
  assert.throws(() => repo.rename(saved.id, 'renamed', '', { protocols: ['bad value'] }), TemplateError);
  assert.equal(repo.get(saved.id)?.name, 'legacy');
});


test('configured builtin copies preserve trusted requirements while ordinary uploads cannot forge them', async () => {
  const { renderBuiltinTemplate } = await import('./templates/catalog.ts');
  const template = renderBuiltinTemplate('builtin:udp', { nodeId: 'plc-1', serviceCode: 'telemetry' });
  assert.ok(template);
  const repo = fresh();
  const copied = repo.saveConfiguredBuiltin(template, { name: 'Site UDP', category: 'industrial' }, 'admin');
  assert.equal(copied.origin, 'custom');
  assert.equal(copied.category, 'industrial');
  assert.deepEqual(copied.derivedFrom, { templateId: 'builtin:udp', revision: template.revision });
  assert.deepEqual(copied.requirements, template.requirements);
  assert.deepEqual(repo.getWithContent(copied.id)?.flows, template.flows);
  repo.rename(copied.id, 'Renamed copy', '');
  assert.deepEqual(repo.get(copied.id)?.requirements, template.requirements);
  const uploaded = repo.save({ name: 'upload', content: flows(), requirements: template.requirements, derivedFrom: copied.derivedFrom } as never, 'admin');
  assert.equal(uploaded.requirements, undefined);
  assert.equal(uploaded.derivedFrom, undefined);
});

test('configured copies retain parameter schema, values and notes while uploads cannot supply trusted archives', async () => {
  const { renderBuiltinTemplate } = await import('./templates/catalog.ts');
  const template = renderBuiltinTemplate('builtin:tcp', { nodeId: 'saved-device', serviceCode: 'telemetry', downlinkEnabled: true,
    commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }] })!;
  const repo = fresh();
  const copy = repo.saveConfiguredBuiltin(template, { name: 'Reusable TCP' }, 'admin');
  assert.equal(copy.parameterValues?.nodeId, 'saved-device');
  assert.equal(copy.parameterValues?.downlinkEnabled, true);
  assert.ok(copy.parameters?.some(field => field.key === 'commands'));
  assert.deepEqual(copy.notes, template.notes);
  assert.deepEqual(repo.getWithContent(copy.id)?.parameterValues, template.parameterValues);
  repo.rename(copy.id, 'renamed', '');
  assert.deepEqual(repo.list()[0]?.parameterValues, template.parameterValues);
  const upload = repo.save({ name: 'plain upload', content: flows(), parameterValues: template.parameterValues,
    parameters: template.parameters, notes: template.notes, derivedFrom: copy.derivedFrom } as never, 'admin');
  assert.equal(upload.parameterValues, undefined);
  assert.equal(upload.parameters, undefined);
  assert.equal(upload.notes, undefined);
  assert.equal(upload.derivedFrom, undefined);
});

test('all template reads rescan historical dynamic-environment warnings without rewriting the stored archive', async () => {
  const { renderBuiltinTemplate } = await import('./templates/catalog.ts');
  const db = openDb(':memory:');
  const repo = new TemplateRepo(db);
  try {
    const rendered = renderBuiltinTemplate('builtin:tcp', { nodeId: 'archived-device', serviceCode: 'telemetry', downlinkEnabled: true,
      commands: [{ cmd: 'set', param: 'value', property: 'temperature' }] })!;
    const saved = repo.saveConfiguredBuiltin(rendered, { name: 'Historical scanner result' }, 'admin');
    db.prepare('UPDATE flow_template SET warnings=? WHERE id=?').run(JSON.stringify(['function 「旧动态令牌误报」']), saved.id);
    const stored = () => Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id)));
    const before = stored();
    const reads = [repo.get(saved.id)!, repo.list()[0]!, repo.getWithContent(saved.id)!];
    for (const value of reads) {
      assert.deepEqual(value.warnings, []);
      assert.deepEqual(value.parameterValues, rendered.parameterValues);
      assert.equal(value.source, rendered.id);
      assert.deepEqual(value.derivedFrom, { templateId: rendered.id, revision: rendered.revision });
    }
    assert.deepEqual(stored(), before, 'every stored field, including old warnings, remains byte-identical');
  } finally { db.close(); }
});

test('current read-time scanning still reports real fixed credentials when old warning cache was empty', () => {
  const db = openDb(':memory:');const repo = new TemplateRepo(db);
  try {
    const saved = repo.save({name:'Actual fixed value',content:[{id:'fixed',type:'function',name:'固定配置',func:"const password = 'test-fixture-only'; return msg;"}]},'admin');
    db.prepare('UPDATE flow_template SET warnings=? WHERE id=?').run('[]',saved.id);
    const before = Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id)));
    for (const value of [repo.get(saved.id)!,repo.list()[0]!,repo.getWithContent(saved.id)!]) {
      assert.equal(value.warnings.length,1);
      assert.match(value.warnings[0]!,/固定配置/);
      assert.ok(!value.warnings.join().includes('test-fixture-only'),'warning text does not disclose the literal');
    }
    assert.deepEqual(Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id))),before);
  } finally {db.close();}
});

test('unreadable stored flows preserve old warnings and mark scanning incomplete instead of returning clean or empty flows', () => {
  const db = openDb(':memory:');const repo = new TemplateRepo(db);
  try {
    const saved = repo.save({name:'Unreadable archive',content:flows()},'admin');
    for (const content of ['{broken-json','{"not":"a flow array"}','[null]']) {
      db.prepare('UPDATE flow_template SET content=?,warnings=? WHERE id=?').run(content,JSON.stringify(['既有可疑节点']),saved.id);
      const before=Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id)));
      for(const value of [repo.get(saved.id)!,repo.list()[0]!]) {
        assert.deepEqual(value.warnings,['既有可疑节点','扫描未完成，请人工核对']);
      }
      assert.throws(()=>repo.getWithContent(saved.id),/扫描未完成，请人工核对/);
      assert.deepEqual(Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id))),before);
    }
    db.prepare('UPDATE flow_template SET warnings=? WHERE id=?').run('malformed-cache',saved.id);
    assert.deepEqual(repo.get(saved.id)!.warnings,['扫描未完成，请人工核对']);
  } finally {db.close();}
});

test('scanner exceptions preserve historical warnings on all reads without changing valid archived JSON', async () => {
  const { scanInlineSecrets } = await import('./scan.ts');
  const db=openDb(':memory:');const repo=new TemplateRepo(db);
  try {
    const saved=repo.save({name:'Legacy node shape',content:flows()},'admin');
    const content=[{id:'n',type:'function',name:{toString:1,valueOf:null},func:"const password = 'test-fixture-only';"}];
    assert.throws(()=>scanInlineSecrets(content as unknown as FlowNode[]),'fixture must exercise a scanner failure');
    db.prepare('UPDATE flow_template SET content=?,warnings=? WHERE id=?').run(JSON.stringify(content),JSON.stringify(['保留旧扫描发现']),saved.id);
    const before=Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id)));
    for(const value of [repo.get(saved.id)!,repo.list()[0]!,repo.getWithContent(saved.id)!]) {
      assert.deepEqual(value.warnings,['保留旧扫描发现','扫描未完成，请人工核对']);
    }
    assert.deepEqual(repo.getWithContent(saved.id)!.flows,content);
    assert.deepEqual(Buffer.from(JSON.stringify(db.prepare('SELECT * FROM flow_template WHERE id=?').get(saved.id))),before);
  } finally {db.close();}
});
