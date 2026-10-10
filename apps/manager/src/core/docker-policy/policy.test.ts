import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCreateOptions, buildMigrationProbeCreateOptions } from '../instance/container-spec.ts';
import { tarArchive, tarFile, untar } from '../archive/tar.ts';
import { DockerExecutionPolicy, PolicyDenied, type DaemonReader, type PolicyConfig } from './policy.ts';
import { NETWORK_POLICY_DEFAULTS, deploymentRealm } from './config.ts';
import { NETWORK_POLICY_REALM_LABEL } from './network-intents.ts';
import { buildNetworkDescriptor } from './network-guard.ts';
import type { NetworkCoordinator } from './network-coordinator.ts';

const INSTANCE = 'line-a';
const C = 'a'.repeat(64), N = 'b'.repeat(64), M = 'c'.repeat(64), I = `sha256:${'d'.repeat(64)}`;
const LABELS = { 'com.mqttsnet.thinglinks-edge.managed': 'true', 'com.mqttsnet.thinglinks-edge.instance': INSTANCE };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tle-policy-'));
  await mkdir(join(root, INSTANCE));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: PolicyConfig = {
    ...NETWORK_POLICY_DEFAULTS,
    dataRoot: root, networkPrefix: 'tle-test', managerContainer: 'tle-manager', imageRepo: 'nodered/node-red',
    allowedTags: ['5.0.4-24-minimal'], allowedImageIds: [], portRange: { min: 30000, max: 30999 },
  };
  const options = buildCreateOptions({
    id: INSTANCE, imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: .5, ports: [], adminRoot: '/red/line-a/',
  }, { network: N, imageRepo: config.imageRepo, instanceDataRoot: root, timezone: 'UTC' });
  const network = { Id: N, Name: 'tle-test-line-a', Driver: 'bridge', Internal: false,
    Labels: { ...LABELS, [NETWORK_POLICY_REALM_LABEL]: deploymentRealm(config) }, Containers: {}, EnableIPv6: false,
    Options: {}, IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] } };
  const container = {
    Id: C, Name: '/tle-nr-line-a', Image: I, Config: { ...options, Image: options['Image'], Labels: LABELS,
      Env: [...options['Env'] as string[], `TLE_NETWORK_GUARD_ID=${N}`, 'TLE_NETWORK_GUARD_GATEWAY=172.30.0.1', 'TLE_NETWORK_GUARD_PORT=31555'],
    } as Record<string, unknown>,
    HostConfig: options['HostConfig'], State: { Running: false },
    Mounts: [{ Type: 'bind', Source: join(root, INSTANCE), Destination: '/data', RW: true }],
  };
  const manager = { Id: M, Name: '/tle-manager', Config: { Labels: {} } };
  const inventory: Array<{ Id: string }> = [];
  const hostCapacity = { MemTotal: 8 * 1024 ** 3, NCPU: 4 };
  const seen: string[] = [];
  const daemon: DaemonReader = {
    async json(path) {
      seen.push(path);
      if (path === '/info') return hostCapacity;
      if (path.startsWith('/containers/json?')) return inventory;
      if (path === `/networks/${N}` || path === '/networks/tle-test-line-a') return structuredClone(network);
      if (path === `/containers/${C}/json` || path === '/containers/tle-nr-line-a/json') return structuredClone(container);
      if (path === `/containers/${M}/json` || path === '/containers/tle-manager/json') return structuredClone(manager);
      if (path.startsWith('/images/') && path.endsWith('/json')) {
        if (decodeURIComponent(path).includes('nodered/node-red:5.0.4-24-minimal') || path.includes(I)) return { Id: I };
      }
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    },
  };
  const operation = async (body: Record<string, unknown>) => ({ body, beforeDispatch: async () => undefined,
    succeeded: async () => undefined, failed: async () => undefined });
  const networkCoordinator: Pick<NetworkCoordinator, 'ready' | 'prepareCreate' | 'prepareDelete'> = {
    ready: async () => buildNetworkDescriptor(network, [network], config), prepareCreate: operation, prepareDelete: operation,
  };
  const policy = new DockerExecutionPolicy(config, daemon, networkCoordinator);
  const request = (method: string, path: string, value?: unknown) => policy.authorize({
    method, path, body: Buffer.isBuffer(value) ? value : value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)),
  });
  return { root, config, options, network, container, manager, seen, policy, request, inventory, hostCapacity, networkCoordinator, daemon };
}

