#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const PHASES = new Set([
  'idle', 'preparing', 'checkpointed', 'staged', 'cutover', 'verifying',
  'pending_start_verification', 'rolling_back', 'committed', 'rolled_back',
  'rolled_back_dirty', 'manual_required',
]);
const BOUNDARIES = new Set([
  'after-phase-persist', 'after-container-create', 'after-settings-write',
  'after-live-backup', 'after-live-rename', 'after-same-image-rebuild',
]);
const ARTIFACTS = new Set([
  'settings', 'package-manifest', 'package-lock', 'node-config', 'module-config',
  'edge-module', 'common-module',
]);
const THROW_CODES = new Set([
  'VERIFY_BOOTSTRAP_THROW', 'VERIFY_SAME_IMAGE_THROW', 'VERIFY_SETTINGS_THROW',
  'VERIFY_STOPPED_THROW', 'VERIFY_ROLLBACK_THROW',
]);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert.deepEqual(actual, expected);
}

function plainRecord(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  assert.ok(proto === Object.prototype || proto === null, `${label} must be plain`);
  return value;
}

function validateEvent(raw) {
  const event = plainRecord(raw, 'barrier event');
  const keys = ['instanceId', 'txId', 'phase', 'boundary', 'sequence'];
  if (event.artifact !== undefined) keys.push('artifact');
  exactKeys(event, keys);
  assert.match(event.instanceId, SAFE_SEGMENT);
  assert.match(event.txId, SAFE_SEGMENT);
  assert.ok(PHASES.has(event.phase), `unknown barrier phase ${event.phase}`);
  assert.ok(BOUNDARIES.has(event.boundary), `unknown barrier boundary ${event.boundary}`);
  assert.ok(Number.isSafeInteger(event.sequence) && event.sequence >= 0, 'invalid barrier sequence');
  if (event.artifact !== undefined) assert.ok(ARTIFACTS.has(event.artifact), 'invalid barrier artifact');
  return Object.freeze({ ...event });
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurableJson(path, value, mode = 0o600) {
  const partial = `${path}.partial-${process.pid}`;
  const fd = openSync(partial, 'wx', mode);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
  syncDirectory(dirname(path));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VerifierBarrierError extends Error {
  constructor(code) {
    super(`platform verifier injected ${code}`);
    this.name = 'VerifierBarrierError';
    this.code = code;
  }
}

class FileBarrier {
  constructor(root) {
    assert.ok(root.startsWith('/private/tmp/') || root.startsWith('/tmp/'), 'control root must be temporary');
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  async reach(rawEvent) {
    const event = validateEvent(rawEvent);
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 20);
    const stem = `${String(event.sequence).padStart(3, '0')}-${digest}`;
    const ready = join(this.root, `${stem}.ready.json`);
    const release = join(this.root, `${stem}.release.json`);
    writeDurableJson(ready, { version: 1, event });

    const deadline = Date.now() + 180_000;
    while (!existsSync(release)) {
      if (Date.now() >= deadline) throw new VerifierBarrierError('VERIFY_ROLLBACK_THROW');
      await sleep(25);
    }
    const command = plainRecord(JSON.parse(readFileSync(release, 'utf8')), 'barrier release');
    const expectedKeys = command.action === 'throw'
      ? ['version', 'event', 'action', 'code']
      : ['version', 'event', 'action'];
    exactKeys(command, expectedKeys);
    assert.equal(command.version, 1);
    assert.deepEqual(validateEvent(command.event), event);
    assert.ok(command.action === 'continue' || command.action === 'throw', 'invalid barrier action');
    if (command.action === 'throw') {
      assert.ok(THROW_CODES.has(command.code), 'invalid verifier throw code');
      throw new VerifierBarrierError(command.code);
    }
  }
}

function secret(master, purpose, bytes = 32) {
  return createHmac('sha256', master).update(purpose).digest('base64url').slice(0, bytes);
}

function copyLegacyNodes(target, contract) {
  const source = '/app/nodes';
  mkdirSync(target, { recursive: true, mode: 0o770 });
  const actual = readdirSync(source).filter((name) => /^tl-.*\.(?:js|html)$/.test(name)).sort();
  const expected = Object.keys(contract.LEGACY_PLATFORM_FILES).sort();
  assert.deepEqual(actual, expected);
  for (const name of expected) {
    const bytes = readFileSync(join(source, name));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      contract.LEGACY_PLATFORM_FILES[name],
    );
    copyFileSync(join(source, name), join(target, name));
    chmodSync(join(target, name), 0o644);
  }
}

async function buildV12Fixtures() {
  const dataRoot = process.env.EDGE_DATA_ROOT ?? '';
  const master = process.env.MASTER_KEY ?? '';
  const specPath = process.env.VERIFY_FIXTURE_SPEC ?? '';
  const managerName = process.env.VERIFY_MANAGER_NAME ?? '';
  assert.ok(dataRoot.startsWith('/private/tmp/') || dataRoot.startsWith('/tmp/'));
  assert.ok(master.length >= 32 && managerName.length > 0 && specPath.length > 0);

  const [{ default: Database }, { migrate, openDb }, { deriveKey }, { InstanceRepo },
    { renderSettings }, { buildPolicy }, contract] = await Promise.all([
    import('/app/node_modules/better-sqlite3/lib/index.js'),
    import('/app/dist/core/db.js'),
    import('/app/dist/core/auth/crypto.js'),
    import('/app/dist/core/instance/repo.js'),
    import('/app/dist/core/instance/settings-template.js'),
    import('/app/dist/core/nodes/policy.js'),
    import('/app/dist/core/nodes/platform-contract.js'),
  ]);
  const bcrypt = (await import('/app/node_modules/bcryptjs/index.js')).default;
  const spec = plainRecord(JSON.parse(readFileSync(specPath, 'utf8')), 'fixture spec');
  exactKeys(spec, ['version', 'instances']);
  assert.equal(spec.version, 1);
  assert.ok(Array.isArray(spec.instances) && spec.instances.length > 0);

  const managerDir = join(dataRoot, 'manager');
  const instanceRoot = join(dataRoot, 'instances');
  mkdirSync(managerDir, { recursive: true, mode: 0o770 });
  mkdirSync(instanceRoot, { recursive: true, mode: 0o770 });
  const dbPath = join(managerDir, 'edge.db');
  assert.equal(existsSync(dbPath), false, 'fixture database already exists');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  assert.equal(migrate(db, 12), 12);
  const key = deriveKey(master, 'thinglinks-edge:instance-cred');

  for (const itemRaw of spec.instances) {
    const item = plainRecord(itemRaw, 'fixture instance');
    const itemKeys = ['id', 'running'];
    if (item.driftEnvironment !== undefined) itemKeys.push('driftEnvironment');
    exactKeys(item, itemKeys);
    assert.match(item.id, /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
    assert.equal(typeof item.running, 'boolean');
    if (item.driftEnvironment !== undefined) assert.equal(typeof item.driftEnvironment, 'boolean');

    const password = secret(master, `node-password:${item.id}`, 28);
    const ingestToken = secret(master, `ingest-token:${item.id}`, 32);
    const credSecret = secret(master, `credential-secret:${item.id}`, 28);
    const tempDb = openDb(':memory:');
    const tempRepo = new InstanceRepo(tempDb, key);
    tempRepo.create({
      id: item.id, name: `Verifier ${item.id}`, imageTag: '5.0.4-24-minimal',
      memLimit: 256, cpuLimit: 0.5, adminRoot: `/red/${item.id}/`,
      credSecret, notes: '', nodeRuntimeMode: 'legacy',
    }, [], [{ username: 'admin', password, permissions: '*' }]);
    tempRepo.setIngestToken(item.id, ingestToken);
    const encrypted = tempDb.prepare(
      'SELECT ingest_token_enc FROM instance WHERE id = ?',
    ).get(item.id);
    const credential = tempDb.prepare(
      'SELECT pwd_enc FROM instance_cred WHERE instance_id = ? AND username = ?',
    ).get(item.id, 'admin');
    assert.ok(encrypted?.ingest_token_enc && credential?.pwd_enc);

    db.prepare(
      `INSERT INTO instance
       (id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret,notes,created_by,ingest_token_enc)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      item.id, `Verifier ${item.id}`, '5.0.4-24-minimal', 256, 0.5,
      `/red/${item.id}/`, credSecret, '', 'verifier', encrypted.ingest_token_enc,
    );
    db.prepare(
      `INSERT INTO instance_cred (instance_id,username,pwd_enc,permissions)
       VALUES (?,?,?,?)`,
    ).run(item.id, 'admin', credential.pwd_enc, '*');
    tempDb.close();

    const root = join(instanceRoot, item.id);
    mkdirSync(root, { recursive: true, mode: 0o770 });
    copyLegacyNodes(join(root, 'nodes'), contract);
    const palette = buildPolicy([
      { module: contract.PLATFORM_NODE_PACKAGE.name, version: contract.PLATFORM_NODE_PACKAGE.version },
    ], { allowInstall: true, catalogueUrl: '/npm/-/catalogue.json', mode: 'allowlist' });
    writeFileSync(join(root, 'settings.js'), renderSettings({
      instanceId: item.id,
      nodeRuntimeMode: 'legacy',
      adminRoot: `/red/${item.id}/`,
      credentialSecret: credSecret,
      credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync(password, 8), permissions: '*' }],
      palette,
    }), { mode: 0o644 });
    writeFileSync(join(root, 'flows.json'), `${JSON.stringify([
      { id: `${item.id}-tab`, type: 'tab', label: item.id, disabled: false, info: '' },
      { id: `${item.id}-inject`, type: 'inject', z: `${item.id}-tab`, name: 'preserved',
        props: [{ p: 'payload' }], repeat: '', crontab: '', once: false, onceDelay: 0.1,
        topic: '', payload: 'preserved', payloadType: 'str', x: 120, y: 80, wires: [[]] },
    ], null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(root, 'flows_cred.json'), `${JSON.stringify({
      verifier: { opaque: secret(master, `flow-credential:${item.id}`, 24) },
    })}\n`, { mode: 0o600 });
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({
      name: `tle-${item.id}`, version: '1.0.0', private: true, dependencies: {},
    }, null, 2)}\n`, { mode: 0o644 });
    writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify({
      name: `tle-${item.id}`, version: '1.0.0', lockfileVersion: 3,
      requires: true, packages: { '': { name: `tle-${item.id}`, version: '1.0.0', dependencies: {} } },
    }, null, 2)}\n`, { mode: 0o644 });
    writeFileSync(join(root, '.config.nodes.json'), '{}\n', { mode: 0o600 });
    writeFileSync(join(root, '.config.modules.json'), '{}\n', { mode: 0o600 });
  }
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 12);
  db.close();
  process.stdout.write(`fixture-v12:${spec.instances.length}\n`);
}

async function renderHarnessSettings() {
  const dataRoot = process.env.EDGE_DATA_ROOT ?? '';
  const master = process.env.MASTER_KEY ?? '';
  const sourceId = process.env.VERIFY_SOURCE_INSTANCE ?? '';
  const targetRoot = process.env.VERIFY_HARNESS_ROOT ?? '';
  const allowEdge = process.env.VERIFY_ALLOW_EDGE === 'true';
  assert.ok((dataRoot.startsWith('/private/tmp/') || dataRoot.startsWith('/tmp/')) && master.length >= 32);
  assert.ok((targetRoot.startsWith('/private/tmp/') || targetRoot.startsWith('/tmp/')) && sourceId);
  const [{ openDb }, { deriveKey }, { InstanceRepo }, { renderSettings }, { buildPolicy }, contract] =
    await Promise.all([
      import('/app/dist/core/db.js'), import('/app/dist/core/auth/crypto.js'),
      import('/app/dist/core/instance/repo.js'), import('/app/dist/core/instance/settings-template.js'),
      import('/app/dist/core/nodes/policy.js'), import('/app/dist/core/nodes/platform-contract.js'),
    ]);
  const bcrypt = (await import('/app/node_modules/bcryptjs/index.js')).default;
  const db = openDb(join(dataRoot, 'manager', 'edge.db'));
  const repo = new InstanceRepo(db, deriveKey(master, 'thinglinks-edge:instance-cred'));
  const instance = repo.get(sourceId);
  assert.ok(instance, 'source instance missing');
  const harnessPassword = secret(master, `harness-password:${sourceId}`, 28);
  const credentials = [{
    username: 'admin', passwordHash: bcrypt.hashSync(harnessPassword, 8), permissions: '*',
  }];
  const palette = buildPolicy(allowEdge ? [{
    module: contract.PLATFORM_NODE_PACKAGE.name,
    version: contract.PLATFORM_NODE_PACKAGE.version,
  }] : [], { allowInstall: true, catalogueUrl: '/npm/-/catalogue.json', mode: 'allowlist' });
  writeFileSync(join(targetRoot, 'settings.js'), renderSettings({
    instanceId: sourceId, nodeRuntimeMode: 'npm', adminRoot: instance.adminRoot,
    credentialSecret: instance.credSecret, credentials, palette,
    // The acceptance flow ends in the built-in file node on this disposable clone only.
    excludeRiskyNodes: false,
  }), { mode: 0o644 });
  db.close();
  process.stdout.write(`harness-settings:${allowEdge ? 'allow' : 'deny'}\n`);
}

function dockerSocketRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: '/var/run/docker.sock', path,
      method: options.method ?? 'GET', headers: options.headers ?? {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 500,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    if (options.body) request.end(options.body); else request.end();
  });
}

