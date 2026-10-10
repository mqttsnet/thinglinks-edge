/** Real, bounded Node-RED A/B isolation acceptance. Never targets existing instances. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { createConnection } from 'node:net';
import bcrypt from 'bcryptjs';
import { assertExactDockerResource, createFixtureIdentity } from './_real-instance-fixture.mjs';

const MANAGED = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE = 'com.mqttsnet.thinglinks-edge.instance';
const TX = 'com.mqttsnet.thinglinks-edge.bootstrap-tx';
const FIXTURE = 'com.mqttsnet.thinglinks-edge.verifier-invocation';
const ALLOWED_OPTIONS = new Set(['node-red-image', 'manager-container', 'manager-owner', 'manager-url', 'policy-url', 'data-root', 'network-prefix', 'report', 'build-dir', 'load-ms', 'load-bytes', 'port-min', 'port-max']);
const HELP = `Usage: node verify-instance-isolation.mjs --run
  --node-red-image <existing local image tag>
  --manager-container <full 64-character temporary Manager id>
  --manager-owner <exact-label=exact-value>
  --manager-url <container URL reachable from A>
  --policy-url <Docker policy URL reachable from temporary Manager>
  --data-root <temporary policy data root, shared at the same absolute host path>
  --network-prefix <temporary policy network prefix>
  --report <absolute JSON report path>
  [--build-dir <compiled Manager dist>] [--port-min <30000>] [--port-max <30999>] [--load-ms <1..10000>] [--load-bytes <1..8388608>]
Only local cached images are used. The script inventories Docker before any changes,
creates random task-owned A/B resources, and removes only captured immutable IDs.
A is limited to 128 MiB / 0.2 CPU; its in-process load lasts at most 10 seconds.
Host/published-port reachability is reported as an isolation failure, never a pass.`;

export function parseIsolationArgs(argv) {
  if (argv.includes('--help')) return { help: true };
  const values = new Map();
  let run = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') { run = true; continue; }
    const name = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || !ALLOWED_OPTIONS.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('unknown or incomplete isolation option');
    values.set(name, argv[++i]);
  }
  if (!run) throw new Error('missing --run (explicit isolated acceptance required)');
  for (const name of ['node-red-image', 'manager-container', 'manager-owner', 'manager-url', 'policy-url', 'data-root', 'network-prefix', 'report']) {
    if (!values.has(name)) throw new Error(`missing --${name}`);
  }
  const managerContainer = values.get('manager-container');
  if (!/^[a-f0-9]{64}$/.test(managerContainer)) throw new Error('Manager must be an immutable 64-character ID');
  const rawOwner = values.get('manager-owner'), split = rawOwner.indexOf('=');
  if (split < 1 || split === rawOwner.length - 1) throw new Error('manager-owner must name an exact fixture label');
  const managerOwner = [rawOwner.slice(0, split), rawOwner.slice(split + 1)];
  if ([MANAGED, INSTANCE].includes(managerOwner[0])) throw new Error('generic managed labels are not fixture ownership');
  for (const name of ['manager-url', 'policy-url']) {
    const url = new URL(values.get(name));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('fixture URLs must not contain credentials, query or fragment');
  }
  const dataRoot = values.get('data-root'), report = values.get('report');
  if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot || dataRoot === '/' || /[\0\r\n:]/.test(dataRoot)) throw new Error('data root must be a canonical absolute temporary root');
  if (!isAbsolute(report)) throw new Error('report path must be absolute');
  const networkPrefix = values.get('network-prefix');
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(networkPrefix)) throw new Error('network prefix is invalid');
  const loadMs = Number(values.get('load-ms') ?? 10000), loadBytes = Number(values.get('load-bytes') ?? 8 * 1024 ** 2);
  if (!Number.isSafeInteger(loadMs) || loadMs < 1 || loadMs > 10000) throw new Error('load-ms must be within 1..10000');
  if (!Number.isSafeInteger(loadBytes) || loadBytes < 1 || loadBytes > 8 * 1024 ** 2) throw new Error('load-bytes cannot exceed 8 MiB');
  const portRange = { min: Number(values.get('port-min') ?? 30000), max: Number(values.get('port-max') ?? 30999) };
  if (!Number.isInteger(portRange.min) || !Number.isInteger(portRange.max) || portRange.min < 1024 || portRange.max > 65535 || portRange.min > portRange.max) throw new Error('invalid policy port range');
  return { managerContainer, managerOwner, portRange, managerUrl: values.get('manager-url'), policyUrl: values.get('policy-url'),
    nodeRedImage: values.get('node-red-image'), dataRoot, networkPrefix, report, loadMs, loadBytes,
    buildDir: resolve(values.get('build-dir') ?? fileURLToPath(new URL('../dist', import.meta.url))) };
}

export function assertTemporaryManager(info, options) {
  if (info?.Id !== options.managerContainer) throw new Error('temporary Manager identity mismatch');
  if (info?.Name === '/thinglinks-edge-manager' || info?.Name === '/tle-nr-line-1') throw new Error('refusing production Manager or line-1');
  if (info?.Config?.Labels?.[options.managerOwner[0]] !== options.managerOwner[1]) throw new Error('temporary Manager ownership mismatch');
  if (!info?.State?.Running) throw new Error('temporary Manager is not running');
  return info;
}

export function assessRuntimeProbe(value) {
  return value?.uid === 1000 && value.gid === 1000 && /^0+$/.test(value.capEff ?? '') && value.noNewPrivs === '1'
    && value.shadowExists === true && value.shadowWritable === false && value.rootWriteDenied === true
    && value.dockerSocketExists === false && value.siblingReadable === false && value.ownSentinelReadable === true;
}
export function assessNetworkProbe(value) {
  if (value?.connected === true) return 'fail';
  if (value?.connected === false && ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(value.error)) return 'pass';
  return 'unverified';
}

export function buildIsolationFlows({ role, fixtureUrl, fixtureKey, loadMs, loadBytes }) {
  const tab = { id: 'qualification', type: 'tab', label: `Isolation qualification ${role}`, disabled: false, info: 'Temporary real Node-RED acceptance fixture' };
  if (role === 'a') return [tab,
    { id: 'load-in', type: 'http in', z: tab.id, name: 'Bounded load', url: '/verify/load', method: 'post', upload: false, wires: [['load']] },
    { id: 'load', type: 'function', z: tab.id, name: 'In-process 8 MiB / at most 10 seconds', outputs: 1, initialize: '', finalize: '', libs: [], timeout: 0,
      func: `if (context.get('busy')) { msg.statusCode=409; msg.payload={busy:true}; return msg; }\ncontext.set('busy',true);\nconst held=Buffer.alloc(${loadBytes},1);const started=Date.now();const finish=started+${loadMs};let turns=0;\nfunction work(){ const slice=Math.min(finish,Date.now()+25);while(Date.now()<slice){turns+=held[turns%held.length];}if(Date.now()<finish){setTimeout(work,0);}else{context.set('busy',false);msg.payload={done:true,elapsedMs:Date.now()-started,heldBytes:held.length,turns};node.send(msg);node.done();}}\nwork();return;`, wires: [['load-response']] },
    { id: 'load-response', type: 'http response', z: tab.id, name: 'Load result', statusCode: '', headers: {}, wires: [] },
  ];
  return [tab,
    { id: 'tick', type: 'inject', z: tab.id, name: 'Collect every 500 ms', props: [{ p: 'payload' }], repeat: '0.5', once: true, onceDelay: 1, payload: '', payloadType: 'date', wires: [['sample']] },
    { id: 'sample', type: 'http request', z: tab.id, name: 'Read actual protocol fixture', method: 'GET', ret: 'obj', paytoqs: 'ignore', url: `${fixtureUrl}/sample`, persist: false, headers: [], wires: [['calculate']] },
    { id: 'calculate', type: 'function', z: tab.id, name: 'raw × 0.1 + 1', outputs: 1, libs: [], initialize: '', finalize: '', timeout: 0,
      func: `const raw=Number(msg.payload.raw);if(!Number.isFinite(raw)){node.error('invalid sample');return;}const seq=(context.get('seq')||0)+1;context.set('seq',seq);msg.payload={source:'b',raw,value:raw*0.1+1,seq};msg.headers={'content-type':'application/json','x-fixture-key':${JSON.stringify(fixtureKey)}};return msg;`, wires: [['report']] },
    { id: 'report', type: 'http request', z: tab.id, name: 'Report to restricted fake Manager', method: 'POST', ret: 'obj', paytoqs: 'ignore', url: `${fixtureUrl}/ingest`, persist: false, headers: [], wires: [[]] },
    { id: 'business-in', type: 'tcp in', z: tab.id, name: 'Published business listener', server: 'server', host: '', port: '18081', datamode: 'stream', datatype: 'buffer', newline: '', topic: '', trim: false, base64: false, tls: '', wires: [['business-reply']] },
    { id: 'business-reply', type: 'function', z: tab.id, name: 'Identify own fixture', func: "msg.payload=Buffer.from('ISOLATION_FIXTURE_B');return msg;", outputs: 1, libs: [], wires: [['business-out']] },
    { id: 'business-out', type: 'tcp out', z: tab.id, name: 'Reply on same connection', host: '', port: '', beserver: 'reply', base64: false, end: true, tls: '', wires: [] },
  ];
}

async function execJson(raw, containerId, source, timeoutMs = 20000) {
  const execution = await raw.getContainer(containerId).exec({ Cmd: ['node', '-e', source], AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true });
  const stdout = new PassThrough(), stderr = new PassThrough();
  raw.modem.demuxStream(stream, stdout, stderr);
  let output = '', errorOutput = '', size = 0;
  const collect = (target) => (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) { stream.destroy(); return; }
    if (target === 'out') output += chunk; else errorOutput += chunk;
  };
  stdout.on('data', collect('out')); stderr.on('data', collect('err'));
  await new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => { stream.destroy(); reject(new Error('temporary fixture execution timed out')); }, timeoutMs);
    stream.once('end', () => { clearTimeout(timer); resolveDone(); });
    stream.once('error', () => { clearTimeout(timer); reject(new Error('temporary fixture execution failed')); });
  });
  const result = await execution.inspect();
  if (size > 256 * 1024 || result.ExitCode !== 0 || errorOutput) throw new Error('temporary fixture execution did not return a clean result');
  try { return JSON.parse(output.trim()); } catch { throw new Error('temporary fixture result was not JSON'); }
}

const sleep = (ms) => new Promise((resolveDone) => setTimeout(resolveDone, ms));
const smallHttpScript = (url, method = 'GET', body) => `(async()=>{const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body === undefined ? '' : `body:${JSON.stringify(JSON.stringify(body))},`}signal:AbortSignal.timeout(15000)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value={};}console.log(JSON.stringify({status:r.status,value}));})().catch(()=>{console.log(JSON.stringify({status:0,error:'UNREACHABLE'}));});`;
const tcpProbeScript = (host, port) => `const net=require('node:net');let done=false;const s=net.connect({host:${JSON.stringify(host)},port:${port}});const finish=v=>{if(done)return;done=true;s.destroy();console.log(JSON.stringify(v));};s.setTimeout(1500);s.once('connect',()=>finish({connected:true}));s.once('error',e=>finish({connected:false,error:e.code}));s.once('timeout',()=>finish({connected:false,error:'ETIMEDOUT'}));`;

export function runtimeProbeScript({ invocation, siblingPath, siblingId }) {
  return `const fs=require('node:fs');const status=fs.readFileSync('/proc/self/status','utf8');const get=k=>(status.match(new RegExp('^'+k+':\\\\s*(.+)$','m'))||[])[1]?.trim();const writable=p=>{try{fs.accessSync(p,fs.constants.W_OK);return true;}catch{return false;}};let denied=false;const own='/etc/tle-isolation-${invocation}';try{fs.writeFileSync(own,'fixture');fs.unlinkSync(own);}catch(e){denied=['EACCES','EROFS','EPERM'].includes(e.code);}let sibling=false;for(const p of [${JSON.stringify(siblingPath)},${JSON.stringify(`/data/../${siblingId}/isolation-sentinel`)}]){try{fs.readFileSync(p);sibling=true;}catch{}}console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),capEff:get('CapEff'),noNewPrivs:get('NoNewPrivs'),shadowExists:fs.existsSync('/etc/shadow'),shadowWritable:writable('/etc/shadow'),rootWriteDenied:denied,dockerSocketExists:fs.existsSync('/var/run/docker.sock')||fs.existsSync('/run/docker.sock'),siblingReadable:sibling,ownSentinelReadable:fs.readFileSync('/data/isolation-sentinel','utf8').startsWith('sentinel:')}));`;
}

async function hostTcpProbe(host, port) {
  return new Promise(resolveResult => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = value => { if (done) return; done = true; socket.destroy(); resolveResult(value); };
    socket.setTimeout(1500);
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', error => finish({ connected: false, error: error.code }));
    socket.once('timeout', () => finish({ connected: false, error: 'ETIMEDOUT' }));
  });
}

async function inspectOrAbsent(raw, kind, id) {
  try { return await (kind === 'container' ? raw.getContainer(id) : raw.getNetwork(id)).inspect(); }
  catch (error) { if (error?.statusCode === 404) return undefined; throw error; }
}
async function inventory(raw) {
  const [containers, networks] = await Promise.all([raw.listContainers({ all: true }), raw.listNetworks()]);
  const states = await Promise.all(containers.map(async container => {
    const info = await raw.getContainer(container.Id).inspect();
    return { id: container.Id, names: container.Names, state: container.State, startedAt: info.State.StartedAt, restartCount: info.RestartCount };
  }));
  return { containers: states.sort((a,b) => a.id.localeCompare(b.id)),
    networks: networks.map(n => ({ id: n.Id, name: n.Name })).sort((a,b) => a.id.localeCompare(b.id)) };
}

/** Recover only pre-recorded, initially absent random resources after an ambiguous write. */
export async function recoverUncertainResources(planned, ledger, inspect, capture, inventoryBefore) {
  const recovered = [], failures = [];
  for (const plan of planned) {
    if (ledger.some(item => item.kind === plan.kind && item.name === plan.name)) continue;
    try {
      const info = await inspect(plan.kind, plan.name);
      if (!info) continue;
      const before = plan.kind === 'container' ? inventoryBefore?.containers : inventoryBefore?.networks;
      assert.ok(before && !before.some(item => item.id === info.Id), 'pre-existing resource cannot be recovered as task ownership');
      assertExactDockerResource(info, { ...plan, id: info.Id });
      await capture(plan.kind, plan.name, plan.labels, info.Id);
      recovered.push({ kind: plan.kind, id: info.Id, name: plan.name });
    } catch (error) { failures.push({ kind: plan.kind, name: plan.name, removed: false, error: error.message }); }
  }
  return { recovered, failures };
}