test('safe create pins approved image and owned network to immutable ids', async t => {
  const { request, options } = await fixture(t);
  const result = await request('POST', '/v1.51/containers/create?name=tle-nr-line-a', options);
  const body = JSON.parse(result.body!.toString());
  assert.equal(result.path, '/containers/create?name=tle-nr-line-a');
  assert.equal(body.Image, I);
  assert.equal(body.HostConfig.NetworkMode, N);
});

test('a missing guard or injected bootstrap identity cannot start or create Node-RED', async t => {
  const { request, options, networkCoordinator } = await fixture(t);
  for (const entry of ['TLE_NETWORK_GUARD_ID=forged', 'NODE_PATH=/data/attack']) {
    const candidate = structuredClone(options); candidate['Env'] = [...candidate['Env'] as string[], entry];
    await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', candidate), PolicyDenied);
  }
  networkCoordinator.ready = async () => { throw new PolicyDenied(503); };
  await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', options), PolicyDenied);
  await assert.rejects(request('POST', '/containers/tle-nr-line-a/start'), PolicyDenied);
});

test('create rejects host access and unknown Docker options before mutation', async t => {
  const { request, options, seen } = await fixture(t);
  for (const [scope, key, value] of [
    ['host', 'Privileged', true], ['host', 'NetworkMode', 'container:other'],
    ['host', 'Mounts', [{ Type: 'bind', Source: '/', Target: '/host' }]],
    ['host', 'Binds', ['/:/data']], ['host', 'CapAdd', ['SYS_ADMIN']],
    ['host', 'SecurityOpt', ['seccomp=unconfined']], ['host', 'PidsLimit', -1],
    ['top', 'User', 'root'], ['top', 'Entrypoint', ['/bin/sh']],
    ['top', 'NetworkingConfig', { EndpointsConfig: { control: {} } }],
    ['top', 'Image', 'attacker/image:latest'],
  ]) {
    const candidate = structuredClone(options);
    (scope === 'host' ? candidate['HostConfig'] as Record<string, unknown> : candidate)[key as string] = value;
    await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', candidate), PolicyDenied, String(key));
  }
  assert.ok(seen.every(path => path.startsWith('/images/') || path.startsWith('/networks/')));
});

test('daemon-side resource admission counts stopped instances and preserves host capacity', async t => {
  const { request, options, inventory, hostCapacity } = await fixture(t);
  inventory.push({ Id: C });
  hostCapacity.MemTotal = 1024 ** 3;
  await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', options), PolicyDenied);
  hostCapacity.MemTotal = 8 * 1024 ** 3; hostCapacity.NCPU = 1;
  await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', options), PolicyDenied);
});

test('labels alone cannot authorize host mounts, manager control, or foreign containers', async t => {
  const { request, container } = await fixture(t);
  await assert.rejects(request('POST', '/containers/tle-manager/stop'), PolicyDenied);
  await assert.rejects(request('POST', `/containers/${M}/restart`), PolicyDenied);
  container.Mounts[0]!.Source = '/';
  await assert.rejects(request('DELETE', `/containers/${C}?force=true`), PolicyDenied);
});

test('start and lifecycle operations forward only immutable owned container ids', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('POST', '/containers/tle-nr-line-a/start')).path, `/containers/${C}/start`);
  assert.equal((await request('POST', '/containers/tle-nr-line-a/stop?t=10')).path, `/containers/${C}/stop?t=10`);
  assert.equal((await request('POST', '/containers/tle-nr-line-a/stop?t=10', { t: 10 })).path, `/containers/${C}/stop?t=10`);
  await assert.rejects(request('POST', '/containers/tle-nr-line-a/stop?t=10', { t: 0 }), PolicyDenied);
  await assert.rejects(request('POST', '/containers/tle-nr-line-a/exec', { Cmd: ['id'] }), PolicyDenied);
  await assert.rejects(request('POST', '/containers/tle-nr-line-a/update', { Privileged: true }), PolicyDenied);
});

