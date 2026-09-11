import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { TemplateRepo } from '../../core/flows/repo.ts';
import type { HttpContext } from '../context.ts';
import { registerTemplates } from './templates.ts';

const context = () => {
  const db = openDb(':memory:');
  const guards: { need: string; csrf: boolean }[] = [];
  const ctx = {
    config: { basePath: '' }, db,
    guard: (_request: unknown, _reply: unknown, options: { need: string; csrf: boolean }) => {
      guards.push(options);
      return { username: 'admin', role: 'admin' };
    },
  } as unknown as HttpContext;
  return { db, ctx, guards };
};

test('template routes persist custom metadata while origin remains server controlled', async () => {
  const { db, ctx } = context();
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/templates', payload: {
      name: 'custom', content: [{ id: 'a', type: 'tab' }], category: 'industrial', protocols: ['s7'], origin: 'builtin',
    } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().template.origin, 'custom');
    assert.equal(created.json().template.category, 'industrial');
    const id = created.json().template.id;
    const changed = await app.inject({ method: 'PATCH', url: `/api/templates/${id}`, payload: { name: 'new', category: 'network', protocols: ['tcp'] } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().template.category, 'network');
    assert.deepEqual(changed.json().template.protocols, ['tcp']);
    const invalid = await app.inject({ method: 'PATCH', url: `/api/templates/${id}`, payload: { name: 'bad', category: null } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(new TemplateRepo(db).get(id)?.name, 'new');
  } finally { await app.close(); db.close(); }
});

test('builtin metadata is listed, detail is a disabled example, and modifying builtins is refused', async () => {
  const { db, ctx } = context();
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/templates' });
    const builtin = response.json().templates.find((item: { origin?: string }) => item.origin === 'builtin');
    assert.ok(builtin, 'builtin catalogue must be visible');
    assert.equal('flows' in builtin, false);
    const path = `/api/templates/${encodeURIComponent(builtin.id)}`;
    const detail = await app.inject({ method: 'GET', url: path });
    assert.equal(detail.statusCode, 200);
    assert.ok(detail.json().template.flows.some((node: { type: string; disabled?: boolean }) => node.type === 'tab' && node.disabled === true));
    for (const method of ['PATCH', 'DELETE'] as const) {
      const refused = await app.inject({ method, url: path, payload: { name: 'overwrite' } });
      assert.equal(refused.statusCode, 403);
    }
    assert.equal(new TemplateRepo(db).list().length, 0);
  } finally { await app.close(); db.close(); }
});

test('builtin render validates parameters and uses view permission with CSRF protection', async () => {
  const { db, ctx, guards } = context();
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const list = await app.inject({ method: 'GET', url: '/api/templates' });
    const builtin = list.json().templates.find((item: { origin?: string }) => item.origin === 'builtin');
    assert.ok(builtin);
    const rendered = await app.inject({ method: 'POST', url: `/api/templates/${encodeURIComponent(builtin.id)}/render`, payload: { parameters: { unknownParameter: true } } });
    assert.equal(rendered.statusCode, 400);
    assert.deepEqual(guards.at(-1), { csrf: true, need: 'template:view' });
    assert.equal(new TemplateRepo(db).list().length, 0);
  } finally { await app.close(); db.close(); }
});


test('rendering a configured builtin is side-effect free and yields an active deployable copy', async () => {
  const { db, ctx } = context();
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/templates/builtin%3Audp/render', payload: {
      parameters: { nodeId: 'plc-1', serviceCode: 'telemetry' },
    } });
    assert.equal(response.statusCode, 200);
    const template = response.json().template;
    assert.ok(template.flows.some((node: { type: string; disabled?: boolean }) => node.type === 'tab' && node.disabled !== true));
    assert.ok(template.flows.some((node: { type: string }) => node.type === 'tl-uplink'));
    assert.equal(new TemplateRepo(db).list().length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n, 0);
  } finally { await app.close(); db.close(); }
});

