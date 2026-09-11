import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import {
  InstanceOperationGate,
  InstanceBusyError,
  InstanceRepositoryOperationPolicy,
} from '../../core/instance/operation-gate.ts';
import { InstanceRepo, type InstanceRecord } from '../../core/instance/repo.ts';
import { PLATFORM_NODE_PACKAGE } from '../../core/nodes/platform-contract.ts';
import type { HttpContext } from '../context.ts';
import type { ProductModel } from '../../core/cloud/model-client.ts';
import { registerFlows } from './flows.ts';
import { registerTemplates } from './templates.ts';

const instance: InstanceRecord = {
  id: 'line-a',
  name: 'line-a',
  imageTag: '5.0.4-24-minimal',
  memLimit: 512,
  cpuLimit: 0.5,
  adminRoot: '/red/line-a/',
  credSecret: 'credential-secret',
  notes: '',
};

test('whole-flow POST honors live and repository-backed gates before side effects', async () => {
  let adminCalls = 0;
  const upstream = createServer((req, res) => {
    adminCalls += 1;
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"token"}');
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/flows')) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');

  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('flows-gate-test', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const app = Fastify({ logger: false });
  const fail: HttpContext['fail'] = (reply, error) => reply
    .code(error instanceof InstanceBusyError ? 409 : 400)
    .send({ error: (error as Error).message });
  registerFlows(app, {
    config: { basePath: '' },
    db,
    repo,
    operationGate,
    upstreamFor: () => `http://127.0.0.1:${address.port}`,
    guard: () => ({ username: 'admin', role: 'admin' }),
    fail,
  } as unknown as HttpContext);

  try {
    const beforeAudit = (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    await operationGate.run('line-a', 'platform-migration', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/instances/line-a/flows',
        payload: { flows: [] },
      });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /platform-migration/);
    });
    repo.beginNodeMigration({
      instanceId: 'line-a',
      txId: 'tx-flow-manual',
      operationKind: 'bootstrap',
      phase: 'preparing',
      originalRunning: false,
      stagedBefore: false,
      modeBefore: 'legacy',
      imageIdBefore: 'sha256:image-a',
      targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
      checkpointDir: '',
      snapshot: { version: 1, kind: 'bootstrap' },
      actor: 'admin',
    });
    repo.updateNodeMigration('line-a', 'manual_required', 'state-inconsistent');
    const persisted = await app.inject({
      method: 'POST',
      url: '/api/instances/line-a/flows',
      payload: { flows: [] },
    });
    assert.equal(persisted.statusCode, 409);
    assert.match(persisted.json().error, /manual_required\/state-inconsistent/);
    assert.equal(adminCalls, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

async function deploymentApp(options: { stale?: boolean; cachedModel?: ProductModel; nodeSets?: unknown[] } = {}) {
  const writes: { revision?: string; flows: unknown[] }[] = [];
  let nodeRequests = 0;
  const upstream = createServer((req, res) => {
    void (async () => {
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"token"}'); return;
    }
    if (req.url?.endsWith('/nodes')) {
      nodeRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(options.nodeSets ?? [])); return;
    }
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      writes.push(Array.isArray(value) ? { flows: value } : { revision: value.rev, flows: value.flows });
      res.writeHead(options.stale ? 409 : 200, { 'content-type': 'application/json' }); res.end('{}'); return;
    }
    const flows = [{ id: 'keep', type: 'tab', label: 'Existing' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers['node-red-api-version'] === 'v2' ? { rev: 'current', flows } : flows));
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const db = openDb(':memory:');
  const app = Fastify();
  const ctx = {
    config: { basePath: '' }, db,
    cloud: { getCachedModel: (product: string, version: string) => product === 'meter-product' && version === 'v1' ? options.cachedModel : undefined },
    operationGate: new InstanceOperationGate(new InstanceRepositoryOperationPolicy(new InstanceRepo(db, deriveKey('test', 'instance')))),
    adminRuntime: { target: () => ({ upstream: `http://127.0.0.1:${address.port}`, adminRoot: '/red/a/', username: 'u', password: 'p' }) },
    guard: () => ({ username: 'admin', role: 'admin' }),
    fail: (reply: any, error: Error) => reply.code(400).send({ error: error.message }),
  } as unknown as HttpContext;
  registerFlows(app, ctx);
  registerTemplates(app, ctx);
  return { app, db, writes, nodeRequests: () => nodeRequests, close: async () => {
    await app.close(); db.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  } };
}

test('flow route previews and appends without exposing internal flow body or removing existing nodes', async () => {
  const fixture = await deploymentApp();
  try {
    const body = { flows: [{ id: 'a', type: 'tab' }], mode: 'append' };
    const preview = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: { ...body, dryRun: true } });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().mode, 'append');
    assert.equal(preview.json().revision, 'current');
    assert.equal(preview.json().deployable, true);
    assert.equal('flowsToDeploy' in preview.json(), false);
    assert.equal(fixture.writes.length, 0);
    const applied = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: { ...body, expectedRevision: 'current' } });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().replacedNodeCount, 0);
    assert.equal(fixture.writes[0]?.revision, 'current');
    assert.deepEqual(fixture.writes[0]?.flows[0], { id: 'keep', type: 'tab', label: 'Existing' });
    assert.equal(fixture.writes[0]?.flows.length, 2);
    assert.equal(fixture.nodeRequests(), 2, 'apply rechecks the current node inventory');
  } finally { await fixture.close(); }
});