test('inventory is filtered by ownership without silently truncating live instances', async t => {
  const { request, root } = await fixture(t);
  const plan = await request('GET', '/containers/json?all=true');
  assert.ok(!new URL(plan.path, 'http://policy').searchParams.has('limit'));
  const filtered = await plan.transform!([
    { Id: C, Names: ['/tle-nr-line-a'], Labels: LABELS, Mounts: [{ Type: 'bind', Source: join(root, INSTANCE), Destination: '/data' }] },
    { Id: C, Names: ['/tle-nr-line-a'], Labels: LABELS, Mounts: [{ Type: 'bind', Source: '/foreign/line-a', Destination: '/data' }] },
    { Id: M, Names: ['/unrelated-host-container'], Labels: LABELS },
    { Id: M, Names: ['/tle-manager'], Labels: {} },
  ]) as unknown[];
  assert.equal(filtered.length, 1);
});

test('another deployment realm cannot be adopted even with matching instance labels and network name', async t => {
  const { request, options, network, config } = await fixture(t);
  await assert.rejects(request('POST', '/networks/create', { Name: 'tle-test-line-a', Driver: 'bridge',
    Labels: { ...LABELS, [NETWORK_POLICY_REALM_LABEL]: deploymentRealm(config) } }), PolicyDenied);
  network.Labels[NETWORK_POLICY_REALM_LABEL] = 'f'.repeat(64);
  await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', options), PolicyDenied);
  await assert.rejects(request('POST', `/networks/${N}/connect`, { Container: M, EndpointConfig: { Aliases: ['tle-manager'], GwPriority: -1 } }), PolicyDenied);
  await assert.rejects(request('DELETE', `/networks/${N}`), PolicyDenied);
});

test('legacy running instances remain inspectable but unsafe restarts require rebuild', async t => {
  const { request, container } = await fixture(t);
  container.Config.User = 'node-red';
  await request('GET', '/containers/tle-nr-line-a/json');
  await request('POST', '/containers/tle-nr-line-a/stop?t=10');
  await assert.rejects(request('POST', '/containers/tle-nr-line-a/start'), PolicyDenied);
});

test('archive writes permit only normalized settings.js in the owned data directory', async t => {
  const { request } = await fixture(t);
  const plan = await request('PUT', '/containers/tle-nr-line-a/archive?path=%2Fdata', tarFile('settings.js', 'module.exports={};'));
  assert.equal(plan.path, `/containers/${C}/archive?path=%2Fdata&noOverwriteDirNonDir=true`);
  assert.deepEqual(untar(plan.body!).map(x => x.name), ['settings.js']);
  for (const [path, archive] of [
    ['/root', tarFile('settings.js', 'bad')],
    ['/data', tarFile('../etc/shadow', 'bad')],
    ['/data', tarFile('flows.json', 'bad')],
    ['/data', tarArchive([{ name: 'settings.js', content: 'ok' }, { name: 'settings.js', content: 'bad' }])],
  ] as const) {
    await assert.rejects(request('PUT', `/containers/tle-nr-line-a/archive?path=${encodeURIComponent(path)}`, archive), PolicyDenied);
  }
});

test('data directory symlinks cannot redirect a create or archive request', async t => {
  const { request, root, options } = await fixture(t);
  await rm(join(root, INSTANCE), { recursive: true });
  await symlink('/tmp', join(root, INSTANCE));
  await assert.rejects(request('POST', '/containers/create?name=tle-nr-line-a', options), PolicyDenied);
  await assert.rejects(request('PUT', '/containers/tle-nr-line-a/archive?path=%2Fdata', tarFile('settings.js', 'ok')), PolicyDenied);
});

