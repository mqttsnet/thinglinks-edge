#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import Docker from 'dockerode';

import {
  assertSafeCreateOptions,
  buildCreateOptions,
  containerName,
} from '../dist/core/instance/container-spec.js';
import { verifyInstalledPlatformFiles } from '../dist/core/nodes/installed-files.js';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from '../dist/core/nodes/platform-contract.js';

const phases = [
  'manager-bootstrap',
  'new-instance-api',
  'new-instance-compensation',
  'legacy-running-api',
  'legacy-stopped-api',
  'same-image-rebuild',
  'interrupted-recovery-running',
  'interrupted-recovery-stopped',
  'rollback-injected',
  'allowlist-positive',
  'allowlist-negative',
  'allowlist-recovery',
  'manager-five-routes',
  'cleanup',
];

const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANAGER_ROOT = resolve(SCRIPT_DIR, '..');
const ENTRY_PATH = join(SCRIPT_DIR, 'verify-platform-manager-entry.mjs');
const NODE_IMAGE = 'nodered/node-red:5.0.4-24-minimal';
const MANAGER_IMAGE = process.env.MANAGER_IMAGE?.trim() ?? '';
const results = new Map(phases.map((phase) => [phase, undefined]));
const raw = new Docker();

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const secret = (master, purpose, bytes = 32) => createHmac('sha256', master)
  .update(purpose).digest('base64url').slice(0, bytes);
const safeError = (error) => String(error?.message ?? error)
  .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, '<redacted>').slice(0, 1200);

function pass(phase, evidence) {
  assert.ok(phases.includes(phase), `unknown phase ${phase}`);
  assert.equal(results.get(phase), undefined, `phase ${phase} completed twice`);
  results.set(phase, evidence);
  process.stdout.write(`  PASS ${phase}\n`);
}

function writeDurableJson(path, value) {
  const partial = `${path}.partial-${process.pid}`;
  const fd = openSync(partial, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function pullImage(name) {
  const stream = await raw.pull(name);
  await new Promise((resolvePull, reject) => {
    raw.modem.followProgress(stream, (error) => error ? reject(error) : resolvePull());
  });
}

async function relevantDockerSnapshot() {
  const relevant = /(?:^|[-_/])(tle|thinglinks|node-red)(?:[-_/.:]|$)/i;
  const containers = (await raw.listContainers({ all: true }))
    .filter((item) => relevant.test(`${item.Names.join(' ')} ${item.Image}`))
    .map((item) => ({
      id: item.Id, names: [...item.Names].sort(), imageId: item.ImageID,
      state: item.State, networks: Object.keys(item.NetworkSettings?.Networks ?? {}).sort(),
    })).sort((left, right) => left.id.localeCompare(right.id));
  const networks = (await raw.listNetworks())
    .filter((item) => relevant.test(item.Name))
    .map((item) => ({ id: item.Id, name: item.Name, internal: item.Internal === true }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const images = (await raw.listImages({ all: true }))
    .filter((item) => (item.RepoTags ?? []).some((tag) => relevant.test(tag)))
    .map((item) => ({ id: item.Id, tags: [...(item.RepoTags ?? [])].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { containers, networks, images };
}

async function protectedDockerSnapshot() {
  const names = new Set(['/thinglinks-edge-manager', '/tle-nr-line-1']);
  const matches = (await raw.listContainers({ all: true }))
    .filter((item) => item.Names.some((name) => names.has(name)));
  const snapshots = await Promise.all(matches.map(async (item) => {
    const info = await raw.getContainer(item.Id).inspect();
    return {
      id: info.Id,
      names: [...item.Names].sort(),
      imageId: info.Image,
      state: info.State.Status,
      health: info.State.Health?.Status ?? 'none',
      networks: Object.values(info.NetworkSettings.Networks ?? {})
        .map((network) => network.NetworkID).sort(),
    };
  }));
  return snapshots.sort((left, right) => left.id.localeCompare(right.id));
}

function baselineResourcesUnchanged(before, after, permittedImageIds) {
  assert.deepEqual(after.containers, before.containers, 'baseline containers changed');
  assert.deepEqual(after.networks, before.networks, 'baseline networks changed');
  const normalized = (items) => items
    .filter((item) => !permittedImageIds.has(item.id))
    .map((item) => item.id).sort();
  assert.deepEqual(normalized(after.images), normalized(before.images), 'baseline image ids changed');
}

function treeHash(path) {
  const hash = createHash('sha256');
  const walk = (entry, relative = '') => {
    const stat = lstatSync(entry);
    assert.equal(stat.isSymbolicLink(), false, `symlink in ${entry}`);
    hash.update(`${relative}\0${stat.mode & 0o777}\0${stat.isDirectory() ? 'd' : 'f'}\0`);
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry).sort()) walk(join(entry, child), join(relative, child));
    } else {
      hash.update(readFileSync(entry));
    }
  };
  walk(path);
  return hash.digest('hex');
}

function makeTreeWritable(path) {
  const stat = lstatSync(path);
  chmodSync(path, stat.isDirectory() ? 0o777 : 0o666);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) makeTreeWritable(join(path, child));
  }
}

async function execIn(containerId, command, timeoutMs = 30_000) {
  const execution = await raw.getContainer(containerId).exec({
    Cmd: command, AttachStdout: true, AttachStderr: true, Tty: false,
  });
  const stream = await execution.start({ hijack: true });
  let output = '';
  let streamError;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  raw.modem.demuxStream(stream, stdout, stderr);
  stream.on('error', (error) => { streamError = error; });
  const deadline = Date.now() + timeoutMs;
  let info = await execution.inspect();
  while (info.Running && Date.now() < deadline) {
    await sleep(25);
    info = await execution.inspect();
  }
  if (!info.Running) await sleep(250);
  stream.destroy();
  if (streamError) throw streamError;
  if (info.Running) throw new Error(`container exec timeout: ${command.slice(0, 2).join(' ')}`);
  return { code: info.ExitCode ?? 1, output };
}

function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function dockerLogText(buffer) {
  let offset = 0;
  let output = '';
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) break;
    output += buffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
  }
  return output || buffer.toString('utf8');
}

function typesFromInventoryEntry(entry) {
  if (Array.isArray(entry?.types)) return entry.types;
  if (Array.isArray(entry?.nodes)) {
    return entry.nodes.flatMap((node) => node?.types ?? [node?.type ?? node?.name]).filter(Boolean);
  }
  if (entry?.nodes && typeof entry.nodes === 'object') {
    return Object.entries(entry.nodes).flatMap(([name, node]) => node?.types ?? [node?.type ?? name]);
  }
  return [];
}

function moduleTypes(inventory, module) {
  return [...new Set(inventory.filter((entry) => (
    entry?.module === module || entry?.name === module || entry?.id === module
  )).flatMap(typesFromInventoryEntry))].sort();
}

function acceptanceFlow(marker) {
  return [
    { id: 'acceptance-tab', type: 'tab', label: 'Task 11 acceptance', disabled: false, info: '' },
    {
      id: 'acceptance-inject', type: 'inject', z: 'acceptance-tab', name: 'Task 11 trigger',
      props: [{ p: 'payload' }, { p: 'quality', v: 'good', vt: 'str' }],
      repeat: '', crontab: '', once: false, onceDelay: 0.2, topic: '',
      payload: JSON.stringify({ marker, temperature: 23, instanceId: 'forged-instance' }),
      payloadType: 'json', quality: 'good', qualityType: 'str',
      x: 100, y: 100, wires: [['acceptance-device']],
    },
    {
      id: 'acceptance-device', type: 'tl-device', z: 'acceptance-tab', name: 'Device 01',
      deviceId: 'device-01', protocol: 'modbus-tcp', address: '192.0.2.10:502',
      model: 'M1', manufacturer: 'ThingLinks', x: 280, y: 100, wires: [['acceptance-tag']],
    },
    {
      id: 'acceptance-tag', type: 'tl-tag', z: 'acceptance-tab', name: 'Temperature',
      deviceId: 'device-01', tagId: 'temperature', unit: 'C', dataType: 'float',
      x: 460, y: 100, wires: [['acceptance-uplink']],
    },
    {
      id: 'acceptance-uplink', type: 'tl-uplink', z: 'acceptance-tab', name: 'Uplink',
      serviceId: 'acceptance', deviceId: 'device-01', x: 640, y: 100,
      wires: [['acceptance-format']],
    },
    {
      id: 'acceptance-format', type: 'function', z: 'acceptance-tab', name: 'Preserve message',
      func: 'msg.payload = JSON.stringify(msg.payload);\nreturn msg;', outputs: 1,
      timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
      x: 820, y: 100, wires: [['acceptance-output']],
    },
    {
      id: 'acceptance-output', type: 'file', z: 'acceptance-tab', name: 'Output',
      filename: '/results/flow-output.ndjson', filenameType: 'str', appendNewline: true,
      createDir: false, overwriteFile: 'false', encoding: 'none',
      x: 1000, y: 100, wires: [[]],
    },
  ];
}

function invalidFlow() {
  return [
    { id: 'invalid-tab', type: 'tab', label: 'Invalid config', disabled: false, info: '' },
    {
      id: 'invalid-device', type: 'tl-device', z: 'invalid-tab', name: 'Invalid device',
      deviceId: '  ', protocol: '', address: '', model: '', manufacturer: '',
      x: 180, y: 80, wires: [[]],
    },
    {
      id: 'invalid-tag', type: 'tl-tag', z: 'invalid-tab', name: 'Invalid tag',
      deviceId: 'device-01', tagId: '', unit: '', dataType: '',
      x: 180, y: 140, wires: [[]],
    },
  ];
}

async function waitFor(label, task, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${safeError(lastError)}` : ''}`);
}

class RunResources {
  constructor(runId, root) {
    this.runId = runId;
    this.root = root;
    this.containers = new Map();
    this.networks = new Map();
  }

  async trackContainer(container, name) {
    const info = await container.inspect();
    assert.equal(info.Config.Labels?.[RUN_LABEL], this.runId);
    this.containers.set(info.Id, name);
    return info.Id;
  }

  async trackNetwork(network, name) {
    const info = await network.inspect();
    assert.equal(info.Labels?.[RUN_LABEL], this.runId);
    this.networks.set(info.Id, name);
    return info.Id;
  }

  async removeContainer(id) {
    const ref = raw.getContainer(id);
    const info = await ref.inspect().catch(() => undefined);
    if (!info) {
      this.containers.delete(id);
      return;
    }
    assert.equal(info.Config.Labels?.[RUN_LABEL], this.runId, `refuse foreign container ${id}`);
    await ref.remove({ force: true });
    assert.equal(await ref.inspect().then(() => true).catch(() => false), false);
    this.containers.delete(id);
  }

