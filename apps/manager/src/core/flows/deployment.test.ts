import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareFlowDeployment, deployPreparedFlows } from './deployment.ts';
import { AdminApiError } from './admin-client.ts';

const target = { upstream: 'http://unused', adminRoot: '/red/a/', username: 'u', password: 'p' };
const flows = [{ id: 't', type: 'tab' }, { id: 'i', type: 'inject', z: 't' }];
const nodes = [{ id: 'node-red/inject', module: 'node-red', version: '5.0.4', types: ['inject'], enabled: true, err: '' }];
function transport(options: { nodeSets?: unknown; rev?: string; current?: unknown; failNodes?: boolean; conflict?: boolean } = {}) {
  const writes: { headers: Headers; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('auth/token')) return new Response('{"access_token":"t"}');
    if (url.endsWith('/nodes')) return new Response(JSON.stringify(options.nodeSets ?? nodes), { status: options.failNodes ? 503 : 200 });
    if (init?.method === 'POST') {
      writes.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: options.conflict ? 409 : 200 });
    }
    const current = options.current ?? [{ id: 'existing', type: 'tab', label: 'keep' }];
    const body = new Headers(init?.headers).get('node-red-api-version') === 'v2'
      ? { rev: options.rev ?? 'rev-1', flows: current } : current;
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { fetcher, writes };
}

test('builtin preflight fails closed on unavailable, disabled, unloaded, wrong or unknown module version', async () => {
  for (const options of [
    { failNodes: true },
    { nodeSets: [] },
    { nodeSets: [{ ...nodes[0], enabled: false }] },
    { nodeSets: [{ ...nodes[0], err: 'load_error' }] },
    { nodeSets: [{ ...nodes[0], version: '0.9.0' }] },
    { nodeSets: [{ ...nodes[0], version: '' }] },
    { nodeSets: [{ ...nodes[0], enabled: undefined }] },
    { nodeSets: [nodes[0], { ...nodes[0], err: 'type_already_registered' }] },
  ]) {
    const { fetcher, writes } = transport(options);
    const prepared = await prepareFlowDeployment(target, { flows, builtin: true, requirements: [{ module: 'node-red', version: '5.0.4', nodeTypes: ['inject'] }] }, fetcher);
    assert.equal(prepared.mode, 'append');
    assert.equal(prepared.deployable, false);
    assert.ok(prepared.dependencyIssues.length > 0);
    await assert.rejects(() => deployPreparedFlows(target, prepared, fetcher), /依赖|部署/);
    assert.equal(writes.length, 0);
  }
});

test('append preview retains current nodes and deploys the checked revision', async () => {
  const { fetcher, writes } = transport();
  const prepared = await prepareFlowDeployment(target, { flows, mode: 'append' }, fetcher);
  assert.equal(prepared.deployable, true);
  assert.equal(prepared.revision, 'rev-1');
  assert.equal(prepared.resultNodeCount, 3);
  assert.equal(writes.length, 0);
  await deployPreparedFlows(target, prepared, fetcher);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.headers.get('node-red-deployment-type'), 'flows');
  const body = writes[0]?.body as { rev: string; flows: { id: string }[] };
  assert.equal(body.rev, 'rev-1');
  assert.equal(body.flows[0]?.id, 'existing');
  assert.notEqual(body.flows[1]?.id, 't');
});

test('editor changes before apply or during write return conflict without retry or overwrite', async () => {
  const { fetcher, writes } = transport({ rev: 'newer' });
  await assert.rejects(() => prepareFlowDeployment(target, { flows, mode: 'append', expectedRevision: 'old' }, fetcher),
    (error: unknown) => error instanceof AdminApiError && error.status === 409);
  assert.equal(writes.length, 0);
  const conflict = transport({ conflict: true });
  const prepared = await prepareFlowDeployment(target, { flows, mode: 'append' }, conflict.fetcher);
  await assert.rejects(() => deployPreparedFlows(target, prepared, conflict.fetcher),
    (error: unknown) => error instanceof AdminApiError && error.status === 409);
  assert.equal(conflict.writes.length, 1);
});

test('legacy omitted mode retains replace and advisory compatibility semantics', async () => {
  const { fetcher, writes } = transport({ failNodes: true });
  const prepared = await prepareFlowDeployment(target, { flows }, fetcher);
  assert.equal(prepared.mode, 'replace');
  assert.equal(prepared.deployable, true);
  assert.equal(prepared.compat.checked, false);
  await deployPreparedFlows(target, prepared, fetcher);
  assert.deepEqual(writes[0]?.body, flows);
  assert.equal(writes[0]?.headers.get('node-red-api-version'), null);
});

