import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { createDockerPolicyServer } from './server.ts';
import { buildCreateOptions } from '../instance/container-spec.ts';
import { NETWORK_POLICY_DEFAULTS, deploymentRealm, type PolicyConfig } from './config.ts';
import { NetworkIntentStore, NETWORK_POLICY_OP_LABEL, NETWORK_POLICY_REALM_LABEL } from './network-intents.ts';
import type { NetworkGuardClient } from './network-guard.ts';

const fakeGuard: NetworkGuardClient = {
  assertAvailable: async () => undefined, register: async () => undefined,
  assertReady: async () => undefined, unregister: async () => undefined,
};

test('rejected requests never reach daemon mutation; successful create has pinned parameters', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-policy-http-')));
  await mkdir(join(root, 'line-a'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '1'.repeat(64), networkId = '2'.repeat(64), imageId = `sha256:${'3'.repeat(64)}`;
  const labels = { 'com.mqttsnet.thinglinks-edge.managed': 'true', 'com.mqttsnet.thinglinks-edge.instance': 'line-a' };
  const mutations: Array<{ path: string; body: unknown }> = [];
  let creating = 0, peakCreating = 0;
  let currentOptions: Record<string, unknown> | undefined;
  const networkLabels: Record<string, string> = { ...labels, [NETWORK_POLICY_OP_LABEL]: 'e'.repeat(32),
    [NETWORK_POLICY_REALM_LABEL]: deploymentRealm({ dataRoot: root, networkPrefix: 'tle-test' }) };
  const network = () => ({ Id: networkId, Name: 'tle-test-line-a', Driver: 'bridge', Internal: false, Labels: networkLabels,
    EnableIPv6: false, Options: {}, Containers: {}, IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] } });
  const networkRecords = new Map<string, Record<string, unknown>>([[networkId, network()]]);
  const upstream = createServer((req, res) => {
    void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') {
      mutations.push({ path: req.url!, body: JSON.parse(body || '{}') });
      if (req.url?.startsWith('/containers/create')) {
        currentOptions = JSON.parse(body) as Record<string, unknown>;
        creating++; peakCreating = Math.max(peakCreating, creating);
        await new Promise(resolve => setTimeout(resolve, 10));
        creating--;
      }
      if (req.url === '/networks/create') {
        const input = JSON.parse(body) as { Labels: Record<string, string>; Name: string };
        const createdId = '5'.repeat(64);
        networkRecords.set(createdId, { ...network(), Id: createdId, Name: input.Name, Labels: input.Labels,
          IPAM: { Config: [{ Subnet: '172.31.0.0/24', Gateway: '172.31.0.1' }] } });
        res.writeHead(201).end(JSON.stringify({ Id: createdId })); return;
      }
      if (req.url?.includes('/stop')) res.writeHead(204).end();
      else res.writeHead(201).end(JSON.stringify({ Id: id }));
      return;
    }
    if (req.url === '/containers/tle-manager/json') {
      res.end(JSON.stringify({ Id: '4'.repeat(64), Name: '/tle-manager', NetworkSettings: { Networks: { control: { IPAddress: '127.0.0.1' } } } })); return;
    }
    if (req.url === '/info') { res.end(JSON.stringify({ MemTotal: 8 * 1024 ** 3, NCPU: 4 })); return; }
    if (req.url?.startsWith('/containers/json?')) { res.end('[]'); return; }
    if (req.url?.startsWith('/images/')) { res.end(JSON.stringify({ Id: imageId })); return; }
    if (req.url?.startsWith('/networks/')) {
      const reference = req.url.slice('/networks/'.length);
      const found = networkRecords.get(reference) ?? [...networkRecords.values()].find(item => item['Name'] === reference);
      if (found) { res.end(JSON.stringify(found)); return; }
    }
    if (req.url === '/networks') { res.end(JSON.stringify([...networkRecords.values()])); return; }
    if (req.url === `/containers/${id}/json`) {
      res.end(JSON.stringify({ Id: id, Name: '/tle-nr-line-a', Image: imageId, Config: currentOptions,
        HostConfig: currentOptions?.['HostConfig'], Mounts: [{ Type: 'bind', Source: join(root, 'line-a'), Destination: '/data', RW: true }] })); return;
    }
    res.writeHead(404).end(JSON.stringify({ message: 'fake upstream secret must never be echoed' }));
    })().catch(() => res.destroy());
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const config: PolicyConfig = { ...NETWORK_POLICY_DEFAULTS, dataRoot: root, networkPrefix: 'tle-test', managerContainer: 'tle-manager',
    imageRepo: 'nodered/node-red', allowedTags: ['5.0.4-24-minimal'], allowedImageIds: [], portRange: { min: 30000, max: 30999 } };
  const proxy = createDockerPolicyServer(config, { hostname: '127.0.0.1', port: (upstream.address() as { port: number }).port },
    { networkGuard: fakeGuard, networkIntents: new NetworkIntentStore(join(root, 'intents')) });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const create = buildCreateOptions({ id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 128, cpus: .25, ports: [], adminRoot: '/red/line-a/' },
    { network: networkId, imageRepo: config.imageRepo, instanceDataRoot: root, timezone: 'UTC' });
  const send = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const unsafe = structuredClone(create); (unsafe['HostConfig'] as Record<string, unknown>)['Privileged'] = true;
  for (const [path, body] of [
    ['/containers/create?name=tle-nr-line-a', unsafe],
    ['/containers/tle-manager/exec', { Cmd: ['passwd', 'root'] }],
    ['/networks/create', { Name: 'control', Driver: 'host', Labels: labels }],
  ] as const) {
    const response = await send(path, body);
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes('fake upstream secret'));
  }
  assert.equal(mutations.length, 0);
  const accepted = await send('/containers/create?name=tle-nr-line-a', create);
  assert.equal(accepted.status, 201);
  assert.equal(mutations.length, 1);
  assert.equal((mutations[0]!.body as { Image: string }).Image, imageId);
  const sdk = new Docker({ host: '127.0.0.1', port: (proxy.address() as { port: number }).port, version: 'v1.51' });
  await sdk.createContainer({ _query: { name: create['name'] }, _body: create } as unknown as Docker.ContainerCreateOptions);
  assert.equal(mutations[1]!.path, '/containers/create?name=tle-nr-line-a');
  assert.ok(!mutations[1]!.path.includes('Env'));
  await sdk.createNetwork({ _query: {}, _body: { Name: 'tle-test-line-b', Driver: 'bridge', Labels: { ...labels, 'com.mqttsnet.thinglinks-edge.instance': 'line-b' } } } as unknown as Docker.NetworkCreateOptions);
  assert.equal(mutations[2]!.path, '/networks/create');
  await sdk.getContainer(id).stop({ t: 10 });
  assert.equal(mutations[3]!.path, `/containers/${id}/stop?t=10`);
  const concurrent = await Promise.all([
    send('/containers/create?name=tle-nr-line-a', create), send('/containers/create?name=tle-nr-line-a', create),
  ]);
  assert.ok(concurrent.every(result => result.status === 201));
  assert.equal(peakCreating, 1, 'admission and create must be serialized until daemon completion');
  const oversized = await send('/containers/create?name=tle-nr-line-a', { padding: 'x'.repeat(5 * 1024 ** 2) });
  assert.equal(oversized.status, 413);
  assert.equal(mutations.length, 6);
});