  async removeNetwork(id) {
    const ref = raw.getNetwork(id);
    const info = await ref.inspect().catch(() => undefined);
    if (!info) {
      this.networks.delete(id);
      return;
    }
    assert.equal(info.Labels?.[RUN_LABEL], this.runId, `refuse foreign network ${id}`);
    await ref.remove();
    assert.equal(await ref.inspect().then(() => true).catch(() => false), false);
    this.networks.delete(id);
  }

  async discover() {
    for (const item of await raw.listContainers({
      all: true, filters: { label: [`${RUN_LABEL}=${this.runId}`] },
    })) this.containers.set(item.Id, item.Names[0] ?? item.Id);
    for (const item of await raw.listNetworks({
      filters: { label: [`${RUN_LABEL}=${this.runId}`] },
    })) this.networks.set(item.Id, item.Name);
  }
}

class PlatformVerifier {
  constructor() {
    assert.ok(MANAGER_IMAGE, 'MANAGER_IMAGE is required; platform matrix cannot be skipped');
    this.runId = `v11-${randomBytes(5).toString('hex')}`;
    this.instancePrefix = `v${randomBytes(3).toString('hex')}`;
    this.root = realpathSync(mkdtempSync(join('/private/tmp', `${this.runId}-`)));
    chmodSync(this.root, 0o777);
    this.dataRoot = join(this.root, 'edge-data');
    this.controlRoot = join(this.root, 'control');
    this.resultsRoot = join(this.root, 'results');
    this.fixtureSpecPath = join(this.root, 'fixtures.json');
    for (const path of [this.dataRoot, this.controlRoot, this.resultsRoot]) {
      mkdirSync(path, { recursive: true, mode: 0o777 });
      chmodSync(path, 0o777);
    }
    this.master = randomBytes(48).toString('base64url');
    this.adminPassword = randomBytes(24).toString('base64url');
    this.resources = new RunResources(this.runId, this.root);
    this.managerName = `${this.runId}-manager`;
    this.proxyName = `${this.runId}-docker-proxy`;
    this.controlNetworkName = `${this.runId}-control`;
    this.networkPrefix = `${this.runId}-instance`;
    this.hostPort = undefined;
    this.managerId = undefined;
    this.proxyId = undefined;
    this.controlNetworkId = undefined;
    this.nodeImageId = undefined;
    this.managerImageId = undefined;
    this.session = undefined;
    this.knownReady = new Set();
    this.initialSnapshots = new Map();
    this.networkOrdinal = 0;
    this.subnetSecondOctet = undefined;
  }

  id(label) {
    const value = `${this.instancePrefix}-${label}`;
    assert.ok(value.length <= 32);
    return value;
  }

  async initializeImages() {
    const runningUsers = (await raw.listContainers({
      all: true, filters: { ancestor: [MANAGER_IMAGE] },
    })).filter((item) => item.State === 'running');
    assert.equal(runningUsers.length, 0, `${MANAGER_IMAGE} backs a running container`);
    await pullImage(NODE_IMAGE);
    const manager = await raw.getImage(MANAGER_IMAGE).inspect();
    const node = await raw.getImage(NODE_IMAGE).inspect();
    assert.match(manager.Id, /^sha256:[a-f0-9]{64}$/);
    assert.match(node.Id, /^sha256:[a-f0-9]{64}$/);
    this.managerImageId = manager.Id;
    this.nodeImageId = node.Id;
    const occupied = (await raw.listNetworks()).flatMap((network) => (
      network.IPAM?.Config ?? []
    )).map((config) => String(config.Subnet ?? ''));
    this.subnetSecondOctet = Array.from({ length: 35 }, (_, index) => 219 + index)
      .find((candidate) => (
        !occupied.some((subnet) => subnet.startsWith(`10.${candidate}.`))
        && !occupied.some((subnet) => subnet.startsWith(`10.${candidate + 1}.`))
      ));
    assert.ok(this.subnetSecondOctet && this.subnetSecondOctet < 254,
      'no isolated verifier subnet pair available');
  }

  async createNetwork(name, labels, internal = true) {
    const ordinal = this.networkOrdinal++;
    const third = Math.floor(ordinal / 32);
    const fourth = (ordinal % 32) * 8;
    assert.ok(third < 256);
    const network = await raw.createNetwork({
      Name: name, Driver: 'bridge', Internal: internal,
      Labels: { ...labels, [RUN_LABEL]: this.runId },
      IPAM: {
        Driver: 'default',
        Config: [{ Subnet: `10.${this.subnetSecondOctet}.${third}.${fourth}/29` }],
      },
    });
    const id = await this.resources.trackNetwork(network, name);
    const info = await network.inspect();
    assert.equal(info.Internal, internal);
    return id;
  }

  async createContainer(options, name) {
    options.name = name;
    options.Labels = { ...(options.Labels ?? {}), [RUN_LABEL]: this.runId };
    const container = await raw.createContainer(options);
    const id = await this.resources.trackContainer(container, name);
    return { container, id };
  }