test('append preflight rejects duplicate TCP, UDP and HTTP listeners but allows disabled copies', async () => {
  for (const listener of [
    { id: 'in', type: 'tcp in', server: 'server', port: '9000' },
    { id: 'in', type: 'udp in', port: '9000' },
    { id: 'in', type: 'http in', method: 'post', url: '/ingest' },
  ]) {
    const { fetcher } = transport({ current: [listener] });
    const prepared = await prepareFlowDeployment(target, { flows: [{ ...listener, id: 'new' }], mode: 'append' }, fetcher);
    assert.equal(prepared.deployable, false);
    assert.match(prepared.dependencyIssues.join(','), /监听|路径/);
    const disabled = transport({ current: [{ ...listener, d: true }] });
    const available = await prepareFlowDeployment(target, { flows: [{ ...listener, id: 'new' }], mode: 'append' }, disabled.fetcher);
    assert.equal(available.deployable, true);
  }
});

test('every builtin can append with confirmed dependencies and config links remain within the copied graph', async () => {
  const { listBuiltinTemplates, renderBuiltinTemplate } = await import('./templates/catalog.ts');
  for (const template of listBuiltinTemplates()) {
    const rendered = renderBuiltinTemplate(template.id, { nodeId: 'plc-1', serviceCode: 'telemetry' });
    assert.ok(rendered);
    const nodeSets = [
      { id: 'node-red/core', module: 'node-red', version: '5.0.4', enabled: true, err: '',
        types: ['function', 'inject', 'catch', 'debug', 'tcp in', 'udp in', 'http in', 'http response', 'http request'] },
      ...(rendered.requirements ?? []).map((requirement) => ({
        id: `${requirement.module}/loaded`, module: requirement.module, version: requirement.version,
        enabled: true, err: '', types: requirement.nodeTypes,
      })),
    ];
    const { fetcher } = transport({ nodeSets });
    const prepared = await prepareFlowDeployment(target, { flows: rendered.flows, builtin: true, requirements: rendered.requirements ?? [] }, fetcher);
    assert.equal(prepared.deployable, true, `${template.id}: ${prepared.dependencyIssues.join(';')}`);
    assert.equal(prepared.resultNodeCount, rendered.nodeCount + 1);
    const copiedIds = new Set(prepared.flowsToDeploy.slice(1).map((node) => node.id));
    for (const node of prepared.flowsToDeploy.slice(1)) {
      if (node.type === 'modbus-read') assert.ok(copiedIds.has(String(node['server'])));
      if (node.type === 'tier0-opcua-read') assert.ok(copiedIds.has(String(node['connection'])));
      if (node.type === 'OpcUa-Client' || node.type === 's7 in') assert.ok(copiedIds.has(String(node['endpoint'])));
    }
  }
});


test('custom copies with trusted requirements retain strict dependency checks and revision protection', async () => {
  const { fetcher, writes } = transport({ failNodes: true });
  const prepared = await prepareFlowDeployment(target, { flows, requirements: [{ module: 'node-red', version: '5.0.4', nodeTypes: ['inject'] }] }, fetcher);
  assert.equal(prepared.mode, 'replace', 'custom omission keeps the existing default mode');
  assert.equal(prepared.deployable, false);
  assert.equal(prepared.revision, 'rev-1');
  await assert.rejects(() => deployPreparedFlows(target, prepared, fetcher));
  assert.equal(writes.length, 0);
});

test('controlled tier0 append keeps both reader and writer on their newly copied connection', async () => {
  const { renderBuiltinTemplate } = await import('./templates/catalog.ts');
  const rendered = renderBuiltinTemplate('builtin:opcua-controlled', { nodeId: 'device', serviceCode: 'telemetry', downlinkEnabled: true,
    commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }] })!;
  const nodeSets = [{ id: 'node-red/core', module: 'node-red', version: '5.0.4', enabled: true, err: '', types: ['function', 'inject', 'catch', 'debug', 'http request'] },
    ...rendered.requirements!.map(requirement => ({ id: `${requirement.module}/loaded`, module: requirement.module, version: requirement.version, enabled: true, err: '', types: requirement.nodeTypes }))];
  const current = [{ id: 'existing', type: 'tab' }, { id: 'connection', type: 'tier0-opcua-connection', endpoint: 'opc.tcp://existing:4840' }];
  const { fetcher } = transport({ current, nodeSets });
  const prepared = await prepareFlowDeployment(target, { flows: rendered.flows, builtin: true, requirements: rendered.requirements ?? [] }, fetcher);
  assert.equal(prepared.deployable, true, prepared.dependencyIssues.join(';'));
  assert.deepEqual(prepared.flowsToDeploy.slice(0, current.length), current);
  const copied = prepared.flowsToDeploy.slice(current.length);
  const connection = copied.find(node => node.type === 'tier0-opcua-connection')!;
  assert.notEqual(connection.id, 'connection');
  for (const type of ['tier0-opcua-read', 'tier0-opcua-write']) {
    assert.equal(copied.find(node => node.type === type)!.connection, connection.id);
  }
});