test('caller IP must belong to the configured Manager; health is local and read only', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-policy-peer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = createServer((req, res) => res.end(req.url === '/networks' ? '[]' : JSON.stringify({ Name: '/tle-manager', Id: 'a'.repeat(64),
    NetworkSettings: { Networks: { control: { IPAddress: '10.10.0.2' } } } })));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createDockerPolicyServer({ ...NETWORK_POLICY_DEFAULTS, dataRoot: root, networkPrefix: 'tle-test', managerContainer: 'tle-manager',
    imageRepo: 'nodered/node-red', allowedTags: ['5.0.4-24-minimal'], allowedImageIds: [], portRange: { min: 30000, max: 30999 } },
  { hostname: '127.0.0.1', port: (upstream.address() as { port: number }).port },
  { networkGuard: fakeGuard, networkIntents: new NetworkIntentStore(join(root, 'intents')) });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  assert.equal((await fetch(base + '/version')).status, 403);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('startup recovery retries a transient daemon failure and stops its retry timer on close', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-policy-retry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const upstream = createServer((_request, response) => {
    attempts++;
    response.writeHead(attempts === 1 ? 503 : 200, { 'content-type': 'application/json' });
    response.end(attempts === 1 ? '{"message":"temporarily unavailable"}' : '[]');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createDockerPolicyServer({ ...NETWORK_POLICY_DEFAULTS, dataRoot: root, networkPrefix: 'tle-test', managerContainer: 'tle-manager',
    imageRepo: 'nodered/node-red', allowedTags: ['5.0.4-24-minimal'], allowedImageIds: [], portRange: { min: 30000, max: 30999 } },
  { hostname: '127.0.0.1', port: (upstream.address() as { port: number }).port },
  { networkGuard: fakeGuard, networkIntents: new NetworkIntentStore(join(root, 'intents')), recoveryRetry: { initialMs: 10, maxMs: 30 } });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/healthz`;
  let status = 0;
  for (let poll = 0; poll < 25; poll++) {
    status = (await fetch(url)).status; if (status === 200) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status, 200); assert.equal(attempts, 2);
  proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  const completedAttempts = attempts;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(attempts, completedAttempts);
});

test('persistent recovery failure backs off and server close cancels scheduled retries', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-policy-retry-stop-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const upstream = createServer((_request, response) => { attempts++; response.writeHead(503).end('{}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createDockerPolicyServer({ ...NETWORK_POLICY_DEFAULTS, dataRoot: root, networkPrefix: 'tle-test', managerContainer: 'tle-manager',
    imageRepo: 'nodered/node-red', allowedTags: ['5.0.4-24-minimal'], allowedImageIds: [], portRange: { min: 30000, max: 30999 } },
  { hostname: '127.0.0.1', port: (upstream.address() as { port: number }).port },
  { networkGuard: fakeGuard, networkIntents: new NetworkIntentStore(join(root, 'intents')), recoveryRetry: { initialMs: 10, maxMs: 30 } });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  for (let poll = 0; poll < 25 && attempts < 2; poll++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(attempts >= 2);
  const result = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/healthz`);
  assert.equal(result.status, 503);
  proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  const stoppedAttempts = attempts;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(attempts, stoppedAttempts);
});

test('real Docker SDK inventory awaits immutable inspect and retains owned Desktop mount aliases', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-policy-desktop-list-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id='a'.repeat(64), managerId='b'.repeat(64), networkId='c'.repeat(64);
  const labels={ 'com.mqttsnet.thinglinks-edge.managed':'true','com.mqttsnet.thinglinks-edge.instance':'line-a' };
  const options=buildCreateOptions({id:'line-a',imageTag:'5.0.4-24-minimal',memoryMb:512,cpus:.5,ports:[{hostPort:30064,containerPort:15001,protocol:'tcp',hostIp:'127.0.0.1'}],adminRoot:'/red/line-a/'},{network:networkId,imageRepo:'nodered/node-red',instanceDataRoot:root,timezone:'UTC'});
  const summary={Id:id,Names:['/tle-nr-line-a'],Labels:labels,State:'running',Image:'nodered/node-red:5.0.4-24-minimal',Ports:[{IP:'127.0.0.1',PrivatePort:15001,PublicPort:30064,Type:'tcp'}],Mounts:[{Type:'bind',Source:'/host_mnt'+join(root,'line-a'),Destination:'/data'}]};
  const seen:string[]=[]; let inspectFails=false;
  const upstream=createServer((req,res)=>{seen.push(req.url!);res.setHeader('content-type','application/json');
    if(req.url==='/containers/tle-manager/json'){res.end(JSON.stringify({Id:managerId,Name:'/tle-manager',NetworkSettings:{Networks:{control:{IPAddress:'127.0.0.1'}}}}));return;}
    if(req.url==='/networks'){res.end('[]');return;}
    if(req.url?.startsWith('/containers/json?')){res.end(JSON.stringify([summary]));return;}
    if(req.url===`/containers/${id}/json`){if(inspectFails){res.writeHead(500).end(JSON.stringify({message:'private daemon body'}));return;}setTimeout(()=>res.end(JSON.stringify({Id:id,Name:'/tle-nr-line-a',Config:{...options,Labels:labels},HostConfig:options['HostConfig'],Mounts:[{Type:'bind',Source:join(root,'line-a'),Destination:'/data'}]})),20);return;}
    res.writeHead(404).end('{}');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=createDockerPolicyServer({...NETWORK_POLICY_DEFAULTS,dataRoot:root,networkPrefix:'tle-test',managerContainer:'tle-manager',imageRepo:'nodered/node-red',allowedTags:['5.0.4-24-minimal'],allowedImageIds:[],portRange:{min:30000,max:30999}},
    {hostname:'127.0.0.1',port:(upstream.address() as {port:number}).port},{networkGuard:fakeGuard,networkIntents:new NetworkIntentStore(join(root,'intents'))});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(()=>{proxy.closeAllConnections();proxy.close();upstream.closeAllConnections();upstream.close();});
  const sdk=new Docker({host:'127.0.0.1',port:(proxy.address() as {port:number}).port,version:'v1.51'});
  const listed=await sdk.listContainers({all:true});
  assert.equal(listed.length,1);assert.equal(listed[0]!.Id,id);assert.equal(listed[0]!.State,'running');
  assert.deepEqual(listed[0]!.Ports,summary.Ports);
  assert.equal(seen.filter(path=>path===`/containers/${id}/json`).length,1);
  assert.ok(!seen.includes('/containers/tle-nr-line-a/json'));
  inspectFails=true;
  await assert.rejects(sdk.listContainers({all:true}),(error:unknown)=>(error as {statusCode?:number}).statusCode===502&&!String((error as Error).message).includes('private daemon body'));
});
