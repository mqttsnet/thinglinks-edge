#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const BOOTSTRAP_TX_LABEL = 'com.mqttsnet.thinglinks-edge.bootstrap-tx';
const MIGRATION_TX_LABEL = 'com.mqttsnet.thinglinks-edge.migration-tx';
const MIGRATION_PROBE_LABEL = 'com.mqttsnet.thinglinks-edge.migration-probe';
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
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `untrusted directory ${path}`);
  const fd = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function trustedDirectory(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `untrusted directory ${path}`);
  return realpathSync(path);
}

function trustedFile(path, root, maxBytes = 2 * 1024 * 1024) {
  const actualRoot = trustedDirectory(root);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    `untrusted file ${path}`);
  const actual = realpathSync(path);
  assert.ok(contained(actualRoot, actual), `file escapes root ${path}`);
  const fd = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino,
      `file changed ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendTrustedFile(path, root, bytes) {
  trustedFile(path, root);
  const fd = openSync(path,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile(), `append target changed ${path}`);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurableJson(path, value, mode = 0o600) {
  trustedDirectory(dirname(path));
  const partial = `${path}.partial-${process.pid}`;
  const fd = openSync(partial,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL
      | FS_CONSTANTS.O_NOFOLLOW,
    mode);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
  syncDirectory(dirname(path));
}

function replaceTrustedFile(path, root, bytes, mode = 0o600) {
  const actualRoot = trustedDirectory(root);
  const parent = trustedDirectory(dirname(path));
  assert.ok(contained(actualRoot, parent), `write escapes root ${path}`);
  if (existsSync(path)) trustedFile(path, actualRoot);
  const partial = `${path}.partial-${process.pid}`;
  const fd = openSync(partial,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL
      | FS_CONSTANTS.O_NOFOLLOW,
    mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
  chmodSync(path, mode);
  syncDirectory(parent);
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
    chmodSync(root, 0o700);
    this.root = trustedDirectory(root);
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
    const command = plainRecord(JSON.parse(trustedFile(release, this.root, 16 * 1024)
      .toString('utf8')), 'barrier release');
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
  const spec = plainRecord(JSON.parse(trustedFile(specPath, dirname(specPath), 1024 * 1024)
    .toString('utf8')), 'fixture spec');
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
  trustedDirectory(targetRoot);
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
  replaceTrustedFile(join(targetRoot, 'settings.js'), targetRoot, renderSettings({
    instanceId: sourceId, nodeRuntimeMode: 'npm', adminRoot: instance.adminRoot,
    credentialSecret: instance.credSecret, credentials, palette,
    // The acceptance flow ends in the built-in file node on this disposable clone only.
    excludeRiskyNodes: false,
  }), 0o640);
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

export class ProxyPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyPolicyError';
  }
}

function policy(condition, message) {
  if (!condition) throw new ProxyPolicyError(message);
}

function policyRecord(value, label) {
  policy(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} object`);
  const proto = Object.getPrototypeOf(value);
  policy(proto === Object.prototype || proto === null, `${label} plain object`);
  return value;
}

function policyKeys(value, required, optional = []) {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  policy(required.every((key) => keys.includes(key)), 'required field missing');
  policy(keys.every((key) => allowed.has(key)), 'unknown field');
}

function policyJson(body, label, maxBytes) {
  policy(Buffer.isBuffer(body) && body.length > 0 && body.length <= maxBytes, `${label} size`);
  try {
    return policyRecord(JSON.parse(body.toString('utf8')), label);
  } catch (error) {
    if (error instanceof ProxyPolicyError) throw error;
    throw new ProxyPolicyError(`${label} JSON`);
  }
}

const RESOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const INSTANCE_ID = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const DOCKER_ID = /^[a-f0-9]{64}$/;

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function probeName(instanceId, txId) {
  return `tle-nr-migrate-${instanceId}-${shortHash(txId)}`;
}

function parseProxyUrl(raw) {
  policy(typeof raw === 'string' && raw.startsWith('/') && !raw.includes('#'), 'request target');
  const queryAt = raw.indexOf('?');
  const rawPath = queryAt < 0 ? raw : raw.slice(0, queryAt);
  policy(!rawPath.includes('%') && !rawPath.includes('\\') && !rawPath.includes('//'), 'encoded path');
  policy(!rawPath.split('/').some((part) => part === '.' || part === '..'), 'dot path');
  const matched = /^(?:\/v[0-9]+\.[0-9]+)?(\/.*)$/.exec(rawPath);
  policy(Boolean(matched), 'Docker API version/path');
  const url = new URL(raw, 'http://docker.invalid');
  return { path: matched[1], search: url.searchParams, raw };
}

function proxyDiagnosticTarget(raw) {
  const value = typeof raw === 'string' ? raw : '';
  const queryAt = value.indexOf('?');
  const path = queryAt < 0 ? value : value.slice(0, queryAt);
  if (!/^\/[A-Za-z0-9_./:-]{1,256}$/.test(path)) return '[invalid-target]';
  if (queryAt < 0) return path;
  try {
    const keys = [...new URL(value, 'http://docker.invalid').searchParams.keys()];
    if (!keys.every((key) => /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key))) return `${path}?[invalid-query]`;
    return `${path}?${[...new Set(keys)].sort().join('&')}`;
  } catch {
    return `${path}?[invalid-query]`;
  }
}

function exactQuery(search, rules = {}) {
  const seen = new Set();
  for (const [key, value] of search) {
    policy(!seen.has(key) && Object.hasOwn(rules, key), 'query key');
    seen.add(key);
    policy(rules[key](value), `query value ${key}`);
  }
  policy(Object.entries(rules).every(([key, validate]) => (
    validate.optional === true || seen.has(key)
  )), 'query field missing');
}

function noQuery(search) {
  policy([...search].length === 0, 'query forbidden');
}

function sameStringRecord(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys)
    && leftKeys.every((key) => typeof left[key] === 'string' && left[key] === right[key]);
}

function validateMirroredNetworkQuery(search, body) {
  if ([...search].length === 0) return;
  const rules = {
    Name: (value) => value === body.Name,
    Driver: (value) => value === body.Driver,
    Labels: (value) => {
      try {
        return sameStringRecord(policyRecord(JSON.parse(value), 'query labels'), body.Labels);
      } catch {
        return false;
      }
    },
  };
  if (body.Internal !== undefined) rules.Internal = (value) => value === String(body.Internal);
  exactQuery(search, rules);
}

function validateMirroredContainerQuery(search, body) {
  const queryKeys = [...new Set(search.keys())].sort();
  if (JSON.stringify(queryKeys) === JSON.stringify(['name'])) {
    policy(search.getAll('name').length === 1 && search.get('name') === body.name,
      'container name query');
    return;
  }
  const bodyKeys = Object.keys(body).sort();
  policy(JSON.stringify(queryKeys) === JSON.stringify(bodyKeys), 'container query keys');
  for (const key of bodyKeys) {
    const expected = body[key];
    const actual = search.getAll(key);
    if (Array.isArray(expected)) {
      policy(JSON.stringify(actual) === JSON.stringify(expected.map(String)),
        `container query mirror ${key}`);
    } else {
      const encoded = expected !== null && typeof expected === 'object'
        ? JSON.stringify(expected) : String(expected);
      policy(actual.length === 1 && actual[0] === encoded, `container query mirror ${key}`);
    }
  }
}