test('flow route rejects stale writes with 409 and never retries', async () => {
  const fixture = await deploymentApp({ stale: true });
  try {
    const response = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: { flows: [{ id: 'a', type: 'tab' }], mode: 'append' } });
    assert.equal(response.statusCode, 409);
    assert.equal(fixture.writes.length, 1);
  } finally { await fixture.close(); }
});

test('builtin apply validates configuration and missing dependencies prevent writes', async () => {
  const fixture = await deploymentApp();
  try {
    const url = '/api/instances/line-a/flows';
    const invalid = await fixture.app.inject({ method: 'POST', url, payload: { templateId: 'builtin:udp', parameters: { unknown: true } } });
    assert.equal(invalid.statusCode, 400);
    const body = { templateId: 'builtin:udp', parameters: { nodeId: 'plc-1', serviceCode: 'telemetry' } };
    const preview = await fixture.app.inject({ method: 'POST', url, payload: { ...body, dryRun: true } });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().mode, 'append');
    assert.equal(preview.json().deployable, false);
    assert.ok(preview.json().dependencyIssues.length > 0);
    const denied = await fixture.app.inject({ method: 'POST', url, payload: body });
    assert.equal(denied.statusCode, 409);
    assert.equal(fixture.writes.length, 0);
  } finally { await fixture.close(); }
});


test('saved configured copies still block deployment when their exact components are absent', async () => {
  const fixture = await deploymentApp();
  try {
    const copy = await fixture.app.inject({ method: 'POST', url: '/api/templates', payload: {
      name: 'Site UDP', builtinTemplateId: 'builtin:udp', parameters: { nodeId: 'plc-1', serviceCode: 'telemetry' },
    } });
    assert.equal(copy.statusCode, 201);
    const templateId = copy.json().template.id;
    const preview = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: { templateId, mode: 'append', dryRun: true } });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().deployable, false);
    const applied = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: { templateId, mode: 'append' } });
    assert.equal(applied.statusCode, 409);
    assert.equal(fixture.writes.length, 0);
  } finally { await fixture.close(); }
});


test('cached-model mismatches stop builtin preview and deployment before contacting Node-RED', async () => {
  const fixture = await deploymentApp({ cachedModel: { productIdentification: 'meter-product', services: [
    { serviceCode: 'control', properties: [{ propertyCode: 'temperature', datatype: 'string' }] },
  ] } });
  try {
    for (const dryRun of [true, false]) {
      const result = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
        templateId: 'builtin:udp', mode: 'append', dryRun,
        parameters: { nodeId: 'meter-1', productIdentification: 'meter-product', versionNo: 'v1', serviceCode: 'control' },
      } });
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /类型/);
    }
    assert.equal(fixture.nodeRequests(), 0);
    assert.equal(fixture.writes.length, 0);
    const noCache = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: 'builtin:udp', mode: 'append', dryRun: true,
      parameters: { nodeId: 'meter-1', productIdentification: 'meter-product', versionNo: 'not-cached', serviceCode: 'control' },
    } });
    assert.equal(noCache.statusCode, 200);
    assert.equal(noCache.json().modelChecked, false);
  } finally { await fixture.close(); }
});


const tcpNodeSets = [
  { id: 'node-red/core', module: 'node-red', version: '5.0.4', enabled: true, err: '',
    types: ['tcp in', 'tcp request', 'function', 'inject', 'catch', 'debug', 'http request'] },
  { id: 'platform/nodes', module: PLATFORM_NODE_PACKAGE.name, version: PLATFORM_NODE_PACKAGE.version,
    enabled: true, err: '', types: ['tl-device', 'tl-uplink'] },
];
async function savedTcp(fixture: Awaited<ReturnType<typeof deploymentApp>>) {
  const created = await fixture.app.inject({ method: 'POST', url: '/api/templates', payload: {
    name: 'Reusable configured TCP', builtinTemplateId: 'builtin:tcp',
    parameters: { nodeId: 'saved-device', serviceCode: 'telemetry', downlinkEnabled: true,
      commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }] },
  } });
  assert.equal(created.statusCode, 201);
  return created.json().template;
}

