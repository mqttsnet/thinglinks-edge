import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminApiError,
  getInstalledModules,
  getInstalledNodeSets,
  getModuleDetail,
  installModule,
  stageModule,
  uninstallModule,
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