function validInstance(instanceId, env) {
  return typeof instanceId === 'string'
    && INSTANCE_ID.test(instanceId)
    && instanceId.startsWith(`${env.instancePrefix}-`);
}

function labelShape(labels, env, expected = {}) {
  const required = { [MANAGED_LABEL]: 'true', ...expected };
  const keys = Object.keys(labels);
  policy(Object.entries(required).every(([key, value]) => labels[key] === value), 'ownership labels');
  policy(keys.every((key) => Object.hasOwn(required, key)), 'unexpected label');
  policy(validInstance(labels[INSTANCE_LABEL], env), 'instance label');
  return labels[INSTANCE_LABEL];
}

function existingLabels(info) {
  return info?.Config?.Labels ?? info?.Labels ?? {};
}

function assertOwnedExisting(info, env, kind) {
  policy(Boolean(info), `${kind} missing`);
  const labels = existingLabels(info);
  policy(labels[RUN_LABEL] === env.runId, `${kind} run owner`);
  policy(labels[MANAGED_LABEL] === 'true' && validInstance(labels[INSTANCE_LABEL], env),
    `${kind} instance owner`);
  if (kind === 'network') policy(info.Internal === true, 'network must be internal');
  if (DOCKER_ID.test(info.Id ?? '')) {
    const remembered = kind === 'network' ? env.ownedNetworkIds : env.ownedContainerIds;
    remembered?.add(info.Id);
  }
  return labels;
}

function assertManager(info, env) {
  policy(Boolean(info), 'Manager missing');
  policy(info.Id && info.Name === `/${env.managerName}`, 'Manager identity');
  policy(info.Config?.Labels?.[RUN_LABEL] === env.runId, 'Manager run owner');
  return info.Id;
}

function canonicalAbsentContainerRef(ref, env) {
  const prefix = 'tle-nr-';
  return ref.startsWith(prefix) && validInstance(ref.slice(prefix.length), env);
}

function canonicalAbsentNetworkRef(ref, env) {
  const prefix = `${env.networkPrefix}-`;
  return ref.startsWith(prefix) && validInstance(ref.slice(prefix.length), env);
}

function canonicalProbeContainerRef(ref, env) {
  const match = /^tle-nr-migrate-(.+)-[a-f0-9]{8}$/.exec(ref);
  return Boolean(match && validInstance(match[1], env));
}

function canonicalProbeNetworkRef(ref, env) {
  const match = /^tle-nr-migrate-(.+)-[a-f0-9]{8}-net$/.exec(ref);
  return Boolean(match && validInstance(match[1], env));
}

function allowedContainerLookup(ref, env, includeManager = false) {
  return (includeManager && ref === env.managerName)
    || canonicalAbsentContainerRef(ref, env)
    || canonicalProbeContainerRef(ref, env)
    || (DOCKER_ID.test(ref) && env.ownedContainerIds.has(ref));
}

function allowedNetworkLookup(ref, env) {
  return canonicalAbsentNetworkRef(ref, env)
    || canonicalProbeNetworkRef(ref, env)
    || (DOCKER_ID.test(ref) && env.ownedNetworkIds.has(ref));
}

function parseLabelFilters(value, env) {
  let filters;
  try { filters = policyRecord(JSON.parse(value), 'filters'); } catch { throw new ProxyPolicyError('filters'); }
  policyKeys(filters, [], ['label', 'name']);
  policy(Object.keys(filters).length > 0, 'empty filters');
  for (const [key, entries] of Object.entries(filters)) {
    policy(Array.isArray(entries) && entries.length > 0 && entries.length <= 6, 'filter entries');
    if (key === 'label') {
      for (const entry of entries) {
        policy(typeof entry === 'string' && (
          entry === `${MANAGED_LABEL}=true`
          || entry === `${MIGRATION_PROBE_LABEL}=true`
          || entry.startsWith(`${INSTANCE_LABEL}=${env.instancePrefix}-`)
          || entry.startsWith(`${BOOTSTRAP_TX_LABEL}=`)
          || entry.startsWith(`${MIGRATION_TX_LABEL}=`)
        ), 'label filter');
      }
      policy(entries.includes(`${MANAGED_LABEL}=true`), 'managed filter required');
    } else {
      for (const entry of entries) {
        policy(typeof entry === 'string' && (
          entry.startsWith(`${env.networkPrefix}-${env.instancePrefix}-`)
          || entry.startsWith(`tle-nr-migrate-${env.instancePrefix}-`)
        ), 'name filter');
      }
    }
  }
  return filters;
}

function runScopedListUrl(raw, filters, env, extras = {}) {
  const scoped = Object.fromEntries(Object.entries(filters).map(([key, entries]) => (
    [key, [...entries]]
  )));
  scoped.label = [...(scoped.label ?? []), `${RUN_LABEL}=${env.runId}`];
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) query.set(key, value);
  }
  query.set('filters', JSON.stringify(scoped));
  return `${String(raw).split('?', 1)[0]}?${query}`;
}

function parseCreateIdentity(labels, name, env) {
  const probe = labels[MIGRATION_PROBE_LABEL] === 'true';
  if (probe) {
    const txId = labels[MIGRATION_TX_LABEL];
    policy(typeof txId === 'string' && TX_ID.test(txId), 'probe tx');
    const instanceId = labelShape(labels, env, {
      [INSTANCE_LABEL]: labels[INSTANCE_LABEL],
      [MIGRATION_TX_LABEL]: txId,
      [MIGRATION_PROBE_LABEL]: 'true',
    });
    policy(name === probeName(instanceId, txId), 'probe name');
    return { instanceId, txId, probe: true };
  }
  const bootstrapTx = labels[BOOTSTRAP_TX_LABEL];
  if (bootstrapTx !== undefined) policy(typeof bootstrapTx === 'string' && TX_ID.test(bootstrapTx), 'bootstrap tx');
  const expected = { [INSTANCE_LABEL]: labels[INSTANCE_LABEL] };
  if (bootstrapTx !== undefined) expected[BOOTSTRAP_TX_LABEL] = bootstrapTx;
  const instanceId = labelShape(labels, env, expected);
  policy(name === `tle-nr-${instanceId}`, 'container name');
  return { instanceId, txId: bootstrapTx, probe: false };
}