test('configured copies render edited parameters while preserving unedited values and the saved asset', async () => {
  const fixture = await deploymentApp({ nodeSets: tcpNodeSets });
  try {
    const saved = await savedTcp(fixture);
    const response = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', parameters: { nodeId: 'edited-device', port: 16001 },
    } });
    assert.equal(response.statusCode, 200);
    const deployed = fixture.writes[0]!.flows as { type: string; port?: string; deviceId?: string; name?: string }[];
    assert.equal(deployed.find(node => node.type === 'tcp in')?.port, '16001');
    assert.equal(deployed.find(node => node.type === 'tl-uplink')?.deviceId, 'edited-device');
    assert.ok(deployed.some(node => node.type === 'tcp request'), 'the original enabled control mapping must remain enabled');
    const original = await fixture.app.inject({ method: 'GET', url: `/api/templates/${saved.id}` });
    assert.equal(original.json().template.parameterValues.nodeId, 'saved-device');
    assert.equal(original.json().template.parameterValues.port, 15001);
  } finally { await fixture.close(); }
});

test('configured copies reject bad parameters or recipe revision drift before touching Node-RED', async () => {
  const fixture = await deploymentApp({ nodeSets: tcpNodeSets });
  try {
    const saved = await savedTcp(fixture);
    const invalid = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', parameters: { port: 'bad' },
    } });
    assert.equal(invalid.statusCode, 400);
    const row = fixture.db.prepare('SELECT trusted_metadata FROM flow_template WHERE id=?').get(saved.id) as { trusted_metadata: string };
    const metadata = JSON.parse(row.trusted_metadata);
    metadata.derivedFrom.revision = 'obsolete-revision';
    fixture.db.prepare('UPDATE flow_template SET trusted_metadata=? WHERE id=?').run(JSON.stringify(metadata), saved.id);
    const conflict = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', dryRun: true, parameters: { port: 16001 },
    } });
    assert.equal(conflict.statusCode, 409);
    assert.match(conflict.json().error, /版本|revision/);
    assert.equal(fixture.nodeRequests(), 0);
    assert.equal(fixture.writes.length, 0);
    const legacyCall = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', dryRun: true,
    } });
    assert.equal(legacyCall.statusCode, 200, 'an unchanged stored snapshot does not acquire newer recipe semantics');
  } finally { await fixture.close(); }
});

test('older copies without parameter archives remain explicit fixed snapshots even if parameters are supplied', async () => {
  const fixture = await deploymentApp({ nodeSets: tcpNodeSets });
  try {
    const saved = await savedTcp(fixture);
    const row = fixture.db.prepare('SELECT trusted_metadata FROM flow_template WHERE id=?').get(saved.id) as { trusted_metadata: string };
    const metadata = JSON.parse(row.trusted_metadata);
    delete metadata.parameterValues; delete metadata.parameters; delete metadata.notes;
    fixture.db.prepare('UPDATE flow_template SET trusted_metadata=? WHERE id=?').run(JSON.stringify(metadata), saved.id);
    const response = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', parameters: { port: 16001 },
    } });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().note, /固定.*快照|参数档案/);
    const deployed = fixture.writes[0]!.flows as { type: string; port?: string }[];
    assert.equal(deployed.find(node => node.type === 'tcp in')?.port, '15001');
  } finally { await fixture.close(); }
});

test('reconfigured copies run cached-model checks with effective saved and edited parameters', async () => {
  const fixture = await deploymentApp({ cachedModel: { productIdentification: 'meter-product', services: [
    { serviceCode: 'control', properties: [{ propertyCode: 'temperature', datatype: 'string' }] },
  ] } });
  try {
    const saved = await savedTcp(fixture);
    const response = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', dryRun: true,
      parameters: { productIdentification: 'meter-product', versionNo: 'v1', serviceCode: 'control' },
    } });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /类型/);
    assert.equal(fixture.nodeRequests(), 0);
    assert.equal(fixture.writes.length, 0);
  } finally { await fixture.close(); }
});

test('reconfiguring a copy cannot silently replace an archived exact component version', async () => {
  const fixture = await deploymentApp({ nodeSets: tcpNodeSets });
  try {
    const saved = await savedTcp(fixture);
    const row = fixture.db.prepare('SELECT trusted_metadata FROM flow_template WHERE id=?').get(saved.id) as { trusted_metadata: string };
    const metadata = JSON.parse(row.trusted_metadata);
    metadata.requirements[0].version = 'obsolete-component';
    fixture.db.prepare('UPDATE flow_template SET trusted_metadata=? WHERE id=?').run(JSON.stringify(metadata), saved.id);
    const response = await fixture.app.inject({ method: 'POST', url: '/api/instances/line-a/flows', payload: {
      templateId: saved.id, mode: 'append', parameters: { port: 16001 },
    } });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /组件.*版本/);
    assert.equal(fixture.nodeRequests(), 0);
    assert.equal(fixture.writes.length, 0);
  } finally { await fixture.close(); }
});