test('create configured copy renders server-side, retains dependencies and refuses mixed sources', async () => {
  const { db, ctx } = context();
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const payload = { name: 'Production UDP', builtinTemplateId: 'builtin:udp', parameters: { nodeId: 'plc-1', serviceCode: 'telemetry' } };
    const created = await app.inject({ method: 'POST', url: '/api/templates', payload });
    assert.equal(created.statusCode, 201);
    const saved = created.json().template;
    assert.equal(saved.origin, 'custom');
    assert.equal(saved.derivedFrom.templateId, 'builtin:udp');
    assert.ok(saved.requirements.some((r: { module: string }) => r.module === '@mqttsnet/thinglinks-edge-nodes'));
    const detail = await app.inject({ method: 'GET', url: `/api/templates/${saved.id}` });
    assert.deepEqual(detail.json().template.requirements, saved.requirements);
    assert.equal(detail.json().template.flows.find((node: { type: string }) => node.type === 'tl-device').deviceId, 'plc-1');
    for (const other of [{ content: [] }, { instanceId: 'line-a' }]) {
      const invalid = await app.inject({ method: 'POST', url: '/api/templates', payload: { ...payload, ...other } });
      assert.equal(invalid.statusCode, 400);
    }
    const invalidParameters = await app.inject({ method: 'POST', url: '/api/templates', payload: { ...payload, parameters: { nodeId: '' } } });
    assert.equal(invalidParameters.statusCode, 400);
    assert.equal(new TemplateRepo(db).list().length, 1);
  } finally { await app.close(); db.close(); }
});

test('cached child model prevents direct render and configured-copy APIs from bypassing mapping checks', async () => {
  const { db, ctx } = context();
  const lookedUp: string[][] = [];
  let cached = { productIdentification: 'meter-product', services: [{ serviceCode: 'control', properties: [{ propertyCode: 'humidity', datatype: 'decimal' }] }] };
  ctx.cloud = { getCachedModel: (product: string, version: string) => {
    lookedUp.push([product, version]); return product === 'meter-product' && version === 'v1' ? cached : undefined;
  } } as unknown as NonNullable<HttpContext['cloud']>;
  const app = Fastify(); registerTemplates(app, ctx);
  const parameters = { nodeId: 'meter-1', productIdentification: 'meter-product', versionNo: 'v1', serviceCode: 'control' };
  try {
    const rendered = await app.inject({ method: 'POST', url: '/api/templates/builtin%3Audp/render', payload: { parameters } });
    assert.equal(rendered.statusCode, 400);
    assert.match(rendered.json().error, /temperature/);
    const created = await app.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Invalid mapping', builtinTemplateId: 'builtin:udp', parameters } });
    assert.equal(created.statusCode, 400);
    assert.equal(new TemplateRepo(db).list().length, 0);
    assert.deepEqual(lookedUp, [['meter-product', 'v1'], ['meter-product', 'v1']]);
    cached = { productIdentification: 'meter-product', services: [{ serviceCode: 'control', properties: [{ propertyCode: 'temperature', datatype: 'decimal' }] }] };
    const valid = await app.inject({ method: 'POST', url: '/api/templates/builtin%3Audp/render', payload: { parameters } });
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.json().modelChecked, true);
    const noCache = await app.inject({ method: 'POST', url: '/api/templates/builtin%3Audp/render', payload: { parameters: { ...parameters, versionNo: 'not-cached' } } });
    assert.equal(noCache.statusCode, 200);
    assert.equal(noCache.json().modelChecked, false);
  } finally { await app.close(); db.close(); }
});

test('configured control API rejects commands which need more than the mapped request parameter', async () => {
  const { db, ctx } = context();
  ctx.cloud = { getCachedModel: () => ({ services: [{ serviceCode: 'control',
    properties: [{ propertyCode: 'temperature', datatype: 'decimal' }],
    commands: [{ commandCode: 'set', requests: [{ parameterCode: 'value', datatype: 'decimal', required: true },
      { parameterCode: 'confirm', datatype: 'boolean', required: true }] }],
  }] }) } as unknown as NonNullable<HttpContext['cloud']>;
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const result = await app.inject({ method: 'POST', url: '/api/templates', payload: {
      name: 'Cannot satisfy command', builtinTemplateId: 'builtin:udp', parameters: {
        nodeId: 'meter-1', productIdentification: 'meter-product', versionNo: 'v1', serviceCode: 'control',
        downlinkEnabled: true, commands: [{ cmd: 'set', param: 'value', property: 'temperature' }],
      },
    } });
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /必填参数.*confirm/);
    assert.equal(new TemplateRepo(db).list().length, 0);
  } finally { await app.close(); db.close(); }
});