function validateEnvironment(entries, identity, env) {
  policy(Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'), 'environment');
  const values = new Map();
  for (const entry of entries) {
    const split = entry.indexOf('=');
    policy(split > 0 && !values.has(entry.slice(0, split)), 'environment duplicate');
    values.set(entry.slice(0, split), entry.slice(split + 1));
  }
  const names = [
    'TZ', 'TLE_INSTANCE_ID', 'TLE_ADMIN_ROOT', 'TLE_INGEST_TOKEN', 'TLE_MANAGER_URL',
    'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_STRICT_SSL', 'NPM_CONFIG_AUDIT',
    'NPM_CONFIG_FUND', 'NPM_CONFIG_UPDATE_NOTIFIER',
  ];
  policy(values.size === names.length && names.every((name) => values.has(name)), 'environment keys');
  policy(values.get('TZ') === 'UTC', 'timezone');
  policy(values.get('TLE_INSTANCE_ID') === identity.instanceId, 'instance environment');
  policy(values.get('TLE_ADMIN_ROOT') === `/red/${identity.instanceId}/`, 'admin root');
  policy(/^[A-Za-z0-9_-]{24,128}$/.test(values.get('TLE_INGEST_TOKEN')), 'ingest token shape');
  policy(values.get('TLE_MANAGER_URL') === `http://${env.managerName}:19100`, 'Manager URL');
  policy(values.get('NPM_CONFIG_REGISTRY') === `http://${env.managerName}:19100/npm/`, 'registry URL');
  policy(values.get('NPM_CONFIG_STRICT_SSL') === 'false', 'strict SSL');
  for (const key of ['NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND', 'NPM_CONFIG_UPDATE_NOTIFIER']) {
    policy(values.get(key) === 'false', key);
  }
}

async function validateContainerCreate(body, name, env, adapters) {
  policyKeys(body, ['Image', 'User', 'Env', 'Labels', 'ExposedPorts', 'HostConfig'], ['name']);
  policy(body.Cmd === undefined && body.Entrypoint === undefined, 'custom command');
  policy(body.User === 'node-red', 'container user');
  const labels = policyRecord(body.Labels, 'container labels');
  const identity = parseCreateIdentity(labels, name, env);
  if (body.name !== undefined) policy(body.name === name, 'body/query name');
  policy(body.Image === env.nodeImageRef || body.Image === env.nodeImageId, 'container image');
  validateEnvironment(body.Env, identity, env);
  policy(Object.keys(policyRecord(body.ExposedPorts, 'exposed ports')).length === 0, 'ports exposed');
  const host = policyRecord(body.HostConfig, 'HostConfig');
  policyKeys(host, [
    'Memory', 'NanoCpus', 'PidsLimit', 'Binds', 'PortBindings', 'ReadonlyRootfs',
    'CapDrop', 'SecurityOpt', 'RestartPolicy', 'NetworkMode', 'Tmpfs',
  ]);
  policy(Number.isSafeInteger(host.Memory) && host.Memory >= 64 * 1024 * 1024
    && host.Memory <= 1024 * 1024 * 1024, 'memory bound');
  policy(Number.isSafeInteger(host.NanoCpus) && host.NanoCpus > 0 && host.NanoCpus <= 2e9,
    'CPU bound');
  policy(host.PidsLimit === 512, 'PID bound');
  policy(host.ReadonlyRootfs === true, 'read-only root');
  policy(JSON.stringify(host.CapDrop) === '["ALL"]', 'capabilities');
  policy(JSON.stringify(host.SecurityOpt) === '["no-new-privileges:true"]', 'security opt');
  policy(Object.keys(policyRecord(host.PortBindings, 'port bindings')).length === 0, 'host ports');
  policy(JSON.stringify(host.Tmpfs) === JSON.stringify({ '/tmp': 'rw,noexec,nosuid,size=64m' }),
    'tmpfs');
  const restart = policyRecord(host.RestartPolicy, 'restart policy');
  policyKeys(restart, ['Name']);
  policy(restart.Name === (identity.probe ? 'no' : 'unless-stopped'), 'restart policy name');
  const expectedRoot = identity.probe
    ? `${env.instanceDataRoot}/.thinglinks-probes/${identity.instanceId}/${identity.txId}`
    : `${env.instanceDataRoot}/${identity.instanceId}`;
  policy(JSON.stringify(host.Binds) === JSON.stringify([`${expectedRoot}:/data`]), 'data bind');
  policy(typeof host.NetworkMode === 'string' && RESOURCE_REF.test(host.NetworkMode), 'network mode');
  policy(allowedNetworkLookup(host.NetworkMode, env), 'network lookup scope');
  const network = await adapters.inspectNetwork(host.NetworkMode);
  const networkLabels = assertOwnedExisting(network, env, 'network');
  policy(networkLabels[INSTANCE_LABEL] === identity.instanceId, 'network instance');
  if (identity.probe) {
    policy(networkLabels[MIGRATION_TX_LABEL] === identity.txId
      && networkLabels[MIGRATION_PROBE_LABEL] === 'true', 'probe network tuple');
  } else if (identity.txId !== undefined) {
    policy(networkLabels[BOOTSTRAP_TX_LABEL] === identity.txId, 'bootstrap network tuple');
  }
  body.Image = env.nodeImageId;
  body.Labels = { ...labels, [RUN_LABEL]: env.runId };
  return Buffer.from(JSON.stringify(body));
}

function validateNetworkCreate(body, env) {
  policyKeys(body, ['Name', 'Driver', 'Labels'], ['Internal']);
  policy(body.Driver === 'bridge' && (body.Internal === undefined || body.Internal === true),
    'network shape');
  const labels = policyRecord(body.Labels, 'network labels');
  const probe = labels[MIGRATION_PROBE_LABEL] === 'true';
  let identity;
  if (probe) {
    const txId = labels[MIGRATION_TX_LABEL];
    policy(typeof txId === 'string' && TX_ID.test(txId), 'probe network tx');
    const instanceId = labelShape(labels, env, {
      [INSTANCE_LABEL]: labels[INSTANCE_LABEL], [MIGRATION_TX_LABEL]: txId,
      [MIGRATION_PROBE_LABEL]: 'true',
    });
    identity = { instanceId, txId, probe };
    policy(body.Name === `${probeName(instanceId, txId)}-net`, 'probe network name');
  } else {
    const txId = labels[BOOTSTRAP_TX_LABEL];
    if (txId !== undefined) policy(typeof txId === 'string' && TX_ID.test(txId), 'bootstrap network tx');
    const expected = { [INSTANCE_LABEL]: labels[INSTANCE_LABEL] };
    if (txId !== undefined) expected[BOOTSTRAP_TX_LABEL] = txId;
    const instanceId = labelShape(labels, env, expected);
    identity = { instanceId, txId, probe };
    policy(body.Name === `${env.networkPrefix}-${instanceId}`, 'instance network name');
  }
  const ordinal = env.networkCounter++;
  const third = Math.floor(ordinal / 16);
  const fourth = (ordinal % 16) * 16;
  policy(third < 256, 'verifier subnet allocation exhausted');
  body.Internal = true;
  body.Labels = { ...labels, [RUN_LABEL]: env.runId };
  body.IPAM = { Driver: 'default', Config: [{ Subnet: `${env.subnetPrefix}.${third}.${fourth}/28` }] };
  return { body: Buffer.from(JSON.stringify(body)), identity };
}

async function ownedContainer(ref, env, adapters) {
  policy(RESOURCE_REF.test(ref), 'container ref');
  policy(allowedContainerLookup(ref, env), 'container lookup scope');
  const info = await adapters.inspectContainer(ref);
  assertOwnedExisting(info, env, 'container');
  return info;
}

async function ownedNetwork(ref, env, adapters) {
  policy(RESOURCE_REF.test(ref), 'network ref');
  policy(allowedNetworkLookup(ref, env), 'network lookup scope');
  const info = await adapters.inspectNetwork(ref);
  assertOwnedExisting(info, env, 'network');
  return info;
}

export async function authorizeDockerProxyRequest(request, env, adapters) {
  const method = String(request.method ?? '').toUpperCase();
  const parsed = parseProxyUrl(request.url);
  const { path, search } = parsed;
  const body = request.body ?? Buffer.alloc(0);
  if ((method === 'GET' || method === 'HEAD') && path === '/_ping') {
    noQuery(search);
    return { body, responseFilter: undefined };
  }
  if (method === 'GET' && (path === '/version' || path === '/info')) {
    noQuery(search);
    return { body, responseFilter: undefined };
  }
  if (method === 'GET' && path === `/images/${env.nodeImageRef}/json`) {
    noQuery(search);
    return { body, responseFilter: undefined };
  }
  if (method === 'GET' && path === `/images/${env.nodeImageId}/json`) {
    noQuery(search);
    return { body, responseFilter: undefined };
  }
  if (method === 'GET' && path === '/containers/json') {
    let filters;
    exactQuery(search, {
      all: Object.assign((value) => value === '1' || value === 'true', { optional: true }),
      filters: (value) => { filters = parseLabelFilters(value, env); return true; },
    });
    policy(search.has('filters'), 'container filters required');
    return {
      body,
      responseFilter: 'containers',
      upstreamUrl: runScopedListUrl(request.url, filters, env, { all: search.get('all') ?? undefined }),
    };
  }
  if (method === 'GET' && path === '/networks') {
    let filters;
    exactQuery(search, {
      filters: (value) => { filters = parseLabelFilters(value, env); return true; },
    });
    return {
      body,
      responseFilter: 'networks',
      upstreamUrl: runScopedListUrl(request.url, filters, env),
    };
  }
  const containerRead = /^\/containers\/([^/]+)\/(json|logs|stats)$/.exec(path);
  if (method === 'GET' && containerRead) {
    const [, ref, action] = containerRead;
    policy(allowedContainerLookup(ref, env, action === 'json'), 'container lookup scope');
    const info = await adapters.inspectContainer(ref);
    if (!info) {
      policy(action === 'json' && (
        canonicalAbsentContainerRef(ref, env) || env.ownedContainerIds?.has(ref)
      ),
        'only canonical container absence probes are allowed');
    } else if (action === 'json' && info.Name === `/${env.managerName}`) {
      assertManager(info, env);
    } else {
      assertOwnedExisting(info, env, 'container');
    }
    if (action === 'json') noQuery(search);
    if (action === 'stats') {
      exactQuery(search, { stream: (value) => value === '0' || value === 'false' });
    }
    if (action === 'logs') {
      const bool = (value) => ['0', '1', 'true', 'false'].includes(value);
      const optionalBool = Object.assign(bool, { optional: true });
      const optionalTail = Object.assign((value) => /^(?:[1-9][0-9]{0,3}|all)$/.test(value),
        { optional: true });
      const optionalSince = Object.assign((value) => /^[0-9T:+.Z-]{1,64}$/.test(value),
        { optional: true });
      exactQuery(search, {
        stdout: optionalBool, stderr: optionalBool, follow: optionalBool,
        timestamps: optionalBool, tail: optionalTail, since: optionalSince,
      });
      policy(search.has('stdout') && search.has('stderr'), 'log streams required');
    }
    return { body, responseFilter: undefined };
  }
  const networkRead = /^\/networks\/([^/]+)$/.exec(path);
  if (method === 'GET' && networkRead) {
    noQuery(search);
    policy(allowedNetworkLookup(networkRead[1], env), 'network lookup scope');
    const info = await adapters.inspectNetwork(networkRead[1]);
    if (!info) {
      policy(canonicalAbsentNetworkRef(networkRead[1], env)
        || env.ownedNetworkIds?.has(networkRead[1]),
        'only canonical network absence probes are allowed');
    } else {
      assertOwnedExisting(info, env, 'network');
    }
    return { body, responseFilter: undefined };
  }
  if (method === 'POST' && path === '/containers/create') {
    const value = policyJson(body, 'container create', 64 * 1024);
    validateMirroredContainerQuery(search, value);
    const name = search.get('name');
    policy(typeof name === 'string' && RESOURCE_REF.test(name), 'container name');
    return {
      body: await validateContainerCreate(value, name, env, adapters),
      upstreamUrl: `${String(request.url).split('?', 1)[0]}?name=${encodeURIComponent(name)}`,
      createdKind: 'container',
    };
  }
  if (method === 'POST' && path === '/networks/create') {
    const value = policyJson(body, 'network create', 16 * 1024);
    validateMirroredNetworkQuery(search, value);
    return {
      body: validateNetworkCreate(value, env).body,
      // dockerode 5 duplicates create-network options into query and body.
      // Strip the untrusted mirror so only the validated/rewritten body reaches Docker.
      upstreamUrl: String(request.url).split('?', 1)[0],
      createdKind: 'network',
    };
  }
  const containerMutation = /^\/containers\/([^/]+)\/(start|stop|restart)$/.exec(path);
  if (method === 'POST' && containerMutation) {
    const [, ref, action] = containerMutation;
    await ownedContainer(ref, env, adapters);
    if (action === 'start') {
      noQuery(search);
      policy(body.length === 0, 'container start body');
      return { body };
    }
    exactQuery(search, { t: (value) => value === '10' });
    const value = policyJson(body, `container ${action}`, 128);
    policyKeys(value, ['t']);
    policy(value.t === 10, `container ${action} timeout`);
    return {
      body: Buffer.alloc(0),
      upstreamUrl: `${String(request.url).split('?', 1)[0]}?t=10`,
    };
  }
  const containerDelete = /^\/containers\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && containerDelete) {
    await ownedContainer(containerDelete[1], env, adapters);
    exactQuery(search, {
      force: (value) => value === '1' || value === 'true',
      v: Object.assign((value) => value === '0' || value === 'false', { optional: true }),
    });
    return { body };
  }
  const networkMutation = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(path);
  if (method === 'POST' && networkMutation) {
    noQuery(search);
    await ownedNetwork(networkMutation[1], env, adapters);
    const value = policyJson(body, `network ${networkMutation[2]}`, 4 * 1024);
    const manager = await adapters.inspectContainer(env.managerName);
    const managerId = assertManager(manager, env);
    if (networkMutation[2] === 'connect') policyKeys(value, ['Container']);
    else policyKeys(value, ['Container', 'Force']);
    policy(value.Container === managerId, 'network Manager target');
    if (networkMutation[2] === 'disconnect') policy(value.Force === true, 'disconnect force');
    return { body };
  }
  const networkDelete = /^\/networks\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && networkDelete) {
    noQuery(search);
    await ownedNetwork(networkDelete[1], env, adapters);
    policy(body.length === 0, 'network delete body');
    return { body };
  }
  const archive = /^\/containers\/([^/]+)\/archive$/.exec(path);
  if (method === 'PUT' && archive) {
    await ownedContainer(archive[1], env, adapters);
    exactQuery(search, { path: (value) => value === '/data' });
    policy(body.length > 0 && body.length <= 2 * 1024 * 1024, 'archive body');
    return { body };
  }
  throw new ProxyPolicyError(`route denied ${method} ${path}`);
}