test('network creation and connections cannot join unrelated instances or the control network', async t => {
  const { request, network } = await fixture(t);
  await request('POST', '/networks/create', { Name: network.Name, Driver: 'bridge', Labels: LABELS });
  await assert.rejects(request('POST', '/networks/create', { Name: 'edge-docker', Driver: 'bridge', Labels: LABELS }), PolicyDenied);
  await assert.rejects(request('POST', '/networks/create', { Name: network.Name, Driver: 'macvlan', Labels: LABELS }), PolicyDenied);
  const connected = await request('POST', `/networks/${N}/connect`, {
    Container: M, EndpointConfig: { Aliases: ['tle-manager'], GwPriority: -1 },
  });
  assert.equal(JSON.parse(connected.body!.toString()).Container, M);
  await assert.rejects(request('POST', `/networks/${N}/connect`, { Container: 'foreign' }), PolicyDenied);
  await assert.rejects(request('POST', `/networks/${N}/connect`, {
    Container: M, EndpointConfig: { Aliases: ['docker-proxy'], Links: ['evil'] },
  }), PolicyDenied);
});

test('guest network connect and disconnect cannot bypass the create-time startup gate', async t => {
  const { request, network, networkCoordinator } = await fixture(t);
  let readyChecks = 0;
  networkCoordinator.ready = async () => { readyChecks++; throw new PolicyDenied(503); };
  for (const action of ['connect', 'disconnect']) {
    await assert.rejects(request('POST', `/networks/${N}/${action}`, { Container: C }), PolicyDenied);
  }
  delete (network.Labels as Record<string, unknown>)[NETWORK_POLICY_REALM_LABEL];
  await assert.rejects(request('POST', `/networks/${N}/connect`, { Container: C }), PolicyDenied);
  assert.equal(readyChecks, 0, 'unused guest networking API is closed rather than relying on a racy readiness check');
});

test('probe creation is subject to the same image, path, and namespace limits', async t => {
  const { config, root, request, network } = await fixture(t);
  const txId = 'migration-01';
  const options = buildMigrationProbeCreateOptions({
    id: INSTANCE, imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: .5, ports: [], adminRoot: '/red/line-a/',
  }, { instanceDataRoot: root, imageRepo: config.imageRepo, timezone: 'UTC', txId, imageId: I, networkId: N });
  network.Name = String(options.name) + '-net';
  network.Internal = true;
  network.Labels = { ...options['Labels'] as typeof network.Labels, [NETWORK_POLICY_REALM_LABEL]: deploymentRealm(config) };
  await mkdir(join(root, '.thinglinks-probes', INSTANCE, txId), { recursive: true });
  await request('POST', `/containers/create?name=${options.name}`, options);
  (options['HostConfig'] as Record<string, unknown>).PidMode = 'host';
  await assert.rejects(request('POST', `/containers/create?name=${options.name}`, options), PolicyDenied);
});

test('ambiguous paths, repeated query parameters, and unbounded operations are denied', async t => {
  const { request } = await fixture(t);
  for (const path of [
    '/containers/tle-nr-line-a/start?t=1&t=2', '/v1.51/../containers/tle-nr-line-a/start',
    '/containers/%2e%2e/start', '//containers/tle-nr-line-a/start',
    '/containers/tle-nr-line-a/start?detachKeys=ctrl-a', '/images/create?fromImage=evil', '/volumes/create',
  ]) await assert.rejects(request('POST', path), PolicyDenied, path);
});


test('Docker Desktop list mount aliases do not hide an owned container after immutable-ID inspection', async t => {
  const { request, root, seen, container } = await fixture(t);
  (container.HostConfig as Record<string, unknown>)['PortBindings'] = { '15001/tcp': [{ HostIp: '127.0.0.1', HostPort: '30064' }], '15002/udp': [{ HostIp: '127.0.0.1', HostPort: '30065' }] };
  const plan = await request('GET', '/containers/json?all=true');
  const summary = { Id: C, Names: ['/tle-nr-line-a'], Labels: LABELS, State: 'running', Image: 'nodered/node-red:5.0.4-24-minimal', Mounts: [{ Type: 'bind', Source: '/host_mnt'+join(root, INSTANCE), Destination: '/data' }] };
  assert.deepEqual(await plan.transform!([summary]), [summary]);
  assert.ok(seen.includes(`/containers/${C}/json`));
  assert.ok(!seen.includes('/containers/tle-nr-line-a/json'));
});