  async runOneShot(mode, env, binds, user = 'node') {
    const name = `${this.runId}-${mode}-${randomBytes(2).toString('hex')}`;
    const { container, id } = await this.createContainer({
      Image: this.managerImageId,
      User: user,
      Cmd: ['node', '/verify/entry.mjs', mode],
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true,
        Binds: [`${ENTRY_PATH}:/verify/entry.mjs:ro`, ...binds],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      },
      Labels: {},
    }, name);
    await container.start();
    const result = await container.wait({ condition: 'not-running' });
    const logs = (await container.logs({ stdout: true, stderr: true })).toString('utf8');
    await this.resources.removeContainer(id);
    assert.equal(result.StatusCode, 0, `${mode} failed: ${safeError({ message: logs })}`);
    return logs;
  }

  fixtureDefinitions() {
    const running = [
      'runok', 'sameok', 'samethrow', 'staged', 'rset',
      'rr-prep', 'rr-check', 'rr-stage', 'rr-cut', 'rr-verify', 'rr-roll',
    ];
    const stopped = [
      'stopok', 'sset', 'sscout',
      ...Array.from({ length: 20 }, (_, index) => `sb${String(index).padStart(2, '0')}`),
      'rs-prep', 'rs-check', 'rs-stage', 'rs-cut', 'rs-pend', 'rs-verify', 'rs-roll',
    ];
    return [
      ...running.map((label) => ({
        label, id: this.id(label), running: true,
        driftEnvironment: label === 'sameok' || label === 'samethrow',
      })),
      ...stopped.map((label) => ({
        label, id: this.id(label), running: false,
        driftEnvironment: false,
      })),
    ];
  }

  async buildFixtures() {
    this.fixtures = this.fixtureDefinitions();
    writeDurableJson(this.fixtureSpecPath, {
      version: 1,
      instances: this.fixtures.map(({ id, running, driftEnvironment }) => ({
        id, running,
        driftEnvironment,
      })),
    });
    const logs = await this.runOneShot('fixture-v12', {
      EDGE_DATA_ROOT: this.dataRoot,
      MASTER_KEY: this.master,
      VERIFY_FIXTURE_SPEC: this.fixtureSpecPath,
      VERIFY_MANAGER_NAME: this.managerName,
    }, [
      `${this.dataRoot}:${this.dataRoot}`,
      `${this.fixtureSpecPath}:${this.fixtureSpecPath}:ro`,
    ]);
    assert.match(logs, new RegExp(`fixture-v12:${this.fixtures.length}`));
    const db = new Database(join(this.dataRoot, 'manager', 'edge.db'), { readonly: true });
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 12);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instance').get().n, this.fixtures.length);
    db.close();
  }

  async createFixture(definition) {
    const networkName = `${this.networkPrefix}-${definition.id}`;
    const networkId = await this.createNetwork(networkName, {
      [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: definition.id,
    });
    const expectedManager = definition.driftEnvironment
      ? 'http://wrong.invalid:19100'
      : `http://${this.managerName}:19100`;
    const options = buildCreateOptions({
      id: definition.id,
      imageTag: '5.0.4-24-minimal',
      memoryMb: 256,
      cpus: 0.5,
      ports: [],
      adminRoot: `/red/${definition.id}/`,
      ingestToken: secret(this.master, `ingest-token:${definition.id}`, 32),
      managerUrl: expectedManager,
      npmRegistry: `http://${this.managerName}:19100/npm/`,
    }, {
      network: networkId,
      imageRepo: 'nodered/node-red',
      instanceDataRoot: join(this.dataRoot, 'instances'),
      timezone: 'UTC',
      imageIdOverride: this.nodeImageId,
    });
    assertSafeCreateOptions(options, { instanceDataRoot: join(this.dataRoot, 'instances') });
    const created = await this.createContainer(options, containerName(definition.id));
    definition.containerId = created.id;
    definition.networkId = networkId;
    if (definition.running) await created.container.start();
  }

  async createAllFixtures() {
    for (const fixture of this.fixtures) await this.createFixture(fixture);
    const running = this.fixtures.filter((fixture) => fixture.running);
    await Promise.all(running.map(async (fixture) => {
      await waitFor(`${fixture.id} pre-Manager Node-RED readiness`, async () => {
        const result = await execIn(fixture.containerId, [
          'node', '-e',
          `fetch('http://127.0.0.1:1880/red/${fixture.id}/settings')`
            + '.then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))',
        ], 10_000).catch(() => ({ code: 1 }));
        return result.code === 0;
      }, { timeoutMs: 90_000, intervalMs: 500 });
    }));
    await this.hotStagePreexistingFixture();
    for (const fixture of this.fixtures) {
      const info = await raw.getContainer(fixture.containerId).inspect();
      assert.equal(info.State.Running, fixture.running);
      const root = join(this.dataRoot, 'instances', fixture.id);
      this.initialSnapshots.set(fixture.id, {
        settings: sha256(readFileSync(join(root, 'settings.js'))),
        flows: sha256(readFileSync(join(root, 'flows.json'))),
        credentials: sha256(readFileSync(join(root, 'flows_cred.json'))),
        packageManifest: sha256(readFileSync(join(root, 'package.json'))),
        lock: sha256(readFileSync(join(root, 'package-lock.json'))),
        raw: treeHash(join(root, 'nodes')),
      });
    }
  }

  async hotStagePreexistingFixture() {
    const fixture = this.fixture('staged');
    const created = await this.createContainer({
      Image: this.managerImageId,
      User: 'node',
      Cmd: ['node', '/verify/entry.mjs', 'seed-registry'],
      Env: [`VERIFY_MANAGER_NAME=${this.managerName}`],
      HostConfig: {
        NetworkMode: fixture.networkId,
        ReadonlyRootfs: true,
        Binds: [`${ENTRY_PATH}:/verify/entry.mjs:ro`],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {},
    }, this.managerName);
    await created.container.start();
    await waitFor('pre-Manager seed registry', async () => {
      const logs = dockerLogText(await created.container.logs({ stdout: true, stderr: true }));
      return logs.includes('[verify-seed-registry] ready');
    }, { timeoutMs: 30_000 });
    const response = await this.fixtureAdminRequest('staged', 'nodes', {
      method: 'POST', body: {
        module: PLATFORM_NODE_PACKAGE.name, version: PLATFORM_NODE_PACKAGE.version,
      },
    });
    assert.equal(response.status, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.name, PLATFORM_NODE_PACKAGE.name);
    assert.equal(body.version, PLATFORM_NODE_PACKAGE.version);
    assert.deepEqual(body.nodes.map((node) => ({ type: node.types[0], error: node.err })),
      PLATFORM_NODE_TYPES.map((type) => ({ type, error: `${type} already registered` })));
    await this.resources.removeContainer(created.id);
    const root = join(this.dataRoot, 'instances', fixture.id);
    await verifyInstalledPlatformFiles({
      instanceDataRoot: join(this.dataRoot, 'instances'), instanceId: fixture.id,
      readFile: (path, encoding) => Promise.resolve(readFileSync(path, encoding)),
    });
    assert.ok(existsSync(join(root, 'node_modules', '@mqttsnet', 'thinglinks-node-red-common')));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    for (const name of [PLATFORM_NODE_PACKAGE.name, PLATFORM_COMMON_PACKAGE.name]) {
      const resolved = lock.packages?.[`node_modules/${name}`]?.resolved;
      assert.equal(typeof resolved, 'string', `${name} resolved transport missing`);
      assert.ok(resolved.startsWith(`http://${this.managerName}:19100/npm/`), resolved);
      assert.equal(resolved.startsWith('file:'), false, resolved);
    }
  }

  async startDockerProxy() {
    // Only the Manager/proxy control plane publishes a loopback host port. Every
    // Node-RED instance/probe network remains Internal=true and has no host port.
    this.controlNetworkId = await this.createNetwork(this.controlNetworkName, {}, false);
    const created = await this.createContainer({
      Image: this.managerImageId,
      User: 'root',
      Cmd: ['node', '/verify/entry.mjs', 'docker-proxy'],
      Env: [
        `VERIFY_RUN_ID=${this.runId}`,
        `VERIFY_INSTANCE_PREFIX=${this.instancePrefix}`,
        `VERIFY_MANAGER_NAME=${this.managerName}`,
        `VERIFY_NODE_IMAGE_ID=${this.nodeImageId}`,
        `VERIFY_SUBNET_PREFIX=10.${this.subnetSecondOctet + 1}`,
      ],
      HostConfig: {
        NetworkMode: this.controlNetworkId,
        ReadonlyRootfs: true,
        Binds: [
          `${ENTRY_PATH}:/verify/entry.mjs:ro`,
          '/var/run/docker.sock:/var/run/docker.sock:ro',
        ],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {},
    }, this.proxyName);
    this.proxyId = created.id;
    await created.container.start();
    await waitFor('verifier Docker proxy', async () => {
      const info = await created.container.inspect();
      if (!info.State.Running) throw new Error('Docker proxy exited');
      const logs = (await created.container.logs({ stdout: true, stderr: true })).toString('utf8');
      return logs.includes('[verify-proxy] ready');
    }, { timeoutMs: 30_000 });
  }

  managerEnvironment() {
    return [
      `MASTER_KEY=${this.master}`,
      `EXTERNAL_URL=http://127.0.0.1:${this.hostPort}`,
      'LISTEN_ADDR=0.0.0.0',
      'LISTEN_PORT=19100',
      `EDGE_DATA_ROOT=${this.dataRoot}`,
      `DATA_DIR=${join(this.dataRoot, 'manager')}`,
      `INSTANCE_DATA_ROOT=${join(this.dataRoot, 'instances')}`,
      `DOCKER_HOST=tcp://${this.proxyName}:2375`,
      `MANAGER_CONTAINER=${this.managerName}`,
      `INSTANCE_NETWORK=${this.networkPrefix}`,
      'NODE_RED_IMAGE_REPO=nodered/node-red',
      'ALLOWED_IMAGE_TAGS=5.0.4-24-minimal',
      'EDGE_NODE_INSTALL_POLICY=allowlist',
      'EDGE_NPM_UPSTREAM=',
      'EDGE_METRICS_INTERVAL_SEC=0',
      'EDGE_HISTORY_MAX_ROWS=100000',
      'EDGE_HISTORY_MIN_GAP_SEC=0',
      'EDGE_SPOOL_MAX_BYTES=16777216',
      'NODE_ENV=production',
      'NODE_SEED_DIR=/app/npm-seed',
      'TLE_NODE_PACKAGE_DIR=/app/nodes',
      'WEB_ROOT=/app/web',
      'TZ=UTC',
    ];
  }

  async stopManager(remove = true) {
    if (!this.managerId) return;
    const id = this.managerId;
    const ref = raw.getContainer(id);
    const info = await ref.inspect().catch(() => undefined);
    if (info?.State.Running) await ref.stop({ t: 5 }).catch(() => undefined);
    if (remove) await this.resources.removeContainer(id);
    this.managerId = undefined;
  }

  async startManager(mode, recoveryTimeoutMs = 90_000) {
    assert.ok(mode === 'barrier' || mode === 'normal');
    await this.stopManager(true);
    this.hostPort ??= await freePort();
    const binds = [`${this.dataRoot}:${this.dataRoot}`];
    const options = {
      Image: this.managerImageId,
      Env: this.managerEnvironment(),
      ExposedPorts: { '19100/tcp': {} },
      HostConfig: {
        NetworkMode: this.controlNetworkId,
        ReadonlyRootfs: true,
        Binds: binds,
        PortBindings: { '19100/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.hostPort) }] },
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {},
    };
    if (mode === 'barrier') {
      options.Cmd = ['node', '/verify/entry.mjs', 'manager'];
      options.Env.push(`VERIFY_CONTROL_DIR=${this.controlRoot}`);
      options.HostConfig.Binds.push(
        `${ENTRY_PATH}:/verify/entry.mjs:ro`,
        `${this.controlRoot}:${this.controlRoot}`,
      );
    }
    const created = await this.createContainer(options, this.managerName);
    this.managerId = created.id;
    await created.container.start();
    const startedAt = Date.now();
    await waitFor(`Manager ${mode} health`, async () => {
      const info = await created.container.inspect();
      if (!info.State.Running) {
        const logs = (await created.container.logs({ stdout: true, stderr: true })).toString('utf8');
        throw new Error(`Manager exited: ${logs.slice(-1200)}`);
      }
      const response = await fetch(`http://127.0.0.1:${this.hostPort}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      }).catch(() => undefined);
      return response?.status === 200;
    }, { timeoutMs: recoveryTimeoutMs, intervalMs: 200 });
    if (this.session) await this.loginSession();
    return Date.now() - startedAt;
  }

  async api(path, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.auth !== false && this.session) {
      headers.cookie = this.session.cookie;
      if (options.csrf !== false && (options.method ?? 'GET') !== 'GET') {
        headers['x-csrf-token'] = this.session.csrf;
      }
    }
    try {
      const response = await fetch(`http://127.0.0.1:${this.hostPort}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      return { status: response.status, body, headers: response.headers };
    } catch (error) {
      return { status: 0, error };
    }
  }

  async setupSession() {
    const before = await this.api('/api/setup', { auth: false, csrf: false });
    assert.equal(before.status, 200);
    assert.equal(before.body.needed, true);
    const setup = await this.api('/api/setup', {
      method: 'POST', auth: false, csrf: false,
      body: { username: 'admin', password: this.adminPassword },
    });
    assert.equal(setup.status, 200);
    this.captureSession(setup.headers);
    const me = await this.api('/api/me', { csrf: false });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'admin');
    const csrfDenied = await this.api('/api/instances', {
      method: 'POST', csrf: false,
      body: { id: this.id('csrf'), name: 'denied', imageTag: '5.0.4-24-minimal' },
    });
    assert.equal(csrfDenied.status, 403);
    const state = await this.api('/api/setup', { auth: false, csrf: false });
    assert.equal(state.body.needed, false);
  }

  captureSession(headers) {
    const setCookies = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? ''];
    const pairs = setCookies.flatMap((line) => line.split(/,(?=\s*[^;,]+=)/))
      .map((line) => line.split(';', 1)[0].trim()).filter(Boolean);
    const cookieValues = new Map(pairs.map((pair) => {
      const split = pair.indexOf('=');
      return [pair.slice(0, split), pair.slice(split + 1)];
    }));
    assert.ok(cookieValues.get('tle_sid') && cookieValues.get('tle_csrf'));
    this.session = {
      cookie: [...cookieValues].map(([name, value]) => `${name}=${value}`).join('; '),
      csrf: cookieValues.get('tle_csrf'),
    };
  }

  async loginSession() {
    const login = await this.api('/api/login', {
      method: 'POST', auth: false, csrf: false,
      body: { username: 'admin', password: this.adminPassword },
    });
    assert.equal(login.status, 200, 'Manager restart login failed');
    assert.equal(login.body.user?.username, 'admin');
    this.captureSession(login.headers);
  }

  readyFiles() {
    return readdirSync(this.controlRoot)
      .filter((name) => name.endsWith('.ready.json'))
      .sort();
  }

  releaseBarrier(file, envelope, action) {
    const release = join(this.controlRoot, file.replace(/\.ready\.json$/, '.release.json'));
    const command = action.action === 'throw'
      ? { version: 1, event: envelope.event, action: 'throw', code: action.code }
      : { version: 1, event: envelope.event, action: 'continue' };
    writeDurableJson(release, command);
  }

  async barrierApi(path, requestOptions, decide = () => ({ action: 'continue' })) {
    let finished = false;
    let outcome;
    const request = this.api(path, requestOptions).then((value) => {
      outcome = value;
      finished = true;
    });
    const events = [];
    const deadline = Date.now() + (requestOptions.timeoutMs ?? 180_000);
    while (!finished && Date.now() < deadline) {
      const fresh = this.readyFiles().filter((file) => !this.knownReady.has(file));
      for (const file of fresh) {
        this.knownReady.add(file);
        const envelope = JSON.parse(readFileSync(join(this.controlRoot, file), 'utf8'));
        assert.equal(envelope.version, 1);
        events.push(envelope.event);
        const action = await decide(envelope.event, events);
        if (action.action === 'kill') {
          const ref = raw.getContainer(this.managerId);
          await ref.kill({ signal: 'SIGKILL' });
          continue;
        }
        this.releaseBarrier(file, envelope, action);
      }
      await sleep(25);
    }
    await request;
    assert.ok(finished, `barrier API ${path} timed out`);
    return { response: outcome, events };
  }

  fixture(label) {
    const fixture = this.fixtures.find((item) => item.label === label);
    assert.ok(fixture, `fixture ${label} missing`);
    return fixture;
  }

  database() {
    return new Database(join(this.dataRoot, 'manager', 'edge.db'), { readonly: true });
  }

  async migrationStatus(id) {
    const response = await this.api(`/api/instances/${id}/nodes/thinglinks-migration`, {
      csrf: false,
    });
    assert.equal(response.status, 200, `migration status ${id}`);
    return response.body;
  }

  async inventory(id) {
    const response = await this.api(`/api/nodes/inventory/${id}`, { csrf: false });
    assert.equal(response.status, 200, `inventory ${id}: ${JSON.stringify(response.body).slice(0, 200)}`);
    return response.body;
  }

  assertHealthyInventory(inventory) {
    assert.equal(inventory.ok, true);
    assert.equal(inventory.health, 'healthy');
    assert.deepEqual(inventory.conflicts, []);
    const edge = inventory.modules.filter((entry) => entry.module === PLATFORM_NODE_PACKAGE.name);
    assert.equal(edge.length, 1);
    assert.equal(edge[0].version, PLATFORM_NODE_PACKAGE.version);
    assert.equal(edge[0].source, 'npm');
    assert.equal(edge[0].health, 'healthy');
    assert.deepEqual([...edge[0].types].sort(), [...PLATFORM_NODE_TYPES].sort());
    assert.equal(edge[0].nodeSets.length, 3);
    assert.ok(edge[0].nodeSets.every((set) => set.enabled === true && set.err === ''));
    assert.equal(inventory.modules.some((entry) => entry.module === PLATFORM_COMMON_PACKAGE.name), false);
    const owners = inventory.modules.filter((entry) => (
      entry.types.some((type) => PLATFORM_NODE_TYPES.includes(type))
    ));
    assert.deepEqual(owners.map((entry) => entry.module), [PLATFORM_NODE_PACKAGE.name]);
  }

  async assertInstalledFiles(id) {
    await verifyInstalledPlatformFiles({
      instanceDataRoot: join(this.dataRoot, 'instances'),
      instanceId: id,
      readFile: (path, encoding) => Promise.resolve(readFileSync(path, encoding)),
    });
    const root = join(this.dataRoot, 'instances', id);
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    assert.ok([
      PLATFORM_NODE_PACKAGE.version, `~${PLATFORM_NODE_PACKAGE.version}`,
    ].includes(packageJson.dependencies[PLATFORM_NODE_PACKAGE.name]));
    assert.equal(Object.hasOwn(packageJson.dependencies, PLATFORM_COMMON_PACKAGE.name), false);
    assert.equal(
      lock.packages[`node_modules/${PLATFORM_NODE_PACKAGE.name}`].integrity,
      PLATFORM_NODE_PACKAGE.integrity,
    );
    assert.equal(
      lock.packages[`node_modules/${PLATFORM_COMMON_PACKAGE.name}`].integrity,
      PLATFORM_COMMON_PACKAGE.integrity,
    );
  }

  async currentContainer(id) {
    return raw.getContainer(containerName(id)).inspect();
  }

  async assertInternalInstance(id) {
    const info = await this.currentContainer(id);
    const networkIds = Object.values(info.NetworkSettings.Networks ?? {})
      .map((network) => network.NetworkID);
    assert.ok(networkIds.length >= 1);
    for (const networkId of networkIds) {
      const network = await raw.getNetwork(networkId).inspect();
      assert.equal(network.Internal, true, `${network.Name} permits egress`);
      assert.equal(network.Labels?.[RUN_LABEL], this.runId);
    }
  }

  assertFixtureSnapshot(id, expectedRunning) {
    const expected = this.initialSnapshots.get(id);
    assert.ok(expected);
    const root = join(this.dataRoot, 'instances', id);
    assert.equal(sha256(readFileSync(join(root, 'settings.js'))), expected.settings);
    assert.equal(sha256(readFileSync(join(root, 'flows.json'))), expected.flows);
    assert.equal(sha256(readFileSync(join(root, 'flows_cred.json'))), expected.credentials);
    assert.equal(sha256(readFileSync(join(root, 'package.json'))), expected.packageManifest);
    assert.equal(sha256(readFileSync(join(root, 'package-lock.json'))), expected.lock);
    assert.equal(treeHash(join(root, 'nodes')), expected.raw);
    return this.currentContainer(id).then((info) => assert.equal(info.State.Running, expectedRunning));
  }

  assertPreservedFlowCredentials(id) {
    const expected = this.initialSnapshots.get(id);
    assert.ok(expected);
    const root = join(this.dataRoot, 'instances', id);
    assert.equal(sha256(readFileSync(join(root, 'flows.json'))), expected.flows);
    assert.equal(sha256(readFileSync(join(root, 'flows_cred.json'))), expected.credentials);
    assert.equal(treeHash(join(root, 'nodes')), expected.raw);
  }

  async createNewInstanceSuccess() {
    const id = this.id('newapi');
    const liveRoot = join(this.dataRoot, 'instances', id);
    const operation = await this.barrierApi('/api/instances', {
      method: 'POST',
      body: {
        id, name: 'Task 11 new API', imageTag: '5.0.4-24-minimal',
        memoryMb: 256, cpus: 0.5, ports: [],
      },
    });
    assert.equal(operation.response.status, 201, JSON.stringify(operation.response.body));
    assert.deepEqual(operation.events.map((event) => [event.sequence, event.boundary]), [
      [1, 'after-phase-persist'], [2, 'after-container-create'],
    ]);
    const status = await this.migrationStatus(id);
    assert.deepEqual(
      { phase: status.phase, runtimeMode: status.runtimeMode, version: status.platformVersion },
      { phase: 'committed', runtimeMode: 'npm', version: PLATFORM_NODE_PACKAGE.version },
    );
    this.assertHealthyInventory(await this.inventory(id));
    await this.assertInstalledFiles(id);
    const root = liveRoot;
    assert.equal(existsSync(join(root, 'nodes')), false, 'new npm instance received legacy raw nodes');
    const info = await this.currentContainer(id);
    const env = new Map(info.Config.Env.map((entry) => entry.split(/=(.*)/s, 2)));
    assert.equal(env.get('TLE_INSTANCE_ID'), id);
    assert.equal(env.get('TLE_MANAGER_URL'), `http://${this.managerName}:19100`);
    assert.ok(env.get('TLE_INGEST_TOKEN'));
    assert.equal(env.get('NPM_CONFIG_REGISTRY'), `http://${this.managerName}:19100/npm/`);
    await this.assertInternalInstance(id);
    const internal = await execIn(info.Id, [
      'node', '-e',
      `fetch('http://${this.managerName}:19100/npm/${encodeURIComponent(PLATFORM_NODE_PACKAGE.name)}')`
        + '.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
    ]).catch((error) => { throw new Error(`internal registry probe: ${safeError(error)}`); });
    assert.equal(internal.code, 0, 'private registry unavailable inside instance');
    const external = await execIn(info.Id, [
      'node', '-e',
      "const t=setTimeout(()=>process.exit(0),2000);"
        + "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(1500)})"
        + '.then(()=>{clearTimeout(t);process.exit(1)})'
        + '.catch(()=>{clearTimeout(t);process.exit(0)})',
    ], 6_000).catch((error) => { throw new Error(`external egress probe: ${safeError(error)}`); });
    assert.equal(external.code, 0, 'instance unexpectedly has external egress');
    this.newInstanceId = id;
    pass('new-instance-api', {
      status: 'committed', version: PLATFORM_NODE_PACKAGE.version,
      edgeIntegrity: PLATFORM_NODE_PACKAGE.integrity,
      commonIntegrity: PLATFORM_COMMON_PACKAGE.integrity,
      nodeImageId: this.nodeImageId,
    });
  }

  async createNewInstanceCompensation() {
    const id = this.id('newfail');
    let injected = false;
    const operation = await this.barrierApi('/api/instances', {
      method: 'POST',
      body: {
        id, name: 'Task 11 compensation', imageTag: '5.0.4-24-minimal',
        memoryMb: 256, cpus: 0.5, ports: [],
      },
    }, (event) => {
      if (event.boundary === 'after-container-create') {
        injected = true;
        return { action: 'throw', code: 'VERIFY_BOOTSTRAP_THROW' };
      }
      return { action: 'continue' };
    });
    assert.equal(injected, true);
    assert.equal(operation.response.status, 400);
    assert.match(operation.response.body.error, /创建实例失败（install），已完成补偿清理/);
    assert.equal(await raw.getContainer(containerName(id)).inspect().then(() => true).catch(() => false), false);
    assert.equal(await raw.getNetwork(`${this.networkPrefix}-${id}`).inspect()
      .then(() => true).catch(() => false), false);
    assert.equal(existsSync(join(this.dataRoot, 'instances', id)), false);
    const detail = await this.api(`/api/instances/${id}`, { csrf: false });
    assert.equal(detail.status, 404);
    const db = this.database();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instance WHERE id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instance_node_migration WHERE instance_id = ?').get(id).n, 0);
    db.close();
    const store = await this.api('/api/nodes/store', { csrf: false });
    assert.equal(store.status, 200);
    assert.ok(store.body.packages.some((entry) => entry.module === PLATFORM_NODE_PACKAGE.name));
    assert.ok(store.body.packages.some((entry) => entry.module === PLATFORM_COMMON_PACKAGE.name));
    pass('new-instance-compensation', { apiStatus: 400, residuals: [] });
  }

  async migrateFixture(label, decide) {
    const fixture = this.fixture(label);
    return this.barrierApi(
      `/api/instances/${fixture.id}/nodes/thinglinks-migration`,
      { method: 'POST', body: {} },
      decide,
    );
  }

  async fixtureAdminRequest(label, path, options = {}) {
    const fixture = this.fixture(label);
    const password = secret(this.master, `node-password:${fixture.id}`, 28);
    const root = `/red/${fixture.id}/`;
    const script = `(async()=>{
      const login=await fetch('http://127.0.0.1:1880${root}auth/token',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          client_id:'node-red-editor',grant_type:'password',scope:'*',
          username:'admin',password:${JSON.stringify(password)}
        })
      });
      const auth=await login.json();
      const response=await fetch('http://127.0.0.1:1880${root}${path}',{
        method:${JSON.stringify(options.method ?? 'GET')},
        headers:{accept:'application/json',authorization:'Bearer '+auth.access_token,
          'content-type':'application/json'},
        ${options.body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(options.body)}),`}
      });
      console.log('TLE_RESULT:'+JSON.stringify({status:response.status,body:await response.text()}));
    })().catch(e=>{console.error('TLE_ERROR:'+e.message);process.exit(1)});`;
    const id = (await this.currentContainer(fixture.id)).Id;
    const result = await execIn(id, ['node', '-e', script], 120_000);
    assert.equal(result.code, 0, result.output.slice(-500));
    const line = result.output.replace(/\r/g, '').split('\n')
      .find((entry) => entry.startsWith('TLE_RESULT:'));
    assert.ok(line);
    return JSON.parse(line.slice('TLE_RESULT:'.length));
  }

  async verifyLegacySuccesses() {
    const running = this.fixture('runok');
    const runningResult = await this.migrateFixture('runok');
    assert.equal(runningResult.response.status, 200);
    if (runningResult.response.body.phase !== 'committed') {
      const db = this.database();
      const journal = db.prepare(
        `SELECT phase, error, original_running AS originalRunning, staged_before AS stagedBefore
         FROM instance_node_migration WHERE instance_id = ?`,
      ).get(running.id);
      const audit = db.prepare(
        'SELECT action, result, detail FROM audit WHERE target = ? ORDER BY id DESC LIMIT 4',
      ).all(running.id);
      db.close();
      const managerLogs = dockerLogText(await raw.getContainer(this.managerId)
        .logs({ stdout: true, stderr: true, tail: 120 }));
      const allNodeLogs = dockerLogText(await raw.getContainer(containerName(running.id))
        .logs({ stdout: true, stderr: true, tail: 300 }));
      const nodeLogs = allNodeLogs.split('\n').filter((line) => (
        /error|warn|install|module|palette|register/i.test(line)
      )).slice(-30).join(' | ');
      throw new Error(`running migration ${runningResult.response.body.phase}: journal=${JSON.stringify(journal)}`
        + ` audit=${JSON.stringify(audit)} events=${runningResult.events.map((event) => `${event.phase}/${event.boundary}`).join(',')}`
        + ` node=${nodeLogs.slice(-3500)} manager=${managerLogs.slice(-300)}`);
    }
    assert.equal(runningResult.response.body.phase, 'committed');
    this.assertPreservedFlowCredentials(running.id);
    this.assertHealthyInventory(await this.inventory(running.id));
    await this.assertInstalledFiles(running.id);
    assert.equal((await this.currentContainer(running.id)).State.Running, true);
    pass('legacy-running-api', {
      phases: runningResult.events.filter((event) => event.boundary === 'after-phase-persist')
        .map((event) => event.phase),
    });

    const stopped = this.fixture('stopok');
    const stoppedResult = await this.migrateFixture('stopok');
    assert.equal(stoppedResult.response.status, 200);
    assert.equal(stoppedResult.response.body.phase, 'pending_start_verification');
    assert.equal((await this.currentContainer(stopped.id)).State.Running, false);
    this.assertPreservedFlowCredentials(stopped.id);
    const start = await this.barrierApi(`/api/instances/${stopped.id}/start`, {
      method: 'POST', body: {},
    });
    assert.equal(start.response.status, 204);
    const status = await this.migrationStatus(stopped.id);
    assert.equal(status.phase, 'committed');
    assert.equal(status.runtimeMode, 'npm');
    assert.equal((await this.currentContainer(stopped.id)).State.Running, true);
    this.assertPreservedFlowCredentials(stopped.id);
    this.assertHealthyInventory(await this.inventory(stopped.id));
    await this.assertInstalledFiles(stopped.id);
    pass('legacy-stopped-api', {
      parked: true, explicitStart: true,
      phases: [...stoppedResult.events, ...start.events]
        .filter((event) => event.boundary === 'after-phase-persist').map((event) => event.phase),
    });
  }

  async verifySameImageAndStagedBefore() {
    const same = this.fixture('sameok');
    const oldId = (await this.currentContainer(same.id)).Id;
    const operation = await this.migrateFixture('sameok');
    assert.equal(operation.response.status, 200);
    assert.equal(operation.response.body.phase, 'committed',
      `sameok response ${JSON.stringify(operation.response.body)}`);
    const rebuilt = await this.currentContainer(same.id);
    assert.notEqual(rebuilt.Id, oldId);
    assert.equal(rebuilt.Image, this.nodeImageId);
    assert.ok(operation.events.some((event) => (
      event.sequence === 0 && event.phase === 'preparing'
      && event.boundary === 'after-same-image-rebuild'
    )));
    this.assertPreservedFlowCredentials(same.id);

    const rejected = this.fixture('samethrow');
    const rejectedOldId = (await this.currentContainer(rejected.id)).Id;
    const thrown = await this.migrateFixture('samethrow', (event) => (
      event.boundary === 'after-same-image-rebuild'
        ? { action: 'throw', code: 'VERIFY_SAME_IMAGE_THROW' }
        : { action: 'continue' }
    ));
    assert.equal(thrown.response.status, 409);
    assert.equal(thrown.response.body.code, 'preflight');
    const rejectedNew = await this.currentContainer(rejected.id);
    assert.notEqual(rejectedNew.Id, rejectedOldId);
    assert.equal(rejectedNew.State.Running, true);
    const db = this.database();
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS n FROM instance_node_migration WHERE instance_id = ?',
    ).get(rejected.id).n, 0);
    assert.deepEqual(db.prepare(
      `SELECT node_runtime_mode AS mode, node_migration_state AS phase
       FROM instance WHERE id = ?`,
    ).get(rejected.id), { mode: 'legacy', phase: 'idle' });
    db.close();
    this.assertPreservedFlowCredentials(rejected.id);

    const staged = this.fixture('staged');
    const root = join(this.dataRoot, 'instances', staged.id, 'node_modules', '@mqttsnet');
    const edgeBefore = treeHash(join(root, 'thinglinks-edge-nodes'));
    const commonBefore = treeHash(join(root, 'thinglinks-node-red-common'));
    const stagedResult = await this.migrateFixture('staged');
    if (stagedResult.response.body.phase !== 'committed') {
      const diagnosticInventory = await this.inventory(staged.id).catch((error) => ({
        error: safeError(error),
      }));
      let fileEvidence = 'pass';
      try { await this.assertInstalledFiles(staged.id); } catch (error) { fileEvidence = safeError(error); }
      const logs = dockerLogText(await raw.getContainer(containerName(staged.id))
        .logs({ stdout: true, stderr: true, tail: 200 }));
      throw new Error(`staged fixture preflight: response=${JSON.stringify(stagedResult.response.body)}`
        + ` files=${fileEvidence} inventory=${JSON.stringify(diagnosticInventory)}`
        + ` logs=${logs.split('\n').filter((line) => /already registered|error|warn/i.test(line)).join(' | ')}`);
    }
    assert.equal(stagedResult.response.body.phase, 'committed',
      `staged response ${JSON.stringify(stagedResult.response.body)}`);
    assert.equal(treeHash(join(root, 'thinglinks-edge-nodes')), edgeBefore);
    assert.equal(treeHash(join(root, 'thinglinks-node-red-common')), commonBefore);
    const stagedDb = this.database();
    assert.equal(stagedDb.prepare(
      'SELECT staged_before FROM instance_node_migration WHERE instance_id = ?',
    ).get(staged.id).staged_before, 1);
    stagedDb.close();
    await this.assertInstalledFiles(staged.id);
    pass('same-image-rebuild', {
      successBoundary: true, throwBoundary: true, noJournalOnThrow: true,
      stagedBefore: true,
    });
  }

  async assertRolledBack(label, originalRunning) {
    const fixture = this.fixture(label);
    const status = await this.migrationStatus(fixture.id);
    assert.equal(status.phase, 'rolled_back', `${label} phase`);
    assert.equal(status.runtimeMode, 'legacy', `${label} mode`);
    assert.equal(status.error, 'none', `${label} error`);
    await this.assertFixtureSnapshot(fixture.id, originalRunning);
    const db = this.database();
    const journal = db.prepare(
      `SELECT checkpoint_dir AS checkpointDir, original_running AS originalRunning
       FROM instance_node_migration WHERE instance_id = ?`,
    ).get(fixture.id);
    assert.equal(Boolean(journal.originalRunning), originalRunning);
    assert.equal(existsSync(join(this.dataRoot, 'instances', journal.checkpointDir)), false);
    db.close();
  }

  async verifyRollbackInjections() {
    const observed = [];
    const running = await this.migrateFixture('rset', (event) => {
      if (event.boundary === 'after-settings-write') {
        observed.push('running:settings');
        return { action: 'throw', code: 'VERIFY_SETTINGS_THROW' };
      }
      return { action: 'continue' };
    });
    assert.equal(running.response.status, 200);
    await this.assertRolledBack('rset', true);

    const stoppedSettings = await this.migrateFixture('sset', (event) => {
      if (event.boundary === 'after-settings-write') {
        observed.push('stopped-probe:settings');
        return { action: 'throw', code: 'VERIFY_SETTINGS_THROW' };
      }
      return { action: 'continue' };
    });
    assert.equal(stoppedSettings.response.status, 200);
    await this.assertRolledBack('sset', false);

    const scout = await this.migrateFixture('sscout');
    assert.equal(scout.response.body.phase, 'pending_start_verification');
    const liveBoundaries = scout.events.filter((event) => (
      event.boundary === 'after-live-backup' || event.boundary === 'after-live-rename'
    ));
    assert.ok(liveBoundaries.length >= 7, `too few stopped live boundaries: ${liveBoundaries.length}`);
    const identities = new Set(liveBoundaries.map((event) => (
      `${event.sequence}:${event.boundary}:${event.artifact}`
    )));
    assert.equal(identities.size, liveBoundaries.length, 'stopped boundary identities repeated');
    const emittedKinds = new Set(liveBoundaries.map((event) => (
      `${event.boundary}:${event.artifact}`
    )));
    for (const required of [
      'after-live-backup:settings', 'after-live-rename:settings',
      'after-live-backup:package-manifest', 'after-live-rename:package-manifest',
      'after-live-backup:package-lock', 'after-live-rename:package-lock',
      'after-live-backup:node-config', 'after-live-rename:node-config',
      // Canonical module-config bytes are identical, so that artifact has no live mutation.
      'after-live-rename:edge-module', 'after-live-rename:common-module',
    ]) assert.ok(emittedKinds.has(required), `missing stopped boundary ${required}`);
    const scoutStart = await this.barrierApi(`/api/instances/${this.fixture('sscout').id}/start`, {
      method: 'POST', body: {},
    });
    assert.equal(scoutStart.response.status, 204);

    assert.ok(liveBoundaries.length <= 20, 'stopped boundary fixture pool exhausted');
    for (const [index, target] of liveBoundaries.entries()) {
      const label = `sb${String(index).padStart(2, '0')}`;
      let injected = false;
      const operation = await this.migrateFixture(label, (event) => {
        if (
          event.sequence === target.sequence
          && event.boundary === target.boundary
          && event.artifact === target.artifact
        ) {
          injected = true;
          return { action: 'throw', code: 'VERIFY_STOPPED_THROW' };
        }
        return { action: 'continue' };
      });
      assert.equal(injected, true, `boundary not reached ${JSON.stringify(target)}`);
      assert.equal(operation.response.status, 200);
      await this.assertRolledBack(label, false);
      observed.push(`stopped:${target.sequence}:${target.boundary}:${target.artifact}`);
    }
    pass('rollback-injected', {
      runningSettings: true,
      stoppedProbeSettings: true,
      stoppedLiveBoundaries: liveBoundaries.map((event) => ({
        sequence: event.sequence, boundary: event.boundary, artifact: event.artifact,
      })),
      observed,
    });
  }

  async crashAt(label, decide) {
    const operation = await this.migrateFixture(label, decide);
    assert.equal(operation.response.status, 0, `${label} crash request did not disconnect`);
    assert.equal((await raw.getContainer(this.managerId).inspect()).State.Running, false);
    return operation.events;
  }

  async recoverNormalAndReturnToBarrier(expectedMinimumMs = 5_000) {
    const elapsed = await this.startManager('normal', 120_000);
    assert.ok(elapsed >= expectedMinimumMs, `recovery readiness was not fenced (${elapsed}ms)`);
    return elapsed;
  }

  phaseCrashDecision(targetPhase) {
    return (event) => (
      event.boundary === 'after-phase-persist' && event.phase === targetPhase
        ? { action: 'kill' }
        : { action: 'continue' }
    );
  }

  rollbackCrashDecision(event) {
    if (event.boundary === 'after-phase-persist' && event.phase === 'checkpointed') {
      return { action: 'throw', code: 'VERIFY_ROLLBACK_THROW' };
    }
    if (event.boundary === 'after-phase-persist' && event.phase === 'rolling_back') {
      return { action: 'kill' };
    }
    return { action: 'continue' };
  }

  async verifyRunningRecovery() {
    const cases = [
      ['rr-prep', 'preparing'],
      ['rr-check', 'checkpointed'],
      ['rr-stage', 'staged'],
      ['rr-cut', 'cutover'],
      ['rr-verify', 'verifying'],
      ['rr-roll', 'rolling_back'],
    ];
    const evidence = [];
    for (const [label, phase] of cases) {
      const events = await this.crashAt(
        label,
        phase === 'rolling_back'
          ? (event) => this.rollbackCrashDecision(event)
          : this.phaseCrashDecision(phase),
      );
      assert.ok(events.some((event) => (
        event.boundary === 'after-phase-persist' && event.phase === phase
      )));
      const elapsed = await this.recoverNormalAndReturnToBarrier();
      // HTTP readiness is observed only after startup recovery published terminal state.
      await this.assertRolledBack(label, true);
      evidence.push({ phase, elapsedMs: elapsed });
      await this.startManager('barrier');
    }
    pass('interrupted-recovery-running', { cases: evidence });
  }

  async verifyStoppedRecovery() {
    const rollbackCases = [
      ['rs-prep', 'preparing'],
      ['rs-check', 'checkpointed'],
      ['rs-stage', 'staged'],
      ['rs-cut', 'cutover'],
      ['rs-roll', 'rolling_back'],
    ];
    const evidence = [];
    for (const [label, phase] of rollbackCases) {
      await this.crashAt(
        label,
        phase === 'rolling_back'
          ? (event) => this.rollbackCrashDecision(event)
          : this.phaseCrashDecision(phase),
      );
      const elapsed = await this.recoverNormalAndReturnToBarrier();
      await this.assertRolledBack(label, false);
      evidence.push({ phase, elapsedMs: elapsed, final: 'rolled_back' });
      await this.startManager('barrier');
    }

    const pending = this.fixture('rs-pend');
    await this.crashAt('rs-pend', this.phaseCrashDecision('pending_start_verification'));
    const pendingElapsed = await this.startManager('normal', 60_000);
    const pendingStatus = await this.migrationStatus(pending.id);
    assert.equal(pendingStatus.phase, 'pending_start_verification');
    assert.equal((await this.currentContainer(pending.id)).State.Running, false);
    const pendingStart = await this.api(`/api/instances/${pending.id}/start`, {
      method: 'POST', body: {},
    });
    assert.equal(pendingStart.status, 204);
    assert.equal((await this.migrationStatus(pending.id)).phase, 'committed');
    this.assertPreservedFlowCredentials(pending.id);
    evidence.push({
      phase: 'pending_start_verification', elapsedMs: pendingElapsed,
      final: 'committed-after-explicit-start',
    });
    await this.startManager('barrier');

    const verifying = this.fixture('rs-verify');
    const parked = await this.migrateFixture('rs-verify');
    assert.equal(parked.response.body.phase, 'pending_start_verification');
    const startCrash = await this.barrierApi(`/api/instances/${verifying.id}/start`, {
      method: 'POST', body: {},
    }, this.phaseCrashDecision('verifying'));
    assert.equal(startCrash.response.status, 0);
    assert.ok(startCrash.events.some((event) => event.phase === 'verifying'));
    const verifyElapsed = await this.recoverNormalAndReturnToBarrier();
    await this.assertRolledBack('rs-verify', false);
    evidence.push({ phase: 'verifying', elapsedMs: verifyElapsed, final: 'rolled_back' });
    await this.startManager('barrier');

    pass('interrupted-recovery-stopped', { cases: evidence });
  }

  async startRouteProxy(instanceId) {
    const info = await this.currentContainer(instanceId);
    const network = Object.values(info.NetworkSettings.Networks ?? {})[0];
    assert.ok(network?.NetworkID);
    this.routeLog = join(this.resultsRoot, 'manager-routes.ndjson');
    writeFileSync(this.routeLog, '', { mode: 0o666 });
    chmodSync(this.routeLog, 0o666);
    this.routeProxyName = `${this.runId}-route-proxy`;
    const created = await this.createContainer({
      Image: this.managerImageId,
      User: 'node',
      Cmd: ['node', '/verify/entry.mjs', 'route-proxy'],
      Env: [
        `VERIFY_ROUTE_UPSTREAM=http://${this.managerName}:19100`,
        `VERIFY_ROUTE_LOG=${this.routeLog}`,
      ],
      HostConfig: {
        NetworkMode: network.NetworkID,
        ReadonlyRootfs: true,
        Binds: [
          `${ENTRY_PATH}:/verify/entry.mjs:ro`,
          `${this.resultsRoot}:${this.resultsRoot}`,
        ],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {},
    }, this.routeProxyName);
    this.routeProxyId = created.id;
    await created.container.start();
    await waitFor('transparent route proxy', async () => {
      const logs = (await created.container.logs({ stdout: true, stderr: true })).toString('utf8');
      return logs.includes('[verify-route-proxy] ready');
    }, { timeoutMs: 30_000 });
    return network.NetworkID;
  }

  async deployFlows(instanceId, flows) {
    const response = await this.api(`/api/instances/${instanceId}/flows`, {
      method: 'POST', body: { flows }, timeoutMs: 60_000,
    });
    assert.equal(response.status, 200, `flow deploy failed: ${JSON.stringify(response.body).slice(0, 300)}`);
    assert.equal(response.body.applied, true);
    return response.body;
  }

  async cloneManagedData(instanceId, targetRoot) {
    const stop = await this.api(`/api/instances/${instanceId}/stop`, { method: 'POST', body: {} });
    assert.equal(stop.status, 204);
    assert.equal((await this.currentContainer(instanceId)).State.Running, false);
    cpSync(join(this.dataRoot, 'instances', instanceId), targetRoot, {
      recursive: true, force: false, errorOnExist: true,
    });
    makeTreeWritable(targetRoot);
    const start = await this.api(`/api/instances/${instanceId}/start`, { method: 'POST', body: {} });
    assert.equal(start.status, 204);
    assert.equal((await this.currentContainer(instanceId)).State.Running, true);
  }

  async renderHarness(targetRoot, allowEdge) {
    const logs = await this.runOneShot('render-harness-settings', {
      EDGE_DATA_ROOT: this.dataRoot,
      MASTER_KEY: this.master,
      VERIFY_SOURCE_INSTANCE: this.newInstanceId,
      VERIFY_HARNESS_ROOT: targetRoot,
      VERIFY_ALLOW_EDGE: allowEdge ? 'true' : 'false',
    }, [
      `${this.dataRoot}:${this.dataRoot}`,
      `${targetRoot}:${targetRoot}`,
    ], 'root');
    assert.match(logs, new RegExp(`harness-settings:${allowEdge ? 'allow' : 'deny'}`));
    const settings = readFileSync(join(targetRoot, 'settings.js'), 'utf8');
    assert.match(settings, /denyList:\s*\["\*"\]/);
    for (const file of ['tl-device.js', 'tl-tag.js', 'tl-uplink.js']) {
      assert.ok(settings.includes(file), `${file} raw exclude missing`);
    }
    assert.equal(
      settings.includes(`${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`),
      allowEdge,
    );
  }

  async startHarness(targetRoot, networkId) {
    if (this.harnessId) await this.resources.removeContainer(this.harnessId);
    this.harnessName = `${this.runId}-node-red-harness`;
    const token = (await this.currentContainer(this.newInstanceId)).Config.Env
      .find((entry) => entry.startsWith('TLE_INGEST_TOKEN='))?.slice('TLE_INGEST_TOKEN='.length);
    assert.ok(token);
    const created = await this.createContainer({
      Image: this.nodeImageId,
      User: 'node-red',
      Env: [
        'TZ=UTC',
        `TLE_INSTANCE_ID=${this.newInstanceId}`,
        `TLE_MANAGER_URL=http://${this.routeProxyName}:3000`,
        `TLE_INGEST_TOKEN=${token}`,
        `NPM_CONFIG_REGISTRY=http://${this.managerName}:19100/npm/`,
        'NPM_CONFIG_STRICT_SSL=false',
      ],
      HostConfig: {
        NetworkMode: networkId,
        ReadonlyRootfs: true,
        Binds: [`${targetRoot}:/data`, `${this.resultsRoot}:/results`],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {},
    }, this.harnessName);
    this.harnessId = created.id;
    const inspected = await created.container.inspect();
    const environment = new Map(inspected.Config.Env.map((entry) => entry.split(/=(.*)/s, 2)));
    assert.equal(environment.get('TLE_INSTANCE_ID'), this.newInstanceId);
    assert.equal(environment.get('TLE_MANAGER_URL'), `http://${this.routeProxyName}:3000`);
    assert.equal(environment.get('TLE_INGEST_TOKEN'), token);
    await created.container.start();
    return created.id;
  }

  async harnessRequest(path, options = {}) {
    const root = `/red/${this.newInstanceId}/`;
    const password = secret(this.master, `harness-password:${this.newInstanceId}`, 28);
    const script = `(async()=>{
      const login=await fetch('http://127.0.0.1:1880${root}auth/token',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          client_id:'node-red-editor',grant_type:'password',scope:'*',
          username:'admin',password:${JSON.stringify(password)}
        })
      });
      const auth=await login.json();
      if(!auth.access_token) throw new Error('admin token unavailable');
      const response=await fetch('http://127.0.0.1:1880${root}${path}',{
        method:${JSON.stringify(options.method ?? 'GET')},
        headers:{accept:'application/json',authorization:'Bearer '+auth.access_token,
          'content-type':'application/json'},
        ${options.body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(options.body)}),`}
      });
      const text=await response.text();
      let body;try{body=text?JSON.parse(text):null}catch{body=text}
      console.log('TLE_RESULT:'+JSON.stringify({status:response.status,body}));
    })().catch(e=>{console.error('TLE_ERROR:'+e.message);process.exit(1)});`;
    const result = await execIn(this.harnessId, ['node', '-e', script], 15_000);
    assert.equal(result.code, 0, result.output.slice(-500));
    const line = result.output.replace(/\r/g, '').split('\n')
      .find((entry) => entry.startsWith('TLE_RESULT:'));
    assert.ok(line, `harness result missing: ${result.output.slice(-500)}`);
    return JSON.parse(line.slice('TLE_RESULT:'.length));
  }

  async harnessInventory(expectedLoaded) {
    const inventory = await waitFor('harness Node-RED inventory', async () => {
      const response = await this.harnessRequest('nodes').catch(() => undefined);
      if (!response || response.status !== 200) return undefined;
      const value = Array.isArray(response.body) ? response.body : response.body?.modules;
      return Array.isArray(value) ? value : undefined;
    }, { timeoutMs: 90_000, intervalMs: 500 });
    assert.deepEqual(
      moduleTypes(inventory, PLATFORM_NODE_PACKAGE.name),
      expectedLoaded ? [...PLATFORM_NODE_TYPES].sort() : [],
    );
    assert.deepEqual(moduleTypes(inventory, PLATFORM_COMMON_PACKAGE.name), []);
    if (!expectedLoaded) {
      const all = new Set(inventory.flatMap(typesFromInventoryEntry));
      for (const type of PLATFORM_NODE_TYPES) assert.equal(all.has(type), false);
    }
    return inventory;
  }

  async ingest(path, token, body) {
    const headers = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${this.hostPort}/api/edge/${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  async verifyFiveRoutesAndOwnership(targetRoot) {
    writeFileSync(join(this.resultsRoot, 'flow-output.ndjson'), '', { mode: 0o666 });
    const injection = await this.harnessRequest('inject/acceptance-inject', { method: 'POST', body: {} });
    assert.ok(injection.status === 200 || injection.status === 204);
    const routes = await waitFor('exact five real Manager routes', () => {
      const rows = readNdjson(this.routeLog);
      return rows.length >= 5 ? rows : undefined;
    }, { timeoutMs: 30_000, intervalMs: 100 });
    assert.equal(routes.length, 5, `unexpected route count ${routes.length}`);
    const paths = routes.map((entry) => entry.path).sort();
    assert.deepEqual(paths, [
      '/api/edge/devices', '/api/edge/devices/device-01/status',
      '/api/edge/tags', '/api/edge/uplink', '/api/edge/values',
    ].sort());
    assert.ok(routes.every((entry) => entry.status >= 200 && entry.status < 300));
    const expectedMessage = {
      marker: this.flowMarker, temperature: 23, instanceId: 'forged-instance',
    };
    const byPath = new Map(routes.map((entry) => [entry.path, entry.body]));
    assert.deepEqual(byPath.get('/api/edge/devices'), {
      nodeId: 'device-01', name: 'Device 01', protocol: 'modbus-tcp',
      address: '192.0.2.10:502', model: 'M1', manufacturer: 'ThingLinks',
    });
    assert.deepEqual(byPath.get('/api/edge/devices/device-01/status'), { online: true });
    assert.deepEqual(byPath.get('/api/edge/tags'), {
      nodeId: 'device-01', tagId: 'temperature', name: 'Temperature',
      unit: 'C', dataType: 'float',
    });
    assert.deepEqual(byPath.get('/api/edge/values'), {
      values: [{ nodeId: 'device-01', tagId: 'temperature', value: 23, quality: 'good' }],
    });
    assert.deepEqual(byPath.get('/api/edge/uplink'), {
      serviceId: 'acceptance', nodeId: 'device-01', data: expectedMessage,
    });
    const output = await waitFor('unchanged downstream flow message', () => {
      const rows = readNdjson(join(this.resultsRoot, 'flow-output.ndjson'));
      return rows.length > 0 ? rows[0] : undefined;
    }, { timeoutMs: 20_000 });
    assert.deepEqual(output, expectedMessage);
    const token = (await this.currentContainer(this.newInstanceId)).Config.Env
      .find((entry) => entry.startsWith('TLE_INGEST_TOKEN='))?.slice('TLE_INGEST_TOKEN='.length);
    assert.ok(token);

    const forgedNode = `forged-${this.instancePrefix}`;
    const forged = await this.ingest('devices', token, {
      instanceId: this.id('forged'), nodeId: forgedNode, name: 'Token-owned',
    });
    assert.equal(forged.status, 200);
    const db = this.database();
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS n FROM field_device WHERE instance_id = ? AND node_id = ?',
    ).get(this.newInstanceId, forgedNode).n, 1);
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS n FROM field_device WHERE instance_id = ? AND node_id = ?',
    ).get(this.id('forged'), forgedNode).n, 0);
    const countsBefore = {
      devices: db.prepare('SELECT COUNT(*) AS n FROM field_device').get().n,
      tags: db.prepare('SELECT COUNT(*) AS n FROM field_tag').get().n,
      history: db.prepare('SELECT COUNT(*) AS n FROM field_value_history').get().n,
    };
    db.close();
    assert.equal((await this.ingest('devices', undefined, {
      nodeId: 'missing-token-write', name: 'No token',
    })).status, 401);
    assert.equal((await this.ingest('devices', 'invalid-verifier-token', {
      nodeId: 'bad-token-write', name: 'Bad token',
    })).status, 401);
    const after = this.database();
    assert.deepEqual({
      devices: after.prepare('SELECT COUNT(*) AS n FROM field_device').get().n,
      tags: after.prepare('SELECT COUNT(*) AS n FROM field_tag').get().n,
      history: after.prepare('SELECT COUNT(*) AS n FROM field_value_history').get().n,
    }, countsBefore);
    assert.equal(after.prepare(
      'SELECT COUNT(*) AS n FROM field_device WHERE instance_id = ? AND node_id = ?',
    ).get(this.newInstanceId, 'device-01').n, 1);
    assert.equal(after.prepare(
      'SELECT online FROM field_device WHERE instance_id = ? AND node_id = ?',
    ).get(this.newInstanceId, 'device-01').online, 1);
    assert.equal(after.prepare(
      'SELECT COUNT(*) AS n FROM field_tag WHERE instance_id = ? AND node_id = ?',
    ).get(this.newInstanceId, 'device-01').n >= 2, true);
    const values = new Map(after.prepare(
      `SELECT tag_id AS tagId, last_value AS lastValue FROM field_tag
       WHERE instance_id = ? AND node_id = ?`,
    ).all(this.newInstanceId, 'device-01').map((row) => [row.tagId, JSON.parse(row.lastValue)]));
    assert.equal(values.get('temperature'), 23);
    assert.equal(values.get('marker'), this.flowMarker);
    assert.equal(values.get('instanceId'), 'forged-instance');
    assert.ok(after.prepare(
      'SELECT COUNT(*) AS n FROM field_value_history WHERE instance_id = ?',
    ).get(this.newInstanceId).n >= 2);
    after.close();
    const commonPath = join(targetRoot, 'node_modules', '@mqttsnet', 'thinglinks-node-red-common');
    assert.ok(existsSync(commonPath));
    assert.equal(existsSync(join(targetRoot, 'nodes', 'tl-common.js')), false);
    return { routes, token };
  }

  async startPausedBroker() {
    const config = join(this.root, 'mosquitto.conf');
    writeFileSync(config, 'listener 1883\nallow_anonymous true\npersistence false\n', { mode: 0o644 });
    const image = await raw.getImage('eclipse-mosquitto:2.1.2-alpine').inspect();
    const name = `${this.runId}-mqtt`;
    const created = await this.createContainer({
      Image: image.Id,
      User: '1883:1883',
      Entrypoint: ['/usr/sbin/mosquitto'],
      Cmd: ['-c', '/verify/mosquitto.conf'],
      HostConfig: {
        NetworkMode: this.controlNetworkId,
        ReadonlyRootfs: true,
        Binds: [`${config}:/verify/mosquitto.conf:ro`],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m', '/mosquitto/data': 'rw,size=16m' },
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {},
    }, name);
    this.brokerId = created.id;
    this.brokerName = name;
    await created.container.start();
    await waitFor('MQTT broker ready', async () => {
      const info = await created.container.inspect();
      if (!info.State.Running) {
        const logs = dockerLogText(await created.container.logs({ stdout: true, stderr: true }));
        throw new Error(`MQTT broker exited: ${logs.slice(-600)}`);
      }
      return true;
    }, { timeoutMs: 20_000 });
    await sleep(300);
    const configured = await this.api('/api/cloud', {
      method: 'PUT', timeoutMs: 20_000,
      body: {
        enabled: true, brokerUrl: `mqtt://${name}:1883`,
        clientId: '2130020836696064@1', deviceIdentification: `task11-${this.instancePrefix}`,
        username: '', password: '', cipherFlag: 0, signKey: 'task11-sign-key',
        protocolVersion: 'v1', qos: 1,
      },
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.status.configured, true);
    await waitFor('Manager cloud online against verifier broker', async () => {
      const current = await this.api('/api/cloud', { csrf: false });
      if (current.status !== 200) return undefined;
      return current.body.status?.state === 'online' ? current.body.status : undefined;
    }, { timeoutMs: 20_000, intervalMs: 250 }).catch(async (error) => {
      const logs = dockerLogText(await created.container.logs({ stdout: true, stderr: true }));
      throw new Error(`${safeError(error)}; broker=${logs.slice(-800)}`);
    });
    await created.container.pause();
  }

  async verify503Passthrough(token) {
    await this.startPausedBroker();
    for (let batch = 0; batch < 8; batch += 1) {
      const data = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => (
        [`q${batch}-${index}`, index]
      )));
      const response = await this.ingest('uplink', token, {
        serviceId: 'saturation', nodeId: 'queue-device', data,
      });
      assert.equal(response.status, 202, `saturation batch ${batch}`);
    }
    const metrics = await waitFor('saturated Manager uplink queue', async () => {
      const response = await this.api('/api/edge/metrics', { csrf: false });
      return response.body?.batch?.saturated ? response.body.batch : undefined;
    }, { timeoutMs: 20_000 });
    assert.equal(metrics.queued, 8);
    writeFileSync(this.routeLog, '', { mode: 0o666 });
    const beforeOutputs = readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).length;
    await this.harnessRequest('inject/acceptance-inject', { method: 'POST', body: {} });
    const failedUplink = await waitFor('real Manager 503 through common', () => (
      readNdjson(this.routeLog).find((entry) => (
        entry.path === '/api/edge/uplink' && entry.status === 503
      ))
    ), { timeoutMs: 20_000 });
    assert.equal(failedUplink.status, 503);
    await waitFor('503 downstream passthrough', () => (
      readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).length > beforeOutputs
    ), { timeoutMs: 20_000 });
    const logs = (await raw.getContainer(this.harnessId).logs({ stdout: true, stderr: true }))
      .toString('utf8');
    assert.match(logs, /回报失败 uplink：HTTP 503/);
    assert.equal((await this.migrationStatus(this.newInstanceId)).phase, 'committed');
    await raw.getContainer(this.brokerId).unpause();
  }

  async verifyAllowlistAndRealFlow() {
    this.flowMarker = `message-${this.instancePrefix}`;
    await this.deployFlows(this.newInstanceId, acceptanceFlow(this.flowMarker));
    const harnessRoot = join(this.root, 'allowlist-harness');
    await this.cloneManagedData(this.newInstanceId, harnessRoot);
    const networkId = await this.startRouteProxy(this.newInstanceId);
    await this.renderHarness(harnessRoot, true);
    await this.startHarness(harnessRoot, networkId);
    await this.harnessInventory(true);
    pass('allowlist-positive', { types: [...PLATFORM_NODE_TYPES], rawExcluded: true });
    const five = await this.verifyFiveRoutesAndOwnership(harnessRoot);
    await this.verify503Passthrough(five.token);

    await this.resources.removeContainer(this.harnessId);
    this.harnessId = undefined;
    writeFileSync(this.routeLog, '', { mode: 0o666 });
    await this.renderHarness(harnessRoot, false);
    const installedBefore = treeHash(join(harnessRoot, 'node_modules', '@mqttsnet'));
    await this.startHarness(harnessRoot, networkId);
    await this.harnessInventory(false);
    assert.equal(treeHash(join(harnessRoot, 'node_modules', '@mqttsnet')), installedBefore);
    await sleep(500);
    assert.equal(readNdjson(this.routeLog).length, 0);
    pass('allowlist-negative', { installed: true, loadedTypes: [], rawExcluded: true });

    await this.resources.removeContainer(this.harnessId);
    this.harnessId = undefined;
    writeFileSync(this.routeLog, '', { mode: 0o666 });
    await this.renderHarness(harnessRoot, true);
    await this.startHarness(harnessRoot, networkId);
    await this.harnessInventory(true);
    const beforeRecovery = readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).length;
    await this.harnessRequest('inject/acceptance-inject', { method: 'POST', body: {} });
    await waitFor('allowlist recovery flow', () => (
      readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).length > beforeRecovery
    ), { timeoutMs: 20_000 });
    pass('allowlist-recovery', { types: [...PLATFORM_NODE_TYPES], flowReturned: true });

    await this.resources.removeContainer(this.harnessId);
    this.harnessId = undefined;
    await this.deployFlows(this.newInstanceId, invalidFlow());
    const invalidRoot = join(this.root, 'invalid-harness');
    await this.cloneManagedData(this.newInstanceId, invalidRoot);
    await this.renderHarness(invalidRoot, true);
    writeFileSync(this.routeLog, '', { mode: 0o666 });
    await this.startHarness(invalidRoot, networkId);
    await this.harnessInventory(true);
    const invalidLogs = await waitFor('invalid configuration errors', async () => {
      const logs = (await raw.getContainer(this.harnessId).logs({ stdout: true, stderr: true }))
        .toString('utf8');
      return logs.includes('tl-device：设备标识不能为空')
        && logs.includes('tl-tag：设备标识与点位标识都不能为空') ? logs : undefined;
    }, { timeoutMs: 20_000 });
    assert.match(invalidLogs, /tl-device：设备标识不能为空/);
    assert.equal(readNdjson(this.routeLog).length, 0);
    await this.resources.removeContainer(this.harnessId);
    this.harnessId = undefined;
    pass('manager-five-routes', {
      routes: five.routes.map((entry) => ({ path: entry.path, status: entry.status })),
      sqlite: true, tokenOwnership: true, rejectedTokens: true,
      messageEquality: true, commonExecution: true, env: ['TLE_INSTANCE_ID', 'TLE_MANAGER_URL', 'TLE_INGEST_TOKEN'],
      passthrough503: true, migrationUnchanged: true, invalidConfiguration: true,
    });
  }

  async cleanup() {
    await this.stopManager(true).catch(() => undefined);
    await this.resources.discover();
    const ids = [...this.resources.containers.keys()];
    // The Docker proxy is removed last so any still-running Manager-created resource can exit first.
    ids.sort((left, right) => Number(left === this.proxyId) - Number(right === this.proxyId));
    for (const id of ids) await this.resources.removeContainer(id);
    await this.resources.discover();
    assert.equal(this.resources.containers.size, 0, 'task-owned containers remain');
    for (const id of [...this.resources.networks.keys()]) {
      await this.resources.removeNetwork(id);
    }
    await this.resources.discover();
    assert.equal(this.resources.networks.size, 0, 'task-owned networks remain');

    if (existsSync(this.root)) {
      const cleanupName = `${this.runId}-permission-cleanup`;
      const { container, id } = await this.createContainer({
        Image: this.managerImageId,
        User: 'root',
        Cmd: ['sh', '-c', 'chmod -R a+rwX /cleanup'],
        HostConfig: { NetworkMode: 'none', Binds: [`${this.root}:/cleanup`] },
        Labels: {},
      }, cleanupName);
      await container.start();
      const result = await container.wait({ condition: 'not-running' });
      assert.equal(result.StatusCode, 0, 'permission cleanup failed');
      await this.resources.removeContainer(id);
      const prefix = `/private/tmp/${this.runId}-`;
      assert.ok(this.root.startsWith(prefix) && dirname(this.root) === '/private/tmp');
      rmSync(this.root, { recursive: true, force: false });
      assert.equal(existsSync(this.root), false, 'task-owned root remains');
    }
    await this.resources.discover();
    assert.equal(this.resources.containers.size, 0);
    assert.equal(this.resources.networks.size, 0);
  }
}