export function filterDockerProxyResponse(plan, body, env) {
  if (!plan.responseFilter) return body;
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { throw new ProxyPolicyError('list response JSON'); }
  policy(Array.isArray(value), 'list response array');
  const filtered = value.filter((item) => {
    const labels = item?.Labels ?? {};
    return labels[RUN_LABEL] === env.runId
      && labels[MANAGED_LABEL] === 'true'
      && validInstance(labels[INSTANCE_LABEL], env);
  });
  return Buffer.from(JSON.stringify(filtered));
}

function observeDockerProxyResponse(plan, statusCode, body, env) {
  if (!plan.createdKind || (statusCode !== 200 && statusCode !== 201)) return;
  try {
    const id = JSON.parse(body.toString('utf8')).Id;
    if (!DOCKER_ID.test(id)) return;
    if (plan.createdKind === 'container') env.ownedContainerIds.add(id);
    if (plan.createdKind === 'network') env.ownedNetworkIds.add(id);
  } catch {
    // Docker's response is forwarded unchanged; later label-filtered discovery
    // remains the cleanup authority if a malformed daemon response cannot be remembered.
  }
}

async function inspectDocker(kind, id) {
  const suffix = kind === 'containers' ? '/json' : '';
  const response = await dockerSocketRequest(`/${kind}/${encodeURIComponent(id)}${suffix}`);
  if (response.statusCode !== 200) return undefined;
  return JSON.parse(response.body.toString('utf8'));
}