function dockerApiPath(url) {
  return (url ?? '/').replace(/^\/v\d+(?:\.\d+)?(?=\/)/, '');
}

async function inspectDocker(kind, id) {
  const suffix = kind === 'containers' ? '/json' : '';
  const response = await dockerSocketRequest(`/${kind}/${encodeURIComponent(id)}${suffix}`);
  if (response.statusCode !== 200) return undefined;
  return JSON.parse(response.body.toString('utf8'));
}

async function ownedMutation(path, method, body, env) {
  if (method === 'POST' && path === '/containers/create') {
    const value = plainRecord(JSON.parse(body.toString('utf8')), 'container create');
    const labels = plainRecord(value.Labels ?? {}, 'container labels');
    assert.equal(labels[MANAGED_LABEL], 'true');
    assert.ok(String(labels[INSTANCE_LABEL] ?? '').startsWith(env.instancePrefix));
    assert.ok(value.Image === env.nodeImageId || value.Image === env.nodeImageRef);
    value.Labels = { ...labels, [RUN_LABEL]: env.runId };
    return Buffer.from(JSON.stringify(value));
  }
  if (method === 'POST' && path === '/networks/create') {
    const value = plainRecord(JSON.parse(body.toString('utf8')), 'network create');
    const labels = plainRecord(value.Labels ?? {}, 'network labels');
    assert.equal(labels[MANAGED_LABEL], 'true');
    assert.ok(String(labels[INSTANCE_LABEL] ?? '').startsWith(env.instancePrefix));
    value.Internal = true;
    value.Labels = { ...labels, [RUN_LABEL]: env.runId };
    const ordinal = env.networkCounter++;
    const third = Math.floor(ordinal / 16);
    const fourth = (ordinal % 16) * 16;
    assert.ok(third < 256, 'verifier subnet allocation exhausted');
    value.IPAM = {
      Driver: 'default',
      Config: [{ Subnet: `${env.subnetPrefix}.${third}.${fourth}/28` }],
    };
    return Buffer.from(JSON.stringify(value));
  }
  const containerMatch = /^\/containers\/([^/]+)\/(?:start|stop|restart|json|archive)$/.exec(path)
    ?? /^\/containers\/([^/]+)$/.exec(path);
  if (containerMatch && method !== 'GET') {
    const info = await inspectDocker('containers', decodeURIComponent(containerMatch[1]));
    assert.ok(info, 'mutated container missing');
    const labels = info.Config?.Labels ?? {};
    assert.ok(labels[RUN_LABEL] === env.runId || info.Name === `/${env.managerName}`);
    return body;
  }
  const networkMatch = /^\/networks\/([^/]+)(?:\/(?:connect|disconnect))?$/.exec(path);
  if (networkMatch && method !== 'GET') {
    const info = await inspectDocker('networks', decodeURIComponent(networkMatch[1]));
    assert.equal(info?.Labels?.[RUN_LABEL], env.runId);
    return body;
  }
  throw new Error(`Docker verifier proxy denied ${method} ${path}`);
}