export async function runIsolation(options, raw = new Docker()) {
  const identity = createFixtureIdentity({ suite: 'isoaccept', roles: ['a', 'b', 'server'] });
  const report = { invocation: identity.invocation, startedAt: new Date().toISOString(), checks: [], boundaries: [], resources: [], cleanup: [], unverified: [] };
  const ledger = [], directories = [], planned = [];
  const checkpoint = async () => {
    await mkdir(dirname(options.report), { recursive: true });
    await writeFile(options.report, JSON.stringify({ ...report, finishedAt: null, ok: false }, null, 2), { mode: 0o600 });
  };
  let manager;
  const record = (name, status, detail = {}) => {
    assert.ok(['pass', 'fail', 'unverified'].includes(status), 'acceptance status must be explicit');
    report.checks.push({ name, status, detail }); console.log(`${status}: ${name}`);
  };
  const policy = async (method, path, body) => {
    assertTemporaryManager(await raw.getContainer(options.managerContainer).inspect(), options);
    return execJson(raw, options.managerContainer, smallHttpScript(`${options.policyUrl.replace(/\/$/, '')}${path}`, method, body));
  };
  const capture = async (kind, name, labels, id) => {
    assert.match(id ?? '', /^[a-f0-9]{64}$/);
    const expected = { kind, name, labels, id };
    ledger.push(expected); report.resources.push({ kind, name, id });
    await checkpoint();
    assertExactDockerResource(await inspectOrAbsent(raw, kind, id), expected);
    assertExactDockerResource(await inspectOrAbsent(raw, kind, name), expected);
    return expected;
  };
  const createDirectory = async (id) => {
    const path = join(options.dataRoot, id), marker = JSON.stringify({ invocation: identity.invocation, id });
    await mkdir(path, { mode: 0o777 });
    const stat = await lstat(path);
    directories.push({ path, marker, dev: stat.dev, ino: stat.ino });
    await writeFile(join(path, '.isolation-owner'), marker, { flag: 'wx', mode: 0o600 });
    await chmod(path, 0o777);
    await writeFile(join(path, 'isolation-sentinel'), `sentinel:${identity.invocation}:${id}`, { flag: 'wx', mode: 0o644 });
    return path;
  };
  try {
    report.before = await inventory(raw);
    manager = assertTemporaryManager(await raw.getContainer(options.managerContainer).inspect(), options);
    report.manager = { id: manager.Id, name: manager.Name, imageId: manager.Image, startedAt: manager.State.StartedAt, restartCount: manager.RestartCount };
    const rootStat = await lstat(options.dataRoot);
    assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
    assert.equal(await realpath(options.dataRoot), options.dataRoot);
    const image = await raw.getImage(options.nodeRedImage).inspect();
    report.nodeRedImage = { id: image.Id, architecture: image.Architecture };
    report.provisioningSource = { buildDir: options.buildDir, hashes: {} };
    for (const file of ['core/instance/container-spec.js', 'core/instance/container-isolation.js', 'core/instance/settings-template.js']) {
      report.provisioningSource.hashes[file] = createHash('sha256').update(await readFile(join(options.buildDir, file))).digest('hex');
    }
    const { buildCreateOptions, assertSafeCreateOptions, containerName } = await import(pathToFileURL(join(options.buildDir, 'core/instance/container-spec.js')).href);
    const { renderSettings } = await import(pathToFileURL(join(options.buildDir, 'core/instance/settings-template.js')).href);
    const imageSplit = options.nodeRedImage.lastIndexOf(':');
    if (imageSplit < 1 || options.nodeRedImage.includes('@')) throw new Error('node-red-image requires a local repository:tag');
    const imageRepo = options.nodeRedImage.slice(0, imageSplit), imageTag = options.nodeRedImage.slice(imageSplit + 1);
    const networks = {};
    for (const role of ['a', 'b']) {
      const id = identity.instances[role], name = `${options.networkPrefix}-${id}`, labels = { [MANAGED]: 'true', [INSTANCE]: id, [TX]: identity.invocation };
      assert.equal(await inspectOrAbsent(raw, 'network', name), undefined);
      planned.push({ kind: 'network', name, labels });
      const result = await policy('POST', '/networks/create', { Name: name, Driver: 'bridge', Labels: labels });
      if (result.status !== 201) throw new Error(`policy network creation failed: HTTP ${result.status}`);
      networks[role] = await capture('network', name, labels, result.value.Id);
      const managerName = manager.Name.slice(1);
      const linked = await policy('POST', `/networks/${networks[role].id}/connect`, { Container: manager.Id, EndpointConfig: { Aliases: [managerName], GwPriority: -1 } });
      if (linked.status !== 200) throw new Error(`policy Manager network attachment failed: HTTP ${linked.status}`);
    }
    const fixtureKey = randomBytes(24).toString('hex'), serverName = `tle-${identity.instances.server}`;
    assert.equal(await inspectOrAbsent(raw, 'container', serverName), undefined);
    const serverSource = `const http=require('node:http');let count=0,invalid=0,last=null;const key=${JSON.stringify(fixtureKey)};http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/sample'){res.end(JSON.stringify({raw:250}));return;}if(req.headers['x-fixture-key']!==key){res.writeHead(401);res.end('{}');return;}if(req.url==='/state'){res.end(JSON.stringify({count,invalid,last}));return;}if(req.url==='/ingest'&&req.method==='POST'){let data='';for await(const chunk of req){data+=chunk;if(data.length>4096){res.writeHead(413);res.end('{}');return;}}try{const value=JSON.parse(data);if(value.raw!==250||value.value!==26||value.source!=='b')throw Error();count++;last=value;}catch{invalid++;}res.end('{}');return;}res.writeHead(404);res.end('{}');}).listen(1881,'0.0.0.0');`;
    const serverLabels = { [FIXTURE]: identity.invocation };
    planned.push({ kind: 'container', name: serverName, labels: serverLabels });
    const createdServer = await raw.createContainer({ name: serverName, Image: image.Id, User: '1000:1000', Entrypoint: ['node', '-e', serverSource], Cmd: [], Labels: serverLabels,
      ExposedPorts: { '1881/tcp': {} }, HostConfig: { NetworkMode: networks.b.id, Memory: 64 * 1024 ** 2, MemorySwap: 64 * 1024 ** 2, NanoCpus: 100_000_000,
        PidsLimit: 64, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
        PortBindings: { '1881/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } } } });
    const server = await capture('container', serverName, serverLabels, createdServer.id);
    await raw.getContainer(server.id).start();
    const serverInfo = await raw.getContainer(server.id).inspect();
    const serverPort = Number(serverInfo.NetworkSettings.Ports['1881/tcp'][0].HostPort);
    const state = async () => {
      const response = await fetch(`http://127.0.0.1:${serverPort}/state`, { headers: { 'x-fixture-key': fixtureKey }, signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200); return response.json();
    };
    const reserved = new Set();
    const { allocateMappedPortInRange } = await import('./_real-instance-fixture.mjs');
    const businessPort = await allocateMappedPortInRange(reserved, { nextCandidate: () => randomInt(options.portRange.min, options.portRange.max + 1) });
    const containers = {}, specifications = {};
    for (const role of ['a', 'b']) {
      const id = identity.instances[role], adminRoot = `/red/${id}/`, path = await createDirectory(id);
      const settings = renderSettings({ instanceId: id, adminRoot, credentialSecret: randomBytes(24).toString('hex'), credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync(randomBytes(24).toString('hex'), 8), permissions: '*' }] });
      await writeFile(join(path, 'settings.js'), settings, { flag: 'wx', mode: 0o644 });
      await writeFile(join(path, 'flows.json'), JSON.stringify(buildIsolationFlows({ role, adminRoot, fixtureUrl: `http://${serverName}:1881`, fixtureKey, loadMs: options.loadMs, loadBytes: options.loadBytes })), { flag: 'wx', mode: 0o644 });
      const spec = buildCreateOptions({ id, imageTag, memoryMb: role === 'a' ? 128 : 256, cpus: role === 'a' ? 0.2 : 0.3, ports: role === 'b'
        ? [{ hostPort: businessPort, containerPort: 18081, protocol: 'tcp', hostIp: '127.0.0.1' }] : [], adminRoot },
      { network: networks[role].id, imageRepo, instanceDataRoot: options.dataRoot, timezone: 'UTC', bootstrapTxId: identity.invocation });
      assertSafeCreateOptions(spec, { instanceDataRoot: options.dataRoot, expectedNetwork: networks[role].id, portRange: options.portRange });
      specifications[role] = spec;
      assert.equal(await inspectOrAbsent(raw, 'container', containerName(id)), undefined);
      const { name, ...body } = spec;
      planned.push({ kind: 'container', name, labels: spec.Labels });
      const result = await policy('POST', `/containers/create?name=${name}`, body);
      if (result.status !== 201) throw new Error(`policy instance ${role} creation failed: HTTP ${result.status}`);
      containers[role] = await capture('container', name, spec.Labels, result.value.Id);
      const started = await policy('POST', `/containers/${containers[role].id}/start`);
      if (started.status !== 204) throw new Error(`policy instance ${role} start failed: HTTP ${started.status}`);
    }
    for (const role of ['a', 'b']) {
      let ready = false;
      for (let i = 0; i < 90; i++) {
        const info = await raw.getContainer(containers[role].id).inspect();
        if (!info.State.Running) throw new Error(`Node-RED ${role} stopped during startup`);
        const logs = await raw.getContainer(containers[role].id).logs({ stdout: true, stderr: true, tail: 100 });
        if (logs.toString().includes('Started flows')) { ready = true; break; }
        await sleep(1000);
      }
      record(`Node-RED ${role} genuine runtime ready`, ready ? 'pass' : 'fail');
      if (!ready) throw new Error(`Node-RED ${role} startup deadline exceeded`);
    }
    const a = await raw.getContainer(containers.a.id).inspect(), b = await raw.getContainer(containers.b.id).inspect();
    for (const [role, info] of [['a', a], ['b', b]]) {
      const h = info.HostConfig;
      const ok = info.Config.User === '1000:1000' && h.ReadonlyRootfs === true && h.Privileged === false
        && JSON.stringify(h.CapDrop) === JSON.stringify(['ALL']) && h.SecurityOpt.includes('no-new-privileges:true')
        && h.Memory === (role === 'a' ? 128 : 256) * 1024 ** 2 && h.MemorySwap === h.Memory && h.NanoCpus === (role === 'a' ? 200_000_000 : 300_000_000)
        && info.Mounts.length === 1 && info.Mounts[0].Source === join(options.dataRoot, identity.instances[role]) && info.Mounts[0].Destination === '/data';
      record(`${role} immutable create contract and private data mount`, ok ? 'pass' : 'fail');
    }
    const siblingPath = join(options.dataRoot, identity.instances.b, 'isolation-sentinel');
    const runtime = await execJson(raw, a.Id, runtimeProbeScript({ invocation: identity.invocation, siblingPath, siblingId: identity.instances.b }));
    record('actual process cannot modify system accounts or read sibling data', assessRuntimeProbe(runtime) ? 'pass' : 'fail', runtime);
    const bIp = b.NetworkSettings.Networks[networks.b.name].IPAddress;
    const managerToB = await execJson(raw, manager.Id, tcpProbeScript(bIp, 1880));
    const businessPositive = await hostTcpProbe('127.0.0.1', businessPort);
    await state();
    record('positive controls confirm B editor and published fixture endpoints are actually listening', managerToB.connected === true && businessPositive.connected === true ? 'pass' : 'fail');
    const probes = [
      ['A to B private editor 1880', bIp, 1880],
      ['A to B published business port', 'host.docker.internal', businessPort],
      ['A to host published fixture service', 'host.docker.internal', serverPort],
    ];
    for (const [name, host, port] of probes) {
      const result = await execJson(raw, a.Id, tcpProbeScript(host, port));
      const status = assessNetworkProbe(result);
      record(name, status, result);
      if (status !== 'pass') report.boundaries.push({ name, status, detail: 'Separate bridge networks alone do not prove host/published-service isolation.' });
    }
    const managerAccess = await execJson(raw, a.Id, smallHttpScript(`${options.managerUrl.replace(/\/$/, '')}/api/me`));
    record('A cannot use Manager management API without a login', [401,403].includes(managerAccess.status) ? 'pass' : 'fail', { status: managerAccess.status });
    const policyUrl = new URL(options.policyUrl);
    const policyAddress = await execJson(raw, manager.Id, `require('node:dns').promises.lookup(${JSON.stringify(policyUrl.hostname)},{family:4}).then(v=>console.log(JSON.stringify({address:v.address}))).catch(()=>console.log(JSON.stringify({error:'DNS_FAILURE'})));`);
    if (!policyAddress.address) throw new Error('policy peer isolation has no positive DNS control');
    const aPolicyTcp = await execJson(raw, a.Id, tcpProbeScript(policyAddress.address, Number(policyUrl.port || 2375)));
    let peerStatus;
    if (aPolicyTcp.connected) {
      const reply = await execJson(raw, a.Id, smallHttpScript(`http://${policyAddress.address}:${policyUrl.port || 2375}/version`));
      peerStatus = reply.status;
    }
    record('A cannot directly invoke Docker policy', aPolicyTcp.connected ? (peerStatus === 403 ? 'pass' : 'fail') : assessNetworkProbe(aPolicyTcp), { tcp: aPolicyTcp, httpStatus: peerStatus });
    const beforeUnsafe = await inventory(raw);
    for (const [name, change] of [['root user', body => { body.User = '0:0'; }], ['privileged', body => { body.HostConfig.Privileged = true; }], ['host filesystem', body => { body.HostConfig.Binds = ['/:/data']; }], ['host namespace', body => { body.HostConfig.PidMode = 'host'; }]]) {
      const body = structuredClone(specifications.a); delete body.name; change(body);
      const result = await policy('POST', `/containers/create?name=${specifications.a.name}`, body);
      record(`independent Docker policy refuses ${name}`, result.status === 403 ? 'pass' : 'fail', { status: result.status });
    }
    const afterUnsafe = await inventory(raw);
    record('unsafe Docker requests caused no daemon resource mutation', JSON.stringify(beforeUnsafe) === JSON.stringify(afterUnsafe) ? 'pass' : 'fail');
    let initial;
    for (let i = 0; i < 30; i++) { initial = await state(); if (initial.count >= 4) break; await sleep(500); }
    record('B collects raw 250, calculates 26 and reports with accepted fixture identity', initial.count >= 4 && initial.invalid === 0 && initial.last?.value === 26 ? 'pass' : 'fail', initial);
    const beforeLoad = await raw.getContainer(a.Id).stats({ stream: false });
    const beforeCount = (await state()).count;
    const aIp = a.NetworkSettings.Networks[networks.a.name].IPAddress;
    const load = await execJson(raw, manager.Id, smallHttpScript(`http://${aIp}:1880/red/${identity.instances.a}/api/verify/load`, 'POST', {}), options.loadMs + 15000);
    const afterLoad = await raw.getContainer(a.Id).stats({ stream: false });
    const final = await state();
    record('A completes bounded in-process CPU/memory load', load.status === 200 && load.value.done === true && load.value.heldBytes === options.loadBytes ? 'pass' : 'fail',
      { status: load.status, heldBytes: load.value?.heldBytes, elapsedMs: load.value?.elapsedMs, cgroupLimit: afterLoad.memory_stats?.limit,
        memoryBefore: beforeLoad.memory_stats?.usage, memoryAfter: afterLoad.memory_stats?.usage,
        throttledPeriodsBefore: beforeLoad.cpu_stats?.throttling_data?.throttled_periods, throttledPeriodsAfter: afterLoad.cpu_stats?.throttling_data?.throttled_periods });
    const afterB = await raw.getContainer(b.Id).inspect();
    record('B continues genuine collection and reporting while A is busy', final.count - beforeCount >= Math.max(1, Math.floor(options.loadMs / 2000))
      && final.invalid === 0 && afterB.State.Running && afterB.State.StartedAt === b.State.StartedAt && afterB.RestartCount === b.RestartCount ? 'pass' : 'fail',
    { reportsDuringLoad: final.count - beforeCount, invalidReports: final.invalid, sameStartTime: afterB.State.StartedAt === b.State.StartedAt });
    report.unverified.push('No physical PLC, OS exploit, hardware serial or real ThingLinks Cloud acceptance is implied by this isolated safety harness.');
  } catch (error) {
    report.error = error.message;
    record('acceptance execution completed', 'fail', { error: error.message });
  } finally {
    const recovery = await recoverUncertainResources(planned, ledger,
      (kind, name) => inspectOrAbsent(raw, kind, name), capture, report.before);
    report.recoveredAfterUncertainResponse = recovery.recovered;
    report.cleanup.push(...recovery.failures);
    for (const expected of [...ledger].reverse()) {
      try {
        const info = await inspectOrAbsent(raw, expected.kind, expected.id);
        if (!info) {
          assert.equal(await inspectOrAbsent(raw, expected.kind, expected.name), undefined);
          report.cleanup.push({ kind: expected.kind, id: expected.id, removed: true, alreadyAbsent: true });
          ledger.splice(ledger.indexOf(expected), 1);
          continue;
        }
        assertExactDockerResource(info, expected);
        assertExactDockerResource(await inspectOrAbsent(raw, expected.kind, expected.name), expected);
        if (expected.kind === 'network') {
          const endpoints = Object.keys(info.Containers ?? {});
          for (const endpoint of endpoints) {
            assert.equal(endpoint, options.managerContainer, 'foreign network endpoint must be preserved');
            assertTemporaryManager(await raw.getContainer(endpoint).inspect(), options);
            await raw.getNetwork(expected.id).disconnect({ Container: endpoint, Force: false });
          }
          await raw.getNetwork(expected.id).remove();
        } else await raw.getContainer(expected.id).remove({ force: true, v: false });
        assert.equal(await inspectOrAbsent(raw, expected.kind, expected.id), undefined);
        report.cleanup.push({ kind: expected.kind, id: expected.id, removed: true });
        ledger.splice(ledger.indexOf(expected), 1);
      } catch (error) { report.cleanup.push({ kind: expected.kind, id: expected.id, removed: false, error: error.message }); }
    }
    if (ledger.length === 0) for (const dir of directories) {
      try {
        const stat = await lstat(dir.path);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === dir.dev && stat.ino === dir.ino);
        assert.equal(await readFile(join(dir.path, '.isolation-owner'), 'utf8'), dir.marker);
        const quarantine = `${dir.path}.cleanup-${identity.invocation}`;
        const existing = await lstat(quarantine).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        assert.equal(existing, undefined, 'cleanup quarantine already exists');
        await rename(dir.path, quarantine);
        assert.equal(await readFile(join(quarantine, '.isolation-owner'), 'utf8'), dir.marker);
        await rm(quarantine, { recursive: true, force: false });
        report.cleanup.push({ kind: 'directory', path: dir.path, removed: true });
      } catch (error) { report.cleanup.push({ kind: 'directory', path: dir.path, removed: false, error: error.message }); }
    }
    if (manager) {
      try {
        const current = assertTemporaryManager(await raw.getContainer(options.managerContainer).inspect(), options);
        record('temporary Manager was not restarted or replaced', current.State.StartedAt === manager.State.StartedAt && current.RestartCount === manager.RestartCount ? 'pass' : 'fail');
      } catch { record('temporary Manager was not restarted or replaced', 'fail'); }
    }
    report.after = await inventory(raw).catch(() => undefined);
    if (report.before && report.after) record('pre-existing Docker resources remain present', report.before.containers.every(c => report.after.containers.some(a => a.id === c.id && a.state === c.state && a.startedAt === c.startedAt && a.restartCount === c.restartCount))
      && report.before.networks.every(n => report.after.networks.some(a => a.id === n.id)) ? 'pass' : 'fail');
    report.finishedAt = new Date().toISOString();
    report.ok = ledger.length === 0 && report.checks.length > 0 && report.checks.every(check => check.status === 'pass') && report.cleanup.every(item => item.removed);
    await mkdir(dirname(options.report), { recursive: true });
    await writeFile(options.report, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseIsolationArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else runIsolation(options).then(result => { console.log(`Report: ${options.report}`); process.exitCode = result.ok ? 0 : 1; }, error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
