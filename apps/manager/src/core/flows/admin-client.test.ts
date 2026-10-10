import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  AdminApiError,
  getFlowSnapshot,
  setFlowSnapshot,
  getInstalledModules,
  getInstalledNodeSets,
  getModuleDetail,
  installModule,
  stageModule,
  uninstallModule,
  createSingleFlow,
  getSingleFlow,
  deleteSingleFlow,
  listFlowsAuthenticated,
  getInstalledModulesAuthenticated,
  MANAGED_FLOW_RESPONSE_MAX_BYTES,
  ManagedFlowResponseTooLargeError,
} from './admin-client.ts';

const target = { upstream: 'http://x', adminRoot: '/red/a/', username: 'u', password: 'p' };

const duplicateResponse = {
  name: '@mqttsnet/thinglinks-edge-nodes',
  version: '0.0.1',
  nodes: [{
    id: '@mqttsnet/thinglinks-edge-nodes/tl-device',
    name: 'tl-device',
    module: '@mqttsnet/thinglinks-edge-nodes',
    version: '0.0.1',
    types: ['tl-device'],
    enabled: true,
    err: 'type_already_registered',
    file: '/data/node_modules/@mqttsnet/thinglinks-edge-nodes/tl-device.js',
  }],
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith('auth/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

test('strict install rejects a 200 response that reports a node-set load error', async () => {
  await assert.rejects(
    () => installModule(
      target, duplicateResponse.name, duplicateResponse.version, fakeFetch(duplicateResponse),
    ),
    /type_already_registered/,
  );
});

test('single-flow Admin calls use real HTTP add/get/delete routes and preserve Node-RED assigned tab ID', async t => {
  const requests: string[] = [];
  let posted: Record<string, unknown> | undefined;
  const server = createServer((req, res) => { void (async () => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/red/test/auth/token') { res.end('{"access_token":"temporary-test-token"}'); return; }
    assert.equal(req.headers.authorization, 'Bearer temporary-test-token');
    assert.equal(req.headers['node-red-deployment-type'], undefined);
    if (req.url === '/red/test/flow' && req.method === 'POST') {
      let text = ''; for await (const part of req) text += part;
      posted = JSON.parse(text); res.end('{"id":"node-red-assigned"}'); return;
    }
    if (req.url === '/red/test/flow/node-red-assigned' && req.method === 'GET') {
      res.end(JSON.stringify({ ...posted, id: 'node-red-assigned' })); return;
    }
    if (req.url === '/red/test/flow/node-red-assigned' && req.method === 'DELETE') { res.writeHead(204).end(); return; }
    res.writeHead(404).end();
  })().catch(() => { res.writeHead(500).end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const local = { ...target, upstream: `http://127.0.0.1:${address.port}`, adminRoot: '/red/test/' };
  const flow = { id: 'placeholder', label: 'isolated test', nodes: [{ id: 'reader', type: 'inject' }], configs: [] };
  const created = await createSingleFlow(local, flow);
  assert.equal(created.id, 'node-red-assigned');
  const observed = await getSingleFlow(local, created.id);
  assert.equal(observed.id, created.id);
  assert.deepEqual(observed.nodes, flow.nodes);
  await deleteSingleFlow(local, created.id);
  assert.deepEqual(requests.filter(path => !path.endsWith('auth/token')), [
    'POST /red/test/flow', 'GET /red/test/flow/node-red-assigned', 'DELETE /red/test/flow/node-red-assigned',
  ]);
});

test('single-flow calls fail closed on bad ID, auth, absent flow or malformed responses without retry', async () => {
  let calls = 0;
  const denied = (async () => { calls++; return new Response('', { status: 401 }); }) as typeof fetch;
  for (const id of ['global', '', '../flows', 'a/b', 'a?x=1']) {
    await assert.rejects(() => deleteSingleFlow(target, id, denied), AdminApiError);
  }
  assert.equal(calls, 0);
  await assert.rejects(() => getSingleFlow(target, 'own-flow', denied), AdminApiError);
  assert.equal(calls, 1, 'never retries without the required credential');
  await assert.rejects(() => getSingleFlow(target, 'own-flow', fakeFetch({}, 404)),
    (error: unknown) => error instanceof AdminApiError && error.status === 404);
  await assert.rejects(() => createSingleFlow(target, { nodes: [] }, fakeFetch({})), /标识/);
  await assert.rejects(() => getSingleFlow(target, 'own-flow', fakeFetch({ id: 'different', nodes: [] })), /标识/);
  await assert.rejects(() => getSingleFlow(target, 'own-flow', fakeFetch({ id: 'own-flow', nodes: 'wrong' })), /格式/);
  await assert.rejects(() => getSingleFlow(target, 'own-flow', fakeFetch({ id: 'own-flow', nodes: [], padding: 'x'.repeat(1_048_576) })), /大小限制/);
});

test('single-flow HTTP deadline bounds even a response body that never completes', async t => {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/auth/token')) { res.end('{"access_token":"temporary-test-token"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(() => getSingleFlow({ ...target, upstream: `http://127.0.0.1:${address.port}` }, 'own-flow', fetch, 100), AdminApiError);
});

test('strict diagnostic deadline is shared by authentication and the following HTTP read', async t => {
  let dataRequests = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/auth/token')) {
      timers.push(setTimeout(() => { res.end('{"access_token":"temporary-test-token"}'); }, 150));
      return;
    }
    dataRequests++;
    timers.push(setTimeout(() => { res.end('[]'); }, 150));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { timers.forEach(clearTimeout); server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(() => getInstalledModulesAuthenticated({ ...target, upstream: `http://127.0.0.1:${address.port}` }, fetch, 250), AdminApiError);
  assert.equal(dataRequests, 1, 'authentication succeeded; the shared deadline expired while reading modules');
});

test('strict early auth failure, operation failure and DELETE release unread HTTP response bodies', async t => {
  for (const mode of ['auth-error', 'operation-error', 'delete']) {
    let markClosed!: () => void;
    const closed = new Promise<void>(resolve => { markClosed = resolve; });
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/auth/token') && mode !== 'auth-error') {
        res.end('{"access_token":"temporary-test-token"}'); return;
      }
      res.on('close', markClosed);
      res.writeHead(mode === 'delete' ? 200 : mode === 'auth-error' ? 401 : 500);
      res.write('body deliberately left open');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const local = { ...target, upstream: `http://127.0.0.1:${address.port}` };
    if (mode === 'delete') await deleteSingleFlow(local, 'own-flow');
    else await assert.rejects(() => getSingleFlow(local, 'own-flow'), AdminApiError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${mode}: response connection was not released`)), 1000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
});

test('diagnostic discovery requires authenticated bounded GET flows and never falls back anonymously', async () => {
  const calls: string[] = [];
  const reader = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/auth/token')) return new Response('{"access_token":"fixture-token"}');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    return new Response('[{"id":"tab","type":"tab"},{"id":"owned","z":"tab","type":"function"}]');
  }) as typeof fetch;
  assert.deepEqual(await listFlowsAuthenticated(target, reader), [
    { id: 'tab', type: 'tab' }, { id: 'owned', z: 'tab', type: 'function' },
  ]);
  assert.deepEqual(calls, ['POST http://x/red/a/auth/token', 'GET http://x/red/a/flows']);
  calls.length = 0;
  const denied = (async (url: string) => { calls.push(url); return new Response('', { status: 401 }); }) as typeof fetch;
  await assert.rejects(() => listFlowsAuthenticated(target, denied), AdminApiError);
  assert.equal(calls.length, 1);
});

test('diagnostic flow discovery reserves capacity against actual UTF-8 bytes and raw JSON whitespace', async () => {
  assert.equal(MANAGED_FLOW_RESPONSE_MAX_BYTES, 1_048_576);
  const textFetch = (body: string) => (async (url: string) => url.endsWith('/auth/token')
    ? new Response('{"access_token":"fixture-token"}') : new Response(body)) as typeof fetch;
  const bodies = [' [{"id":"owned","type":"comment","name":"现场"}] ', ' '.repeat(64) + '[]'];
  for (const raw of bodies) {
    const size = Buffer.byteLength(raw, 'utf8');
    const reserved = MANAGED_FLOW_RESPONSE_MAX_BYTES - size;
    assert.deepEqual(await listFlowsAuthenticated(target, textFetch(raw), 1000, reserved), JSON.parse(raw));
    await assert.rejects(() => listFlowsAuthenticated(target, textFetch(raw), 1000, reserved + 1),
      (error: unknown) => error instanceof ManagedFlowResponseTooLargeError && /大小限制/.test(error.message) && !error.message.includes('owned') && !error.message.includes('现场'));
  }
  await assert.rejects(() => listFlowsAuthenticated(target, textFetch(' '.repeat(64) + '[]'), 1000, MANAGED_FLOW_RESPONSE_MAX_BYTES - 2), /大小限制/);
  await assert.rejects(() => listFlowsAuthenticated(target, textFetch('[]'), 1000, MANAGED_FLOW_RESPONSE_MAX_BYTES), /大小限制/);
});

test('invalid flow capacity reservations are rejected before any authentication or network call', async () => {
  let requests = 0;
  const fetcher = (async () => { requests++; return new Response('[]'); }) as typeof fetch;
  for (const reserved of [-1, 0.5, MANAGED_FLOW_RESPONSE_MAX_BYTES + 1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => listFlowsAuthenticated(target, fetcher, 1000, reserved), AdminApiError);
  }
  assert.equal(requests, 0);
});

test('diagnostic module discovery requires one token and preserves complete node-set ownership evidence', async () => {
  const calls: string[] = [];
  const reader = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/auth/token')) return new Response('{"access_token":"fixture-token"}');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    return new Response(JSON.stringify([{ module: 'node-red-contrib-modbus', version: '5.60.2', id: 'modbus-client', name: 'modbus-client',
      types: ['modbus-client'], enabled: true, err: '', local: true }]));
  }) as typeof fetch;
  const modules = await getInstalledModulesAuthenticated(target, reader);
  assert.equal(modules[0]?.module, 'node-red-contrib-modbus');
  assert.equal(modules[0]?.nodeSets[0]?.enabled, true);
  assert.deepEqual(modules[0]?.observedVersions, ['5.60.2']);
  assert.deepEqual(calls, ['POST http://x/red/a/auth/token', 'GET http://x/red/a/nodes']);
  let deniedCalls = 0;
  const denied = (async () => { deniedCalls++; return new Response('', { status: 401 }); }) as typeof fetch;
  await assert.rejects(() => getInstalledModulesAuthenticated(target, denied), AdminApiError);
  assert.equal(deniedCalls, 1);
  await assert.rejects(() => getInstalledModulesAuthenticated(target, fakeFetch({ payload: 'x'.repeat(1_048_576) })), /大小限制/);
});

test('strict diagnostic calls also bound token responses before sending any data request', async () => {
  let dataRequests = 0;
  const largeToken = (async (url: string) => {
    if (url.endsWith('/auth/token')) return new Response(JSON.stringify({ access_token: 'x'.repeat(32_768) }));
    dataRequests++; return new Response('[]');
  }) as typeof fetch;
  await assert.rejects(() => getInstalledModulesAuthenticated(target, largeToken),
    (error: unknown) => error instanceof AdminApiError && !(error instanceof ManagedFlowResponseTooLargeError) && /大小限制/.test(error.message));
  assert.equal(dataRequests, 0);
});

test('stage preserves duplicate evidence returned by the Admin API', async () => {
  const staged = await stageModule(
    target, duplicateResponse.name, duplicateResponse.version, fakeFetch(duplicateResponse),
  );
  assert.equal(staged.nodeSets[0]?.err, 'type_already_registered');
  assert.deepEqual(staged.observedFiles, [
    '/data/node_modules/@mqttsnet/thinglinks-edge-nodes/tl-device.js',
  ]);
});

test('GET nodes keeps a node set valid when Node-RED omits optional file evidence', async () => {
  const sets = await getInstalledNodeSets(target, fakeFetch([{
    id: 'node-red/inject', name: 'inject', module: 'node-red', version: '5.0.4',
    local: false, types: ['inject'], enabled: true, err: '',
  }]));

  assert.deepEqual(sets, [{
    id: 'node-red/inject', name: 'inject', module: 'node-red', version: '5.0.4',
    local: false, types: ['inject'], enabled: true, err: '',
  }]);
});

test('GET nodes identifies raw platform ownership from module and exact node type, not file', async () => {
  const modules = await getInstalledModules(target, fakeFetch([{
    id: 'tl-device', name: 'tl-device', module: 'node-red', version: '5.0.4',
    local: true, types: ['tl-device'], enabled: true, err: '',
  }]));

  assert.equal(modules[0]?.source, 'raw');
  assert.deepEqual(modules[0]?.observedFiles, []);
});

test('module detail preserves Admin API fields without inventing a package path', async () => {
  const detail = await getModuleDetail(target, '@mqttsnet/thinglinks-edge-nodes', fakeFetch({
    name: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', nodes: [{
      id: '@mqttsnet/thinglinks-edge-nodes/tl-tag', name: 'tl-tag',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1',
      types: ['tl-tag'], enabled: true, err: '',
    }],
  }));

  assert.deepEqual(detail.observedFiles, []);
  assert.equal(detail.nodeSets[0]?.file, undefined);
  assert.equal(detail.module, '@mqttsnet/thinglinks-edge-nodes');
});

test('uninstall rejects Node-RED error responses instead of reporting success', async () => {
  await assert.rejects(
    () => uninstallModule(target, 'missing-node', fakeFetch({ code: 'not_found' }, 404)),
    (error: unknown) => error instanceof AdminApiError && error.status === 404,
  );
});


test('revision-aware flow read and append write use Node-RED v2 without restarting unchanged flows', async () => {
  const requests: { headers: Headers; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('auth/token')) return new Response('{"access_token":"t"}');
    requests.push({ headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(init?.method === 'POST' ? { rev: 'two' } : { rev: 'one', flows: [{ id: 'a', type: 'tab' }] }));
  }) as typeof fetch;
  const snapshot = await getFlowSnapshot(target, fetcher);
  assert.equal(snapshot.rev, 'one');
  assert.deepEqual(snapshot.flows, [{ id: 'a', type: 'tab' }]);
  await setFlowSnapshot(target, snapshot, 'flows', fetcher);
  assert.equal(requests[0]?.headers.get('node-red-api-version'), 'v2');
  assert.equal(requests[1]?.headers.get('node-red-api-version'), 'v2');
  assert.equal(requests[1]?.headers.get('node-red-deployment-type'), 'flows');
  assert.deepEqual(requests[1]?.body, { rev: 'one', flows: [{ id: 'a', type: 'tab' }] });
});

test('revision-aware calls reject unsupported snapshots and report stale revision without retry', async () => {
  await assert.rejects(() => getFlowSnapshot(target, fakeFetch([])), /版本|revision/);
  await assert.rejects(() => getFlowSnapshot(target, fakeFetch({ flows: [] })), /版本|revision/);
  let writes = 0;
  const fetcher = (async (url: string) => {
    if (url.endsWith('auth/token')) return new Response('{"access_token":"t"}');
    writes += 1;
    return new Response('{"code":"version_mismatch"}', { status: 409 });
  }) as typeof fetch;
  await assert.rejects(() => setFlowSnapshot(target, { rev: 'stale', flows: [] }, 'flows', fetcher),
    (error: unknown) => error instanceof AdminApiError && error.status === 409 && /重新预览/.test(error.message));
  assert.equal(writes, 1);
});
