import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRestorePeer, restoreWriterSnapshot } from './restore-maintenance.ts';
import { NETWORK_POLICY_DEFAULTS, type PolicyConfig } from './config.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerPolicyServer } from './server.ts';
import { NetworkIntentStore } from './network-intents.ts';

const root = '/srv/test-edge';
const managerId = 'a'.repeat(64), oneoffId = 'b'.repeat(64), writerId = 'c'.repeat(64);
const config: PolicyConfig = { ...NETWORK_POLICY_DEFAULTS, dataRoot: `${root}/instances`, networkPrefix: 'tle-test',
  managerContainer: 'test-manager', imageRepo: 'nodered/node-red', allowedTags: ['5.0.7-24-minimal'],
  allowedImageIds: [], portRange: { min: 30000, max: 30999 } };
const baseLabels = { 'com.docker.compose.project': 'test-edge', 'com.docker.compose.service': 'manager',
  'com.docker.compose.project.config_files': '/srv/compose.yml', 'com.docker.compose.project.working_dir': '/srv' };
function fixture() {
  const manager = { Id: managerId, Name: '/test-manager', Image: `sha256:${'e'.repeat(64)}`,
    Config: { User: 'node', Labels: { ...baseLabels, 'com.docker.compose.oneoff': 'False' } },
    State: { Status: 'exited', Running: false, Paused: false, Restarting: false },
    Mounts: [{ Type: 'bind', Source: root, Destination: root, RW: true }],
    NetworkSettings: { Networks: { control: { NetworkID: 'd'.repeat(64), IPAddress: '' } } } };
  const oneoff = { ...structuredClone(manager), Id: oneoffId, Name: '/test-edge-manager-run-fake',
    Config: { User: 'node', Labels: { ...baseLabels, 'com.docker.compose.oneoff': 'True' },
      Entrypoint: ['node'], Cmd: ['dist/index.js', 'restore', '/backup/sample.tle-backup'], WorkingDir: '/app',
      Env: [`EDGE_DATA_ROOT=${root}`] },
    State: { Status: 'running', Running: true, Paused: false, Restarting: false },
    HostConfig: { Privileged: false, NetworkMode: 'test-control', PidMode: '', CapAdd: [] },
    NetworkSettings: { Networks: { control: { NetworkID: 'd'.repeat(64), IPAddress: '172.31.0.3' } } } };
  const writer = { Id: writerId, Name: '/tle-nr-line-a', Config: { Labels: {
    'com.mqttsnet.thinglinks-edge.managed': 'true', 'com.mqttsnet.thinglinks-edge.instance': 'line-a' } },
    State: { Status: 'exited', Running: false, Paused: false, Restarting: false },
    Mounts: [{ Type: 'bind', Source: `${root}/instances/line-a`, Destination: '/data', RW: true }] };
  const requested: string[] = [];
  const daemon = { json: async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path.startsWith('/containers/json')) return [manager, oneoff, writer].map(({ Id }) => ({ Id }));
    if (path === `/containers/${oneoffId}/json`) return oneoff;
    if (path === `/containers/${writerId}/json`) return writer;
    if (path === `/containers/${managerId}/json` || path === '/containers/test-manager/json') return manager;
    throw new Error('unexpected daemon request');
  } };
  return { manager, oneoff, writer, daemon, requested };
}

test('stopped Manager authenticates its exact Compose restore oneoff peer', async () => {
  const f = fixture();
  assert.equal(await authorizeRestorePeer(config, f.daemon, f.manager, '172.31.0.3'), oneoffId);
  assert.ok(f.requested.every(path => path.startsWith('/containers/')));
});

test('a created Manager resolves its saved Compose network after Docker clears endpoint IDs', async () => {
  const f = fixture(); f.manager.NetworkSettings.Networks.control.NetworkID = '';
  const daemon = { json: async (path: string) => path === '/networks/control'
    ? { Id: 'd'.repeat(64), Name: 'control', Labels: { 'com.docker.compose.project': 'test-edge' } }
    : f.daemon.json(path) };
  assert.equal(await authorizeRestorePeer(config, daemon, f.manager, '172.31.0.3'), oneoffId);
});