async function runDockerProxy() {
  const env = {
    runId: process.env.VERIFY_RUN_ID ?? '',
    instancePrefix: process.env.VERIFY_INSTANCE_PREFIX ?? '',
    managerName: process.env.VERIFY_MANAGER_NAME ?? '',
    nodeImageId: process.env.VERIFY_NODE_IMAGE_ID ?? '',
    nodeImageRef: 'nodered/node-red:5.0.4-24-minimal',
    subnetPrefix: process.env.VERIFY_SUBNET_PREFIX ?? '',
    networkCounter: 0,
  };
  assert.match(env.runId, SAFE_SEGMENT);
  assert.match(env.instancePrefix, /^[a-z][a-z0-9-]+$/);
  assert.ok(env.managerName && /^sha256:[a-f0-9]{64}$/.test(env.nodeImageId));
  assert.match(env.subnetPrefix, /^10\.(?:2[0-4]\d|25[0-4])$/);

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      const path = dockerApiPath(req.url);
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        body = await ownedMutation(path.split('?')[0], method, body, env);
      }
      const headers = { ...req.headers, host: 'docker' };
      delete headers['content-length'];
      if (body.length > 0) headers['content-length'] = String(body.length);
      const upstream = await dockerSocketRequest(req.url ?? '/', { method, headers, body });
      res.writeHead(upstream.statusCode, upstream.headers);
      res.end(upstream.body);
    } catch (error) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `verifier proxy denied: ${error.message}` }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(2375, '0.0.0.0', resolve);
  });
  process.stdout.write('[verify-proxy] ready\n');
}