async function main() {
  const verifier = new PlatformVerifier();
  const before = await relevantDockerSnapshot();
  const protectedBefore = await protectedDockerSnapshot();
  let completed = false;
  let operationError;
  try {
    await verifier.initializeImages();
    await verifier.buildFixtures();
    await verifier.createAllFixtures();
    await verifier.startDockerProxy();
    await verifier.startManager('barrier');
    await verifier.setupSession();
    const db = verifier.database();
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 13);
    db.close();
    pass('manager-bootstrap', { schema: 13, auth: true, csrf: true });
    await verifier.createNewInstanceSuccess();
    await verifier.createNewInstanceCompensation();
    await verifier.verifyLegacySuccesses();
    await verifier.verifySameImageAndStagedBefore();
    await verifier.verifyRollbackInjections();
    await verifier.verifyRunningRecovery();
    await verifier.verifyStoppedRecovery();
    await verifier.verifyAllowlistAndRealFlow();
    completed = true;
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    await verifier.cleanup();
    const after = await relevantDockerSnapshot();
    baselineResourcesUnchanged(before, after, new Set([
      verifier.managerImageId, verifier.nodeImageId,
    ].filter(Boolean)));
    assert.deepEqual(await protectedDockerSnapshot(), protectedBefore,
      'protected Manager or line-1 identity/state/network changed');
    if (completed) {
      pass('cleanup', {
        containers: 0, networks: 0, dataRoots: 0,
        baselineContainersUnchanged: true, baselineNetworksUnchanged: true,
      });
    }
  } catch (error) {
    cleanupError = error;
  }
  if (operationError && cleanupError) {
    throw new Error(`operation failed: ${safeError(operationError)}; cleanup failed: ${safeError(cleanupError)}`);
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  for (const phase of phases) {
    assert.ok(results.get(phase), `unimplemented verifier phase: ${phase}`);
  }
  process.stdout.write('\nPlatform npm node real-container matrix:\n');
  for (const phase of phases) process.stdout.write(`  ${phase}: PASS\n`);
  process.stdout.write(`\n14/14 通过 · Manager ${verifier.managerImageId} · Node-RED ${verifier.nodeImageId}\n`);
}

main().catch((error) => {
  process.stderr.write(`platform-node verifier FAIL: ${safeError(error)}\n`);
  process.exitCode = 1;
});