for (const change of ['image', 'project', 'root', 'command', 'oneoff', 'peer', 'network', 'privileged'] as const) {
  test(`maintenance authentication rejects forged ${change}`, async () => {
    const f = fixture();
    if (change === 'image') f.oneoff.Image = `sha256:${'f'.repeat(64)}`;
    if (change === 'project') f.oneoff.Config.Labels['com.docker.compose.project'] = 'other';
    if (change === 'root') f.oneoff.Mounts[0]!.Source = '/other';
    if (change === 'command') f.oneoff.Config.Cmd = ['-e', 'process.exit(0)'];
    if (change === 'oneoff') f.oneoff.Config.Labels['com.docker.compose.oneoff'] = 'False';
    if (change === 'network') f.oneoff.NetworkSettings.Networks.control.NetworkID = 'f'.repeat(64);
    if (change === 'privileged') f.oneoff.HostConfig.Privileged = true;
    await assert.rejects(() => authorizeRestorePeer(config, f.daemon, f.manager, change === 'peer' ? '172.31.0.9' : '172.31.0.3'));
  });
}

for (const state of ['running', 'paused', 'restarting', 'dead', 'unknown'] as const) {
  test(`restore writer snapshot blocks ${state} even when summary Running is false`, async () => {
    const f = fixture(); f.writer.State.Status = state;
    const result = await restoreWriterSnapshot(config, f.daemon, oneoffId);
    assert.equal(result.writers.some(item => item.name === '/tle-nr-line-a' && item.stopped === false), true);
    assert.equal(JSON.stringify(result).includes('Env'), false);
  });
}

test('restore writer snapshot accepts only stopped writers and excludes its oneoff', async () => {
  const f = fixture();
  const result = await restoreWriterSnapshot(config, f.daemon, oneoffId);
  assert.equal(result.writers.length, 2);
  assert.ok(result.writers.every(item => item.stopped));
});

test('Compose maintenance peer gets only writer status, never Docker read namespaces or mutation authority', async t => {
  const f = fixture(); f.oneoff.NetworkSettings.Networks.control.IPAddress = '127.0.0.1';
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tle-maint-http-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let mutations = 0;
  const upstream = createServer((request, response) => {
    if (request.method !== 'GET') { mutations++; response.writeHead(500).end('{}'); return; }
    if (request.url === '/networks') { response.end('[]'); return; }
    void f.daemon.json(request.url!).then(value => response.end(JSON.stringify(value)), () => response.writeHead(404).end('{}'));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const server = createDockerPolicyServer(config,
    { hostname: '127.0.0.1', port: (upstream.address() as { port: number }).port }, {
      networkIntents: new NetworkIntentStore(join(directory, 'intents')),
      networkGuard: { assertAvailable: async () => undefined, register: async () => undefined,
        assertReady: async () => undefined, unregister: async () => undefined },
    });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const good = await fetch(`${url}/maintenance/restore-writers`);
  assert.equal(good.status, 200);
  assert.equal((await good.json() as { writers: unknown[] }).writers.length, 2);
  for (const [method, path] of [
    ['POST', '/containers/create'], ['POST', `/containers/${managerId}/start`],
    ['DELETE', `/containers/${writerId}`], ['GET', '/containers/json'],
    ['GET', '/version'], ['GET', '/maintenance/restore-writers?all=true'],
  ] as const) {
    assert.equal((await fetch(url + path, { method, headers: { 'x-forwarded-for': '172.31.0.2' } })).status, 403);
  }
  assert.equal(mutations, 0);
  f.oneoff.Config.Cmd = ['dist/index.js', 'preflight'];
  assert.equal((await fetch(`${url}/maintenance/restore-writers`)).status, 403);
});