test('inventory does not trust list labels or mount suffixes when inspected ownership fails', async t => {
  const { request, root, container } = await fixture(t);
  const summary = { Id: C, Names: ['/tle-nr-line-a'], Labels: LABELS, Mounts: [{ Type: 'bind', Source: join(root, INSTANCE), Destination: '/data' }] };
  const plan = await request('GET', '/containers/json?all=true');
  const original = structuredClone(container.HostConfig);
  for (const invalid of [{ Binds: ['/foreign/line-a:/data'] }, { Privileged: true }, { CapAdd: ['SYS_ADMIN'] }]) {
    container.HostConfig = { ...original as Record<string, unknown>, ...invalid };
    assert.deepEqual(await plan.transform!([summary]), []);
  }
  container.HostConfig = original;
  container.Mounts[0]!.Source = '/foreign'+join(root, INSTANCE);
  assert.deepEqual(await plan.transform!([summary]), []);
});

test('one failed inspect is isolated, only candidate immutable IDs are queried and duplicates are inspected once', async t => {
  const { request, seen, root } = await fixture(t);
  const valid = { Id: C, Names: ['/tle-nr-line-a'], Labels: LABELS, Mounts: [{ Type:'bind',Source:join(root,INSTANCE),Destination:'/data' }] };
  const plan = await request('GET', '/containers/json?all=true');
  const missing = { ...valid, Id: 'f'.repeat(64) };
  const foreign = { ...valid, Id: M, Names: ['/unrelated-host-container'] };
  assert.deepEqual(await plan.transform!([missing, valid, valid, foreign, { ...valid, Id: 'tle-nr-line-a' }]), [valid]);
  assert.equal(seen.filter(path=>path===`/containers/${C}/json`).length,1);
  assert.ok(!seen.includes(`/containers/${M}/json`));
});

test('inventory inspection has at most four daemon reads in flight and preserves result order', async t => {
  const f = await fixture(t); let active = 0, peak = 0;
  const summaries = Array.from({ length: 11 }, (_, index) => {
    const instanceId = `line-${index}`, id = (index + 1).toString(16).padStart(64, '0');
    return { Id: id, Names: [`/tle-nr-${instanceId}`], Labels: { ...LABELS, 'com.mqttsnet.thinglinks-edge.instance': instanceId } };
  });
  const policy = new DockerExecutionPolicy(f.config, { async json(path) {
    const summary = summaries.find(item => path === `/containers/${item.Id}/json`); assert.ok(summary);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    const directory = join(f.root, summary.Labels['com.mqttsnet.thinglinks-edge.instance']);
    return { ...f.container, Id: summary.Id, Name: summary.Names[0], Config: { ...f.container.Config, Labels: summary.Labels },
      HostConfig: { ...f.container.HostConfig as Record<string, unknown>, Binds: [`${directory}:/data`] },
      Mounts: [{ Type: 'bind', Source: directory, Destination: '/data' }] };
  } }, f.networkCoordinator);
  const plan = await policy.authorize({ method: 'GET', path: '/containers/json', body: Buffer.alloc(0) });
  assert.deepEqual(await plan.transform!(summaries), summaries);
  assert.equal(peak, 4); assert.equal(active, 0);
});

test('uncertain daemon inspection never becomes a successful empty inventory', async t => {
  const f=await fixture(t);
  const summary={Id:C,Names:['/tle-nr-line-a'],Labels:LABELS,Mounts:[{Type:'bind',Source:join(f.root,INSTANCE),Destination:'/data'}]};
  for(const error of [new PolicyDenied(502),new Error('private transport detail'),new SyntaxError('private daemon response')]) {
    const policy=new DockerExecutionPolicy(f.config,{json:async()=>{throw error;}},f.networkCoordinator);
    const plan=await policy.authorize({method:'GET',path:'/containers/json',body:Buffer.alloc(0)});
    await assert.rejects(async()=>{await plan.transform!([summary]);},(failure:unknown)=>failure instanceof PolicyDenied&&failure.statusCode===502&&!failure.message.includes('private'));
  }
});