async function runRouteProxy() {
  const upstream = process.env.VERIFY_ROUTE_UPSTREAM ?? '';
  const logPath = process.env.VERIFY_ROUTE_LOG ?? '';
  assert.match(upstream, /^http:\/\/[A-Za-z0-9._-]+:\d+$/);
  assert.ok(logPath.startsWith('/private/tmp/') || logPath.startsWith('/tmp/'));
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o777 });
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      delete headers.host;
      const response = await fetch(`${upstream}${req.url ?? '/'}`, {
        method: req.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      const record = {
        method: req.method,
        path: req.url,
        body: body.length > 0 ? JSON.parse(body.toString('utf8')) : null,
        status: response.status,
      };
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const outHeaders = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, outHeaders);
      res.end(responseBody);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'verifier route proxy upstream failure' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3000, '0.0.0.0', resolve);
  });
  process.stdout.write('[verify-route-proxy] ready\n');
}

async function runSeedRegistry() {
  const managerName = process.env.VERIFY_MANAGER_NAME ?? '';
  assert.match(managerName, /^[A-Za-z0-9][A-Za-z0-9._-]+$/);
  const [{ NodeStore }, { seedFromDir }, { buildPackument }, contract] = await Promise.all([
    import('/app/dist/core/nodes/store.js'),
    import('/app/dist/core/nodes/seed.js'),
    import('/app/dist/core/nodes/packument.js'),
    import('/app/dist/core/nodes/platform-contract.js'),
  ]);
  const store = new NodeStore('/tmp/verifier-seed-registry');
  const seeded = seedFromDir(store, '/app/npm-seed');
  assert.equal(seeded.imported.length, 2);
  const allowed = new Set([
    contract.PLATFORM_NODE_PACKAGE.name,
    contract.PLATFORM_COMMON_PACKAGE.name,
  ]);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://registry');
      if (!url.pathname.startsWith('/npm/')) {
        res.writeHead(404).end();
        return;
      }
      const rest = decodeURIComponent(url.pathname.slice('/npm/'.length));
      const marker = rest.indexOf('/-/');
      const module = marker >= 0 ? rest.slice(0, marker) : rest.replace(/\/$/, '');
      if (!allowed.has(module)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      if (marker >= 0) {
        const body = store.tarball(module, '0.0.1');
        assert.ok(body);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
        return;
      }
      const packument = buildPackument(
        store, module, `http://${managerName}:19100/npm/`,
      );
      assert.ok(packument);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(packument));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"seed registry failure"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(19100, '0.0.0.0', resolve);
  });
  process.stdout.write('[verify-seed-registry] ready\n');
}

async function runManager() {
  const controlRoot = process.env.VERIFY_CONTROL_DIR ?? '';
  assert.ok(controlRoot);
  const { main } = await import('/app/dist/index.js');
  await main({ barrier: new FileBarrier(controlRoot) });
}

async function main() {
  const mode = process.argv[2] ?? '';
  if (mode === 'manager') return runManager();
  if (mode === 'fixture-v12') return buildV12Fixtures();
  if (mode === 'render-harness-settings') return renderHarnessSettings();
  if (mode === 'docker-proxy') return runDockerProxy();
  if (mode === 'route-proxy') return runRouteProxy();
  if (mode === 'seed-registry') return runSeedRegistry();
  throw new Error(`unknown verifier entry mode: ${mode || '<missing>'}`);
}

main().catch((error) => {
  process.stderr.write(`[verify-entry] ${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