test('new configured copies expose their archived form and control identity through list and detail', async () => {
  const { db, ctx } = context();
  const app = Fastify(); registerTemplates(app, ctx);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/templates', payload: {
      name: 'TCP with control', builtinTemplateId: 'builtin:tcp', parameters: {
        nodeId: 'saved-device', serviceCode: 'telemetry', downlinkEnabled: true,
        commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }],
      },
    } });
    assert.equal(created.statusCode, 201);
    const id = created.json().template.id;
    const list = await app.inject({ method: 'GET', url: '/api/templates' });
    const listed = list.json().templates.find((template: { id: string }) => template.id === id);
    const detail = await app.inject({ method: 'GET', url: `/api/templates/${id}` });
    for (const template of [listed, detail.json().template]) {
      assert.equal(template.parameterValues.nodeId, 'saved-device');
      assert.equal(template.parameterValues.downlinkEnabled, true);
      assert.deepEqual(template.parameterValues.commands, [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }]);
      assert.ok(template.parameters.some((field: { key: string }) => field.key === 'commands'));
      assert.ok(template.notes.length > 0);
      assert.equal(template.derivedFrom.templateId, 'builtin:tcp');
    }
    const uploaded = await app.inject({ method: 'POST', url: '/api/templates', payload: {
      name: 'Untrusted upload', content: [], parameterValues: listed.parameterValues, parameters: listed.parameters,
      notes: listed.notes, derivedFrom: listed.derivedFrom, requirements: listed.requirements,
    } });
    assert.equal(uploaded.statusCode, 201);
    assert.equal(uploaded.json().template.parameterValues, undefined);
    assert.equal(uploaded.json().template.parameters, undefined);
    assert.equal(uploaded.json().template.derivedFrom, undefined);
  } finally { await app.close(); db.close(); }
});


test('HTTP rendering and configured-copy creation reject unavailable OPC UA control explicitly', async () => {
  const {db,ctx} = context();const app=Fastify();registerTemplates(app,ctx);
  try {
    const parameters={nodeId:'device',serviceCode:'telemetry',downlinkEnabled:true,commands:[{cmd:'set',param:'value',property:'temperature'}]};
    const rendered=await app.inject({method:'POST',url:'/api/templates/builtin%3Aopcua/render',payload:{parameters}});
    const copied=await app.inject({method:'POST',url:'/api/templates',payload:{name:'Unavailable OPC control',builtinTemplateId:'builtin:opcua',parameters}});
    for(const response of [rendered,copied]){assert.equal(response.statusCode,400);assert.match(response.json().error,/当前受管实例支持采集.*独立受控执行节点/);}
    assert.equal(new TemplateRepo(db).list().length,0);
  } finally {await app.close();db.close();}
});

test('Modbus control render and configured-copy APIs reject it while preserving acquisition and old snapshots', async () => {
  const { db, ctx } = context(); const app = Fastify(); registerTemplates(app, ctx);
  const oldFlows = [{ id: 'old-tab', type: 'tab', label: 'Existing user snapshot' },
    { id: 'old-connection', type: 'modbus-client', clienttype: 'tcp' },
    { id: 'old-write', type: 'modbus-flex-write', z: 'old-tab', server: 'old-connection', wires: [[]] }];
  const existing = new TemplateRepo(db).save({ name: 'Existing Modbus snapshot', content: oldFlows }, 'admin');
  try {
    const parameters = { nodeId: 'device', serviceCode: 'telemetry', downlinkEnabled: true, commands: [{ cmd: 'set', param: 'value', property: 'temperature' }] };
    const rendered = await app.inject({ method: 'POST', url: '/api/templates/builtin%3Amodbus-tcp/render', payload: { parameters } });
    const copied = await app.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Unsafe new control', builtinTemplateId: 'builtin:modbus-tcp', parameters } });
    for (const response of [rendered, copied]) {
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /Modbus.*采集.*断网.*迟到/);
    }
    assert.equal(new TemplateRepo(db).list().length, 1);
    assert.deepEqual(new TemplateRepo(db).getWithContent(existing.id)!.flows, oldFlows, 'old snapshots must not be silently rewritten');
    const acquisition = await app.inject({ method: 'POST', url: '/api/templates/builtin%3Amodbus-tcp/render', payload: { parameters: { ...parameters, downlinkEnabled: false } } });
    assert.equal(acquisition.statusCode, 200);
    assert.ok(acquisition.json().template.flows.some((node: { type: string }) => node.type === 'modbus-read'));
  } finally { await app.close(); db.close(); }
});