function proxyEnvironment() {
  const env = {
    runId: process.env.VERIFY_RUN_ID ?? '',
    instancePrefix: process.env.VERIFY_INSTANCE_PREFIX ?? '',
    managerName: process.env.VERIFY_MANAGER_NAME ?? '',
    nodeImageId: process.env.VERIFY_NODE_IMAGE_ID ?? '',
    nodeImageRef: 'nodered/node-red:5.0.4-24-minimal',
    subnetPrefix: process.env.VERIFY_SUBNET_PREFIX ?? '',
    instanceDataRoot: process.env.VERIFY_INSTANCE_DATA_ROOT ?? '',
    networkPrefix: process.env.VERIFY_NETWORK_PREFIX ?? '',
    networkCounter: 0,
    ownedContainerIds: new Set(),
    ownedNetworkIds: new Set(),
  };
  policy(SAFE_SEGMENT.test(env.runId), 'run id');
  policy(/^[a-z][a-z0-9-]+$/.test(env.instancePrefix), 'instance prefix');
  policy(SAFE_SEGMENT.test(env.managerName) && SHA256_ID.test(env.nodeImageId), 'Manager/image');
  policy(/^10\.(?:2[0-4]\d|25[0-4])$/.test(env.subnetPrefix), 'subnet prefix');
  policy((env.instanceDataRoot.startsWith('/private/tmp/') || env.instanceDataRoot.startsWith('/tmp/'))
    && !env.instanceDataRoot.endsWith('/'), 'instance data root');
  policy(SAFE_SEGMENT.test(env.networkPrefix), 'network prefix');
  return env;
}

function staticProxyFixture() {
  const env = {
    runId: 'v11-policy-test',
    instancePrefix: 'vpolicy',
    managerName: 'v11-policy-test-manager',
    nodeImageId: `sha256:${'a'.repeat(64)}`,
    nodeImageRef: 'nodered/node-red:5.0.4-24-minimal',
    subnetPrefix: '10.240',
    instanceDataRoot: '/private/tmp/v11-policy-test/edge-data/instances',
    networkPrefix: 'v11-policy-test-instance',
    networkCounter: 0,
    ownedContainerIds: new Set(),
    ownedNetworkIds: new Set(),
  };
  const instanceId = 'vpolicy-normal';
  const managerId = 'b'.repeat(64);
  const networkId = 'c'.repeat(64);
  const foreignNetworkId = 'd'.repeat(64);
  const probeNetworkId = '1'.repeat(64);
  const ownedContainerId = 'e'.repeat(64);
  const foreignContainerId = 'f'.repeat(64);
  const runLabels = {
    [RUN_LABEL]: env.runId, [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: instanceId,
  };
  const manager = {
    Id: managerId, Name: `/${env.managerName}`, Config: { Labels: { [RUN_LABEL]: env.runId } },
  };
  const network = {
    Id: networkId, Name: `${env.networkPrefix}-${instanceId}`, Internal: true,
    Labels: runLabels,
  };
  const foreignNetwork = {
    Id: foreignNetworkId, Name: 'v11-policy-test-foreign-net', Internal: true,
    Labels: { ...runLabels, [RUN_LABEL]: 'v11-policy-test-foreign' },
  };
  const probeTxId = 'migration-policy-test';
  const probeNetwork = {
    Id: probeNetworkId, Name: `${probeName(instanceId, probeTxId)}-net`, Internal: true,
    Labels: {
      ...runLabels,
      [MIGRATION_TX_LABEL]: probeTxId,
      [MIGRATION_PROBE_LABEL]: 'true',
    },
  };
  const bootstrapTxId = 'bootstrap-policy-test';
  const bootstrapNetworkId = '7'.repeat(64);
  const bootstrapNetwork = {
    Id: bootstrapNetworkId, Name: `${env.networkPrefix}-${instanceId}`, Internal: true,
    Labels: { ...runLabels, [BOOTSTRAP_TX_LABEL]: bootstrapTxId },
  };
  const ownedContainer = {
    Id: ownedContainerId, Name: `/tle-nr-${instanceId}`, Config: { Labels: runLabels },
  };
  const foreignContainer = {
    Id: foreignContainerId, Name: '/v11-policy-test-foreign',
    Config: { Labels: { ...runLabels, [RUN_LABEL]: 'v11-policy-test-foreign' } },
  };
  const canonicalForeignId = 'vpolicy-foreign';
  const canonicalForeignContainer = {
    Id: '9'.repeat(64), Name: `/tle-nr-${canonicalForeignId}`,
    Config: { Labels: {
      [RUN_LABEL]: 'v11-policy-test-foreign', [MANAGED_LABEL]: 'true',
      [INSTANCE_LABEL]: canonicalForeignId,
    } },
  };
  const canonicalForeignNetwork = {
    Id: '8'.repeat(64), Name: `${env.networkPrefix}-${canonicalForeignId}`, Internal: true,
    Labels: {
      [RUN_LABEL]: 'v11-policy-test-foreign', [MANAGED_LABEL]: 'true',
      [INSTANCE_LABEL]: canonicalForeignId,
    },
  };
  const containers = new Map([
    [env.managerName, manager], [managerId, manager],
    [ownedContainerId, ownedContainer], [`tle-nr-${instanceId}`, ownedContainer],
    [foreignContainerId, foreignContainer], ['v11-policy-test-foreign', foreignContainer],
    [canonicalForeignContainer.Id, canonicalForeignContainer],
    [`tle-nr-${canonicalForeignId}`, canonicalForeignContainer],
  ]);
  const networks = new Map([
    [networkId, network], [network.Name, network],
    [probeNetworkId, probeNetwork], [probeNetwork.Name, probeNetwork],
    [bootstrapNetworkId, bootstrapNetwork],
    [foreignNetworkId, foreignNetwork], [foreignNetwork.Name, foreignNetwork],
    [canonicalForeignNetwork.Id, canonicalForeignNetwork],
    [canonicalForeignNetwork.Name, canonicalForeignNetwork],
  ]);
  const inspectedContainers = new Set();
  const inspectedNetworks = new Set();
  const adapters = {
    inspectContainer: async (id) => {
      inspectedContainers.add(id);
      return containers.get(id);
    },
    inspectNetwork: async (id) => {
      inspectedNetworks.add(id);
      return networks.get(id);
    },
  };
  env.ownedContainerIds.add(ownedContainerId);
  for (const id of [networkId, probeNetworkId, bootstrapNetworkId]) env.ownedNetworkIds.add(id);
  const create = {
    name: `tle-nr-${instanceId}`,
    Image: env.nodeImageRef,
    User: 'node-red',
    Env: [
      'TZ=UTC', `TLE_INSTANCE_ID=${instanceId}`, `TLE_ADMIN_ROOT=/red/${instanceId}/`,
      `TLE_INGEST_TOKEN=${'t'.repeat(32)}`, `TLE_MANAGER_URL=http://${env.managerName}:19100`,
      `NPM_CONFIG_REGISTRY=http://${env.managerName}:19100/npm/`,
      'NPM_CONFIG_STRICT_SSL=false', 'NPM_CONFIG_AUDIT=false',
      'NPM_CONFIG_FUND=false', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
    ],
    Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: instanceId },
    ExposedPorts: {},
    HostConfig: {
      Memory: 256 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 512,
      Binds: [`${env.instanceDataRoot}/${instanceId}:/data`], PortBindings: {},
      ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: networkId,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
    },
  };
  const probeCreate = structuredClone(create);
  probeCreate.name = probeName(instanceId, probeTxId);
  probeCreate.Image = env.nodeImageId;
  probeCreate.Labels = {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: instanceId,
    [MIGRATION_TX_LABEL]: probeTxId, [MIGRATION_PROBE_LABEL]: 'true',
  };
  probeCreate.HostConfig.Binds = [
    `${env.instanceDataRoot}/.thinglinks-probes/${instanceId}/${probeTxId}:/data`,
  ];
  probeCreate.HostConfig.NetworkMode = probeNetworkId;
  probeCreate.HostConfig.RestartPolicy = { Name: 'no' };
  const bootstrapCreate = structuredClone(create);
  bootstrapCreate.Labels[BOOTSTRAP_TX_LABEL] = bootstrapTxId;
  bootstrapCreate.HostConfig.NetworkMode = bootstrapNetworkId;
  return {
    env, adapters, create, probeCreate, bootstrapCreate, bootstrapTxId,
    probeTxId, probeNetworkId,
    instanceId, managerId, networkId,
    foreignContainerId, foreignNetworkId, ownedContainerId,
    inspectedContainers, inspectedNetworks,
  };
}

export async function runProxyPolicySelfTests() {
  const fixture = staticProxyFixture();
  const { env, adapters } = fixture;
  let forwarded = 0;
  let mutations = 0;
  const dispatch = async (request) => {
    try {
      const plan = await authorizeDockerProxyRequest(request, env, adapters);
      forwarded += 1;
      if (!['GET', 'HEAD'].includes(request.method)) mutations += 1;
      return { status: 200, plan };
    } catch (error) {
      assert.ok(error instanceof ProxyPolicyError);
      return { status: 403 };
    }
  };
  const requestFor = (value) => ({
    method: 'POST',
    url: `/v1.52/containers/create?name=${value.name}`,
    body: Buffer.from(JSON.stringify(value)),
  });
  const dockerodeContainerRequestFor = (value) => {
    const query = new URLSearchParams();
    for (const [key, entry] of Object.entries(value)) {
      if (Array.isArray(entry)) {
        for (const item of entry) query.append(key, String(item));
      } else {
        query.set(key, entry !== null && typeof entry === 'object' ? JSON.stringify(entry) : String(entry));
      }
    }
    return {
      method: 'POST', url: `/v1.52/containers/create?${query}`,
      body: Buffer.from(JSON.stringify(value)),
    };
  };
  const allowed = await dispatch(requestFor(structuredClone(fixture.create)));
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.plan.body.toString('utf8')).Image, env.nodeImageId);
  const allowedDockerodeContainer = await dispatch(
    dockerodeContainerRequestFor(structuredClone(fixture.create)),
  );
  assert.equal(allowedDockerodeContainer.status, 200);
  const allowedProbe = await dispatch(requestFor(structuredClone(fixture.probeCreate)));
  assert.equal(allowedProbe.status, 200);
  const allowedNetwork = await dispatch({
    method: 'POST', url: '/networks/create',
    body: Buffer.from(JSON.stringify({
      Name: `${env.networkPrefix}-${fixture.instanceId}`, Driver: 'bridge',
      Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId },
    })),
  });
  assert.equal(allowedNetwork.status, 200);
  const dockerodeNetworkBody = {
    Name: `${env.networkPrefix}-${fixture.instanceId}`, Driver: 'bridge',
    Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId },
  };
  const allowedDockerodeNetwork = await dispatch({
    method: 'POST',
    url: `/networks/create?Name=${encodeURIComponent(dockerodeNetworkBody.Name)}`
      + `&Driver=bridge&Labels=${encodeURIComponent(JSON.stringify(dockerodeNetworkBody.Labels))}`,
    body: Buffer.from(JSON.stringify(dockerodeNetworkBody)),
  });
  assert.equal(allowedDockerodeNetwork.status, 200);
  const allowedProbeNetwork = await dispatch({
    method: 'POST', url: '/networks/create',
    body: Buffer.from(JSON.stringify({
      Name: `${probeName(fixture.instanceId, fixture.probeTxId)}-net`, Driver: 'bridge',
      Internal: true,
      Labels: {
        [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId,
        [MIGRATION_TX_LABEL]: fixture.probeTxId, [MIGRATION_PROBE_LABEL]: 'true',
      },
    })),
  });
  assert.equal(allowedProbeNetwork.status, 200);
  const allowedBootstrapNetwork = await dispatch({
    method: 'POST', url: '/networks/create',
    body: Buffer.from(JSON.stringify({
      Name: `${env.networkPrefix}-${fixture.instanceId}`, Driver: 'bridge',
      Labels: {
        [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId,
        [BOOTSTRAP_TX_LABEL]: fixture.bootstrapTxId,
      },
    })),
  });
  assert.equal(allowedBootstrapNetwork.status, 200);
  const allowedBootstrap = await dispatch(requestFor(structuredClone(fixture.bootstrapCreate)));
  assert.equal(allowedBootstrap.status, 200);
  const allowedBefore = { forwarded, mutations };

  const maliciousCreates = [
    ['custom Cmd', (value) => { value.Cmd = ['sleep', '1']; }],
    ['custom Entrypoint', (value) => { value.Entrypoint = ['/bin/sh']; }],
    ['foreign image', (value) => { value.Image = 'alpine:latest'; }],
    ['root user', (value) => { value.User = 'root'; }],
    ['extra mount field', (value) => { value.Mounts = [{ Type: 'volume', Target: '/data' }]; }],
    ['privileged', (value) => { value.HostConfig.Privileged = true; }],
    ['host bind', (value) => { value.HostConfig.Binds = ['/var/run/docker.sock:/data']; }],
    ['writable root', (value) => { value.HostConfig.ReadonlyRootfs = false; }],
    ['added cap', (value) => { value.HostConfig.CapAdd = ['SYS_ADMIN']; }],
    ['missing cap drop', (value) => { value.HostConfig.CapDrop = []; }],
    ['device', (value) => { value.HostConfig.Devices = [{ PathOnHost: '/dev/null' }]; }],
    ['host pid', (value) => { value.HostConfig.PidMode = 'host'; }],
    ['foreign network', (value) => { value.HostConfig.NetworkMode = fixture.foreignNetworkId; }],
    ['host port', (value) => { value.HostConfig.PortBindings = {
      '1880/tcp': [{ HostIp: '0.0.0.0', HostPort: '1880' }],
    }; }],
    ['unbounded memory', (value) => { value.HostConfig.Memory = 0; }],
    ['unbounded CPU', (value) => { value.HostConfig.NanoCpus = 0; }],
    ['unbounded PIDs', (value) => { value.HostConfig.PidsLimit = 0; }],
    ['unsafe security opt', (value) => { value.HostConfig.SecurityOpt = []; }],
    ['unsafe tmpfs', (value) => { value.HostConfig.Tmpfs = { '/tmp': 'rw,exec' }; }],
    ['wrong instance env', (value) => { value.Env[1] = 'TLE_INSTANCE_ID=vpolicy-other'; }],
    ['wrong admin root', (value) => { value.Env[2] = 'TLE_ADMIN_ROOT=/'; }],
    ['wrong Manager URL', (value) => { value.Env[4] = 'TLE_MANAGER_URL=http://foreign:19100'; }],
    ['wrong registry', (value) => { value.Env[5] = 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/'; }],
    ['duplicate env', (value) => { value.Env.push(value.Env[1]); }],
    ['wrong name', (value) => { value.name = 'tle-nr-vpolicy-other'; }],
    ['wrong label', (value) => { value.Labels[INSTANCE_LABEL] = 'vpolicy-other'; }],
  ];
  for (const [name, mutate] of maliciousCreates) {
    const value = structuredClone(fixture.create);
    mutate(value);
    const response = await dispatch(requestFor(value));
    assert.equal(response.status, 403, name);
    assert.deepEqual({ forwarded, mutations }, allowedBefore, `${name} forwarded`);
  }

  const networkCreates = [
    ['host driver', (value) => { value.Driver = 'host'; }],
    ['non-internal override', (value) => { value.Internal = false; }],
    ['network options', (value) => { value.Options = { unsafe: 'true' }; }],
    ['network IPAM override', (value) => { value.IPAM = { Driver: 'default' }; }],
    ['wrong network name', (value) => { value.Name = 'v11-policy-test-other'; }],
    ['wrong network owner', (value) => { value.Labels[INSTANCE_LABEL] = 'vpolicy-other'; }],
  ];
  for (const [name, mutate] of networkCreates) {
    const value = {
      Name: `${env.networkPrefix}-${fixture.instanceId}`, Driver: 'bridge',
      Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId },
    };
    mutate(value);
    const response = await dispatch({
      method: 'POST', url: '/networks/create', body: Buffer.from(JSON.stringify(value)),
    });
    assert.equal(response.status, 403, name);
    assert.deepEqual({ forwarded, mutations }, allowedBefore, `${name} forwarded`);
  }

  const deniedRequests = [
    ['foreign inspect', { method: 'GET', url: `/containers/${fixture.foreignContainerId}/json` }],
    ['foreign logs', { method: 'GET', url: `/containers/${fixture.foreignContainerId}/logs?stdout=1&stderr=1` }],
    ['foreign stats', { method: 'GET', url: `/containers/${fixture.foreignContainerId}/stats?stream=0` }],
    ['foreign network read', { method: 'GET', url: `/networks/${fixture.foreignNetworkId}` }],
    ['foreign canonical container read', { method: 'GET', url: '/containers/tle-nr-vpolicy-foreign/json' }],
    ['foreign canonical network read', { method: 'GET', url: '/networks/v11-policy-test-instance-vpolicy-foreign' }],
    ['foreign connect target', { method: 'POST', url: `/networks/${fixture.networkId}/connect`,
      body: Buffer.from(JSON.stringify({ Container: fixture.foreignContainerId })) }],
    ['foreign connect network', { method: 'POST', url: `/networks/${fixture.foreignNetworkId}/connect`,
      body: Buffer.from(JSON.stringify({ Container: fixture.managerId })) }],
    ['encoded path', { method: 'GET', url: `/containers/%2e%2e/json` }],
    ['encoded resource', { method: 'GET', url: `/containers/${fixture.ownedContainerId}%2fjson` }],
    ['wrong method', { method: 'POST', url: '/info' }],
    ['archive read', { method: 'GET', url: `/containers/${fixture.ownedContainerId}/archive?path=%2Fdata` }],
    ['exec', { method: 'POST', url: `/containers/${fixture.ownedContainerId}/exec`, body: Buffer.from('{}') }],
    ['events', { method: 'GET', url: '/events' }],
    ['volumes', { method: 'GET', url: '/volumes' }],
    ['image list', { method: 'GET', url: '/images/json' }],
    ['image export', { method: 'GET', url: `/images/${env.nodeImageRef}/get` }],
    ['plugins', { method: 'GET', url: '/plugins' }],
    ['inspect query', { method: 'GET', url: `/containers/${fixture.ownedContainerId}/json?size=1` }],
    ['duplicate query', { method: 'GET', url: '/containers/json?filters=%7B%22label%22%3A%5B%22com.mqttsnet.thinglinks-edge.managed%3Dtrue%22%5D%7D&filters=%7B%7D' }],
    ['volume delete flag', { method: 'DELETE', url: `/containers/${fixture.ownedContainerId}?force=1&v=1` }],
    ['network create query mismatch', {
      method: 'POST',
      url: `/networks/create?Name=${encodeURIComponent(`${env.networkPrefix}-${fixture.instanceId}`)}`
        + `&Driver=host&Labels=${encodeURIComponent(JSON.stringify({
          [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId,
        }))}`,
      body: Buffer.from(JSON.stringify(dockerodeNetworkBody)),
    }],
    ['container create query mismatch', (() => {
      const request = dockerodeContainerRequestFor(structuredClone(fixture.create));
      request.url = request.url.replace('User=node-red', 'User=root');
      return request;
    })()],
    ['unowned missing container id', {
      method: 'GET', url: `/containers/${'6'.repeat(64)}/json`,
    }],
    ['unowned missing network id', {
      method: 'GET', url: `/networks/${'5'.repeat(64)}`,
    }],
    ['restart body/query mismatch', {
      method: 'POST', url: `/containers/${fixture.ownedContainerId}/restart?t=10`,
      body: Buffer.from('{"t":9}'),
    }],
    ['stop body extra field', {
      method: 'POST', url: `/containers/${fixture.ownedContainerId}/stop?t=10`,
      body: Buffer.from('{"t":10,"Signal":"SIGKILL"}'),
    }],
    ['protected-looking container id', {
      method: 'GET', url: `/containers/${'2'.repeat(64)}/json`,
    }],
    ['protected-looking network id', {
      method: 'GET', url: `/networks/${'0'.repeat(64)}`,
    }],
  ];
  for (const [name, request] of deniedRequests) {
    const response = await dispatch({ body: Buffer.alloc(0), ...request });
    assert.equal(response.status, 403, name);
    assert.deepEqual({ forwarded, mutations }, allowedBefore, `${name} forwarded`);
  }
  assert.equal(fixture.inspectedContainers.has('2'.repeat(64)), false,
    'proxy inspected an untrusted container id');
  assert.equal(fixture.inspectedNetworks.has('0'.repeat(64)), false,
    'proxy inspected an untrusted network id');

  const managerRead = await dispatch({ method: 'GET', url: `/containers/${env.managerName}/json` });
  assert.equal(managerRead.status, 200);
  const ownedRead = await dispatch({ method: 'GET', url: `/containers/${fixture.ownedContainerId}/json` });
  assert.equal(ownedRead.status, 200);
  const restart = await dispatch({
    method: 'POST', url: `/containers/${fixture.ownedContainerId}/restart?t=10`,
    body: Buffer.from('{"t":10}'),
  });
  assert.equal(restart.status, 200);
  const stop = await dispatch({
    method: 'POST', url: `/containers/${fixture.ownedContainerId}/stop?t=10`,
    body: Buffer.from('{"t":10}'),
  });
  assert.equal(stop.status, 200);
  const absentId = `${env.instancePrefix}-absent`;
  const absentContainerRead = await dispatch({
    method: 'GET', url: `/containers/tle-nr-${absentId}/json`,
  });
  assert.equal(absentContainerRead.status, 200);
  const absentNetworkRead = await dispatch({
    method: 'GET', url: `/networks/${env.networkPrefix}-${absentId}`,
  });
  assert.equal(absentNetworkRead.status, 200);
  const removedContainerId = '4'.repeat(64);
  observeDockerProxyResponse(allowed.plan, 201,
    Buffer.from(JSON.stringify({ Id: removedContainerId })), env);
  const removedContainerRead = await dispatch({
    method: 'GET', url: `/containers/${removedContainerId}/json`,
  });
  assert.equal(removedContainerRead.status, 200);
  const removedNetworkId = '3'.repeat(64);
  observeDockerProxyResponse(allowedNetwork.plan, 201,
    Buffer.from(JSON.stringify({ Id: removedNetworkId })), env);
  const removedNetworkRead = await dispatch({
    method: 'GET', url: `/networks/${removedNetworkId}`,
  });
  assert.equal(removedNetworkRead.status, 200);
  const connect = await dispatch({
    method: 'POST', url: `/networks/${fixture.networkId}/connect`,
    body: Buffer.from(JSON.stringify({ Container: fixture.managerId })),
  });
  assert.equal(connect.status, 200);
  const archiveWrite = await dispatch({
    method: 'PUT', url: `/containers/${fixture.ownedContainerId}/archive?path=%2Fdata`,
    body: Buffer.from('safe-verifier-tar'),
  });
  assert.equal(archiveWrite.status, 200);
  const listPlan = await authorizeDockerProxyRequest({
    method: 'GET',
    url: `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({
      label: [`${MANAGED_LABEL}=true`],
    }))}`,
  }, env, adapters);
  const listUpstream = new URL(listPlan.upstreamUrl, 'http://docker.invalid');
  const listUpstreamFilters = JSON.parse(listUpstream.searchParams.get('filters'));
  assert.ok(listUpstreamFilters.label.includes(`${RUN_LABEL}=${env.runId}`));
  const filtered = JSON.parse(filterDockerProxyResponse(listPlan, Buffer.from(JSON.stringify([
    { Id: fixture.ownedContainerId, Labels: {
      [RUN_LABEL]: env.runId, [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId,
    } },
    { Id: fixture.foreignContainerId, Labels: {
      [RUN_LABEL]: 'foreign', [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: fixture.instanceId,
    } },
  ])), env).toString('utf8'));
  assert.deepEqual(filtered.map((item) => item.Id), [fixture.ownedContainerId]);
  const networkListPlan = await authorizeDockerProxyRequest({
    method: 'GET',
    url: `/networks?filters=${encodeURIComponent(JSON.stringify({
      name: [`${env.networkPrefix}-${fixture.instanceId}`],
    }))}`,
  }, env, adapters);
  const networkUpstream = new URL(networkListPlan.upstreamUrl, 'http://docker.invalid');
  const networkUpstreamFilters = JSON.parse(networkUpstream.searchParams.get('filters'));
  assert.ok(networkUpstreamFilters.label.includes(`${RUN_LABEL}=${env.runId}`));

  const passed = 8 + maliciousCreates.length + networkCreates.length + deniedRequests.length + 13;
  return { passed, total: passed };
}

async function runDockerProxy() {
  const env = proxyEnvironment();
  const adapters = {
    inspectContainer: (id) => inspectDocker('containers', id),
    inspectNetwork: (id) => inspectDocker('networks', id),
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    try {
      const declared = Number(req.headers['content-length'] ?? 0);
      policy(Number.isSafeInteger(declared) && declared >= 0 && declared <= 2 * 1024 * 1024,
        'request body too large');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        policy(size <= 2 * 1024 * 1024, 'request body too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const plan = await authorizeDockerProxyRequest({ method, url: req.url, body }, env, adapters);
      const headers = { ...req.headers, host: 'docker' };
      delete headers['content-length'];
      if (plan.body.length > 0) headers['content-length'] = String(plan.body.length);
      const upstream = await dockerSocketRequest(plan.upstreamUrl ?? req.url ?? '/', {
        method, headers, body: plan.body,
      });
      observeDockerProxyResponse(plan, upstream.statusCode, upstream.body, env);
      const responseBody = filterDockerProxyResponse(plan, upstream.body, env);
      const responseHeaders = { ...upstream.headers };
      if (plan.responseFilter) {
        delete responseHeaders['transfer-encoding'];
        responseHeaders['content-length'] = String(responseBody.length);
      }
      res.writeHead(upstream.statusCode, responseHeaders);
      res.end(responseBody);
    } catch (error) {
      const reason = error instanceof ProxyPolicyError ? error.message : 'internal proxy error';
      process.stderr.write(`[verify-proxy] DENY ${method} ${proxyDiagnosticTarget(req.url)}: ${reason}\n`);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"message":"verifier proxy denied"}');
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
  const logRoot = process.env.VERIFY_ROUTE_ROOT ?? '';
  assert.match(upstream, /^http:\/\/[A-Za-z0-9._-]+:\d+$/);
  assert.equal(dirname(logPath), trustedDirectory(logRoot));
  trustedFile(logPath, logRoot);
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
      appendTrustedFile(logPath, logRoot, `${JSON.stringify(record)}\n`);
      const outHeaders = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, outHeaders);
      res.end(responseBody);
    } catch {
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

function repairPermissions() {
  const root = process.env.VERIFY_PERMISSION_ROOT ?? '';
  assert.equal(root, '/cleanup');
  trustedDirectory(root);
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    }
  };
  walk(root);
  process.stdout.write('[verify-permissions] repaired\n');
}

async function main() {
  const mode = process.argv[2] ?? '';
  if (mode === 'proxy-policy-test') {
    const result = await runProxyPolicySelfTests();
    process.stdout.write(`proxy-policy:${result.passed}/${result.total} PASS\n`);
    return;
  }
  if (mode === 'manager') return runManager();
  if (mode === 'fixture-v12') return buildV12Fixtures();
  if (mode === 'render-harness-settings') return renderHarnessSettings();
  if (mode === 'docker-proxy') return runDockerProxy();
  if (mode === 'route-proxy') return runRouteProxy();
  if (mode === 'seed-registry') return runSeedRegistry();
  if (mode === 'permission-cleanup') return repairPermissions();
  throw new Error(`unknown verifier entry mode: ${mode || '<missing>'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[verify-entry] ${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
