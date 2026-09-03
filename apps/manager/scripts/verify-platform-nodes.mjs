#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  cpSync,
  existsSync,
  fstatSync,
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
import { dirname, isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import Docker from 'dockerode';
import { runProxyPolicySelfTests } from './verify-platform-manager-entry.mjs';

import {
  assertSafeCreateOptions,
  buildCreateOptions,
  containerName,
} from '../dist/core/instance/container-spec.js';
import { tarFile } from '../dist/core/archive/tar.js';
import { verifyInstalledPlatformFiles } from '../dist/core/nodes/installed-files.js';
import {
  LEGACY_PLATFORM_FILES,
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
const ENTRY_PATH = join(SCRIPT_DIR, 'verify-platform-manager-entry.mjs');
const NODE_IMAGE = 'nodered/node-red:5.0.4-24-minimal';
const MQTT_IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
const MANAGER_IMAGE = process.env.MANAGER_IMAGE?.trim() ?? '';
const CHECKPOINT_FILES = [
  'settings.js', 'settings.js.backup', 'flows.json', 'flows.json.backup',
  'flows_cred.json', 'flows_cred.json.backup', 'package.json', 'package.json.backup',
  'package-lock.json', 'package-lock.json.backup', '.config.nodes.json',
  '.config.nodes.json.backup', '.config.modules.json', '.config.modules.json.backup',
];
const EDGE_MODULE_PATH = 'node_modules/@mqttsnet/thinglinks-edge-nodes';
const COMMON_MODULE_PATH = 'node_modules/@mqttsnet/thinglinks-node-red-common';
const results = new Map(phases.map((phase) => [phase, undefined]));
const raw = new Docker();

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const secret = (master, purpose, bytes = 32) => createHmac('sha256', master)
  .update(purpose).digest('base64url').slice(0, bytes);
const safeError = (error) => String(error?.message ?? error)
  .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, '<redacted>').slice(0, 1200);

function pathContained(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function trustedDirectoryWithin(root, path) {
  const rootStat = lstatSync(root);
  const stat = lstatSync(path);
  assert.equal(rootStat.isDirectory() && !rootStat.isSymbolicLink(), true,
    `untrusted root ${root}`);
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true,
    `untrusted directory ${path}`);
  const actualRoot = realpathSync(root);
  const actual = realpathSync(path);
  assert.equal(pathContained(actualRoot, actual), true, `directory escapes root ${path}`);
  return actual;
}

function pass(phase, evidence) {
  assert.ok(phases.includes(phase), `unknown phase ${phase}`);
  assert.equal(results.get(phase), undefined, `phase ${phase} completed twice`);
  results.set(phase, evidence);
  process.stdout.write(`  PASS ${phase}\n`);
}

function writeDurableJson(path, value) {
  const parentStat = lstatSync(dirname(path));
  assert.equal(parentStat.isDirectory() && !parentStat.isSymbolicLink(), true,
    `untrusted durable parent ${dirname(path)}`);
  const partial = `${path}.partial-${process.pid}`;
  const fd = openSync(partial,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL
      | FS_CONSTANTS.O_NOFOLLOW,
    0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
  const dirFd = openSync(dirname(path), FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function writeExclusiveFile(path, bytes, mode = 0o600) {
  const parent = lstatSync(dirname(path));
  assert.equal(parent.isDirectory() && !parent.isSymbolicLink(), true,
    `untrusted file parent ${dirname(path)}`);
  const fd = openSync(path,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL
      | FS_CONSTANTS.O_NOFOLLOW,
    mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

async function acquireImage(name) {
  try {
    return await raw.getImage(name).inspect();
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const stream = await raw.pull(name);
      await new Promise((resolvePull, reject) => {
        raw.modem.followProgress(stream, (error) => error ? reject(error) : resolvePull());
      });
      return await raw.getImage(name).inspect();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw new Error(`failed to acquire ${name} after 3 attempts: ${safeError(lastError)}`);
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
  const volumeList = await raw.listVolumes();
  const volumes = (volumeList.Volumes ?? []).map((item) => ({
    name: item.Name,
    driver: item.Driver,
    labels: Object.entries(item.Labels ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    scope: item.Scope ?? '',
  })).sort((left, right) => left.name.localeCompare(right.name));
  return { containers, networks, images, volumes };
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

function containerRuntimeFact(info) {
  return {
    id: info.Id,
    image: info.Image,
    running: info.State.Running,
    status: info.State.Status,
    restartCount: info.RestartCount,
    startedAt: info.State.StartedAt,
    environment: [...(info.Config.Env ?? [])].sort(),
    networks: Object.values(info.NetworkSettings.Networks ?? {})
      .map((network) => network.NetworkID).sort(),
  };
}

function baselineResourcesUnchanged(before, after, permittedImageIds) {
  const assertPreserved = (kind, expected, actual) => {
    const byId = new Map(actual.map((item) => [item.id, item]));
    for (const item of expected) {
      assert.deepEqual(byId.get(item.id), item, `baseline ${kind} changed: ${item.id}`);
    }
  };
  // Other verifier slices may create unrelated resources concurrently. Preserve
  // every immutable resource observed at startup; task-label absence is checked
  // separately and therefore cannot be hidden by accepting later additions.
  assertPreserved('container', before.containers, after.containers);
  assertPreserved('network', before.networks, after.networks);
  assert.deepEqual(after.volumes, before.volumes, 'Docker volume identities changed');
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

function artifactFact(root, path) {
  const absolute = join(root, path);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if (error.code === 'ENOENT') return { path, exists: false };
    throw error;
  }
  assert.equal(stat.isSymbolicLink(), false, `symlink in ${absolute}`);
  if (stat.isFile()) {
    const bytes = readFileSync(absolute);
    return {
      path, exists: true, kind: 'file', mode: stat.mode & 0o777,
      size: bytes.length, sha256: sha256(bytes),
    };
  }
  assert.equal(stat.isDirectory(), true, `unsupported artifact ${absolute}`);
  return {
    path, exists: true, kind: 'directory', mode: stat.mode & 0o777,
    sha256: treeHash(absolute),
  };
}

function rollbackSnapshot(root) {
  return {
    checkpointFiles: CHECKPOINT_FILES.map((path) => artifactFact(root, path)),
    raw: artifactFact(root, 'nodes'),
    edge: artifactFact(root, EDGE_MODULE_PATH),
    common: artifactFact(root, COMMON_MODULE_PATH),
  };
}

function rollbackSnapshotDiff(expected, actual) {
  const expectedFiles = new Map(expected.checkpointFiles.map((fact) => [fact.path, fact]));
  return [
    ...actual.checkpointFiles
      .filter((fact) => JSON.stringify(fact) !== JSON.stringify(expectedFiles.get(fact.path)))
      .map((fact) => fact.path),
    ...['raw', 'edge', 'common'].filter((key) => (
      JSON.stringify(actual[key]) !== JSON.stringify(expected[key])
    )),
  ];
}

function assertCanonicalRaw(root) {
  const nodes = join(root, 'nodes');
  const entries = readdirSync(nodes).sort();
  const expected = Object.keys(LEGACY_PLATFORM_FILES).sort();
  assert.deepEqual(entries, expected);
  for (const name of expected) {
    const stat = lstatSync(join(nodes, name));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `raw ${name} type`);
    assert.equal(sha256(readFileSync(join(nodes, name))), LEGACY_PLATFORM_FILES[name]);
  }
}

function transactionSidecars(root, txId) {
  const found = [];
  const walk = (path) => {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    assert.equal(stat.isSymbolicLink(), false, `symlink in rollback tree ${path}`);
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (name.includes(`.tle-${txId}.`) && /\.(?:partial|backup|manifest|backup-manifest)$/.test(name)) {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(root);
  return found.sort();
}

function makeTreeWritable(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
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

function readRegularNoFollow(path, maxBytes = 16 * 1024 * 1024) {
  const before = lstatSync(path);
  assert.equal(before.isFile() && !before.isSymbolicLink() && before.size <= maxBytes, true,
    `untrusted result file ${path}`);
  const fd = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const after = fstatSync(fd);
    assert.equal(after.isFile() && after.dev === before.dev && after.ino === before.ino, true,
      `result file changed ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readRegularNoFollow(path).toString('utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

function inventoryNodeSets(inventory) {
  return inventory.flatMap((entry) => {
    if (Array.isArray(entry?.types)) return [entry];
    if (Array.isArray(entry?.nodes)) {
      return entry.nodes.map((node) => ({ ...entry, ...node }));
    }
    if (entry?.nodes && typeof entry.nodes === 'object') {
      return Object.entries(entry.nodes).map(([name, node]) => ({
        ...entry, ...(node && typeof node === 'object' ? node : {}), name,
      }));
    }
    return [];
  });
}

function relevantInventoryState(inventory, expectedLoaded) {
  const sets = inventoryNodeSets(inventory);
  const edgeTypes = moduleTypes(inventory, PLATFORM_NODE_PACKAGE.name);
  const commonTypes = moduleTypes(inventory, PLATFORM_COMMON_PACKAGE.name);
  const ownersByType = Object.fromEntries(PLATFORM_NODE_TYPES.map((type) => [
    type,
    sets.filter((entry) => typesFromInventoryEntry(entry).includes(type))
      .map((entry) => ({
        module: entry.module ?? null,
        name: entry.name ?? null,
        enabled: entry.enabled ?? null,
        file: typeof entry.file === 'string' ? entry.file : null,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]));
  const allPlatformTypes = [...new Set(sets.flatMap(typesFromInventoryEntry)
    .filter((type) => PLATFORM_NODE_TYPES.includes(type)))].sort();
  const matches = expectedLoaded
    ? JSON.stringify(edgeTypes) === JSON.stringify([...PLATFORM_NODE_TYPES].sort())
      && commonTypes.length === 0
      && PLATFORM_NODE_TYPES.every((type) => {
        const owners = ownersByType[type];
        return owners.length === 1
          && owners[0].module === PLATFORM_NODE_PACKAGE.name
          && owners[0].enabled === true;
      })
    : edgeTypes.length === 0 && commonTypes.length === 0 && allPlatformTypes.length === 0;
  return {
    matches,
    signature: JSON.stringify({ edgeTypes, commonTypes, allPlatformTypes, ownersByType }),
    state: { edgeTypes, commonTypes, allPlatformTypes, ownersByType },
  };
}

function inventoryStability(expectedLoaded, required = 3) {
  let signature = '';
  let consecutive = 0;
  return {
    observe(inventory) {
      const evaluated = relevantInventoryState(inventory, expectedLoaded);
      if (!evaluated.matches) {
        signature = '';
        consecutive = 0;
      } else if (evaluated.signature === signature) {
        consecutive += 1;
      } else {
        signature = evaluated.signature;
        consecutive = 1;
      }
      return { ...evaluated, consecutive, ready: consecutive >= required };
    },
  };
}

function runInventoryStabilitySelfTests() {
  let passed = 0;
  const nodeSet = (module, types, extra = {}) => ({
    id: `${module}/${types[0] ?? 'none'}`, module, name: types[0] ?? module,
    types, enabled: true, ...extra,
  });
  const negative = [nodeSet('node-red', ['inject'])];
  const stale = [...negative, nodeSet('node-red', ['tl-device'], {
    file: '/data/nodes/tl-device.js',
  })];
  const positive = [
    ...negative,
    ...PLATFORM_NODE_TYPES.map((type) => nodeSet(PLATFORM_NODE_PACKAGE.name, [type], {
      file: `/data/node_modules/@mqttsnet/thinglinks-edge-nodes/${type}.js`,
    })),
  ];
  const positiveChanged = positive.map((entry) => entry.types.includes('tl-device')
    ? { ...entry, file: '/data/node_modules/@mqttsnet/thinglinks-edge-nodes/tl-device-alt.js' }
    : entry);

  const staleTracker = inventoryStability(false);
  assert.equal(staleTracker.observe(stale).ready, false, 'first stale 200 inventory passed');
  passed += 1;

  const incompleteTracker = inventoryStability(false);
  assert.equal(incompleteTracker.observe(negative).ready, false);
  assert.equal(incompleteTracker.observe(negative).ready, false,
    'fewer than three stable inventories passed');
  passed += 1;

  const resetTracker = inventoryStability(true);
  assert.equal(resetTracker.observe(positive).ready, false);
  assert.equal(resetTracker.observe(positive).ready, false);
  assert.equal(resetTracker.observe(positiveChanged).consecutive, 1, 'inventory change did not reset');
  assert.equal(resetTracker.observe(positive).consecutive, 1, 'return change did not reset');
  passed += 1;

  const readyTracker = inventoryStability(false);
  assert.equal(readyTracker.observe(negative).ready, false);
  assert.equal(readyTracker.observe(negative).ready, false);
  assert.equal(readyTracker.observe(negative).ready, true, 'three stable inventories did not pass');
  passed += 1;
  return { passed, total: 4 };
}

function acceptanceFlow(marker) {
  return [
    { id: 'acceptance-tab', type: 'tab', label: 'Task 11 acceptance', disabled: false, info: '' },
    {
      id: 'acceptance-inject', type: 'inject', z: 'acceptance-tab', name: 'Task 11 trigger',
      props: [
        { p: 'payload' },
        { p: 'quality', v: 'good', vt: 'str' },
        { p: 'canary', v: `canary-${marker}`, vt: 'str' },
      ],
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
      func: 'msg.payload = JSON.stringify({payload:msg.payload,quality:msg.quality,canary:msg.canary});\nreturn msg;', outputs: 1,
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
    this.containers.set(info.Id, name);
    assert.equal(info.Config.Labels?.[RUN_LABEL], this.runId);
    assert.equal((info.Mounts ?? []).some((mount) => mount.Type === 'volume'), false,
      `${name} acquired an unexpected Docker volume`);
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
    await ref.remove({ force: true, v: true });
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
    const containers = await raw.listContainers({
      all: true, filters: { label: [`${RUN_LABEL}=${this.runId}`] },
    });
    for (const item of containers) this.containers.set(item.Id, item.Names[0] ?? item.Id);
    for (const item of containers) {
      const info = await raw.getContainer(item.Id).inspect().catch((error) => {
        if (error.statusCode === 404) return undefined;
        throw error;
      });
      if (!info) continue;
      assert.equal(info.Config.Labels?.[RUN_LABEL], this.runId,
        `discovered container owner changed ${item.Id}`);
      assert.equal((info.Mounts ?? []).some((mount) => mount.Type === 'volume'), false,
        `${item.Names[0] ?? item.Id} acquired an unexpected Docker volume`);
    }
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
    this.root = undefined;
    this.dataRoot = undefined;
    this.controlRoot = undefined;
    this.resultsRoot = undefined;
    this.fixtureSpecPath = undefined;
    this.master = randomBytes(48).toString('base64url');
    this.adminPassword = randomBytes(24).toString('base64url');
    this.resources = new RunResources(this.runId, undefined);
    this.managerName = `${this.runId}-manager`;
    this.proxyName = `${this.runId}-docker-proxy`;
    this.controlNetworkName = `${this.runId}-control`;
    this.networkPrefix = `${this.runId}-instance`;
    this.hostPort = undefined;
    this.managerId = undefined;
    this.proxyId = undefined;
    this.controlNetworkId = undefined;
    this.nodeImageId = undefined;
    this.mosquittoImageId = undefined;
    this.managerImageId = undefined;
    this.session = undefined;
    this.knownReady = new Set();
    this.initialSnapshots = new Map();
    this.stagedRollbackVerified = false;
    this.networkOrdinal = 0;
    this.subnetSecondOctet = undefined;
  }

  initializeWorkspace() {
    this.root = realpathSync(mkdtempSync(join('/private/tmp', `${this.runId}-`)));
    chmodSync(this.root, 0o700);
    const rootStat = lstatSync(this.root);
    assert.equal(rootStat.isDirectory() && !rootStat.isSymbolicLink()
      && (rootStat.mode & 0o777) === 0o700, true, 'private verifier root');
    this.dataRoot = join(this.root, 'edge-data');
    this.controlRoot = join(this.root, 'control');
    this.resultsRoot = join(this.root, 'results');
    this.fixtureSpecPath = join(this.root, 'fixtures.json');
    /*
     * Host uid and container uid 1000 both write these bind roots. Mode 0777 is
     * intentionally limited to children of the non-traversable 0700 run root;
     * no other host user can reach them, and no fixed/shared path is widened.
     */
    for (const path of [this.dataRoot, this.controlRoot, this.resultsRoot]) {
      mkdirSync(path, { recursive: false, mode: 0o777 });
      chmodSync(path, 0o777);
      const stat = lstatSync(path);
      assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true, `shared root ${path}`);
    }
    const instanceDataRoot = join(this.dataRoot, 'instances');
    mkdirSync(instanceDataRoot, { mode: 0o777 });
    chmodSync(instanceDataRoot, 0o777);
    trustedDirectoryWithin(this.dataRoot, instanceDataRoot);
    this.resources.root = this.root;
  }

  resetSharedFile(path) {
    const root = realpathSync(this.resultsRoot);
    const parent = realpathSync(dirname(path));
    assert.equal(pathContained(root, parent), true, `shared file escapes results root ${path}`);
    let flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW | FS_CONSTANTS.O_TRUNC;
    if (existsSync(path)) {
      const stat = lstatSync(path);
      assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `untrusted shared file ${path}`);
    } else {
      flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW
        | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL;
    }
    // The file is world-writable only below the private 0700 run root so host
    // and uid 1000 containers can share it without widening a persistent path.
    const fd = openSync(path, flags, 0o666);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(path, 0o666);
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
    const manager = await raw.getImage(MANAGER_IMAGE).inspect();
    const [node, mosquitto] = await Promise.all([
      acquireImage(NODE_IMAGE), acquireImage(MQTT_IMAGE),
    ]);
    assert.match(manager.Id, /^sha256:[a-f0-9]{64}$/);
    assert.match(node.Id, /^sha256:[a-f0-9]{64}$/);
    assert.match(mosquitto.Id, /^sha256:[a-f0-9]{64}$/);
    this.managerImageId = manager.Id;
    this.nodeImageId = node.Id;
    this.mosquittoImageId = mosquitto.Id;
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
      'stopok', 'staged-rb', 'sset', 'sscout',
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
    const instanceDataRoot = trustedDirectoryWithin(this.root,
      join(this.dataRoot, 'instances'));
    trustedDirectoryWithin(instanceDataRoot, join(instanceDataRoot, definition.id));
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
      instanceDataRoot,
      timezone: 'UTC',
      imageIdOverride: this.nodeImageId,
    });
    assertSafeCreateOptions(options, { instanceDataRoot });
    const created = await this.createContainer(options, containerName(definition.id));
    definition.containerId = created.id;
    definition.networkId = networkId;
    if (definition.running) await created.container.start();
  }

  async createAllFixtures() {
    for (const fixture of this.fixtures) await this.createFixture(fixture);
    const running = this.fixtures.filter((fixture) => fixture.running);
    await Promise.all(running.map((fixture) => this.waitFixtureReady(fixture)));
    await this.hotStagePreexistingFixture('staged');
    if (this.fixtures.some((fixture) => fixture.label === 'staged-rb')) {
      await this.hotStagePreexistingFixture('staged-rb');
    }
    for (const fixture of this.fixtures) {
      const info = await this.currentContainer(fixture.id);
      assert.equal(info.State.Running, fixture.running);
      const root = join(this.dataRoot, 'instances', fixture.id);
      const logs = dockerLogText(await raw.getContainer(info.Id).logs({ stdout: true, stderr: true }));
      this.initialSnapshots.set(fixture.id, {
        ...rollbackSnapshot(root),
        installLogCount: (logs.match(/Installing module: @mqttsnet\/thinglinks-edge-nodes/g) ?? []).length,
        uninstallLogCount: (logs.match(
          /(?:Removing|Removed|Uninstalling|Uninstalled) module: @mqttsnet\/thinglinks-edge-nodes/g,
        ) ?? []).length,
      });
    }
  }

  async waitFixtureReady(fixture) {
    await waitFor(`${fixture.id} pre-Manager Node-RED readiness`, async () => {
      const result = await execIn(fixture.containerId, [
        'node', '-e',
        `fetch('http://127.0.0.1:1880/red/${fixture.id}/settings')`
          + '.then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))',
      ], 10_000).catch(() => ({ code: 1 }));
      return result.code === 0;
    }, { timeoutMs: 90_000, intervalMs: 500 });
  }

  async hotStagePreexistingFixture(label) {
    const fixture = this.fixture(label);
    const temporarilyStarted = !fixture.running;
    if (temporarilyStarted) {
      await raw.getContainer(fixture.containerId).start();
      await this.waitFixtureReady(fixture);
    }
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
    try {
      await created.container.start();
      await waitFor('pre-Manager seed registry', async () => {
        const logs = dockerLogText(await created.container.logs({ stdout: true, stderr: true }));
        return logs.includes('[verify-seed-registry] ready');
      }, { timeoutMs: 30_000 });
      const response = await this.fixtureAdminRequest(label, 'nodes', {
        method: 'POST', body: {
          module: PLATFORM_NODE_PACKAGE.name, version: PLATFORM_NODE_PACKAGE.version,
        },
      });
      assert.equal(response.status, 200, `${label}: ${response.body}`);
      const body = JSON.parse(response.body);
      assert.equal(body.name, PLATFORM_NODE_PACKAGE.name);
      assert.equal(body.version, PLATFORM_NODE_PACKAGE.version);
      assert.deepEqual(body.nodes.map((node) => ({ type: node.types[0], error: node.err })),
        PLATFORM_NODE_TYPES.map((type) => ({ type, error: `${type} already registered` })));
    } finally {
      await this.resources.removeContainer(created.id).catch(() => undefined);
      if (temporarilyStarted) {
        const original = raw.getContainer(fixture.containerId);
        const info = await original.inspect().catch(() => undefined);
        if (info?.State.Running) await original.stop({ t: 10 });
      }
    }
    const root = join(this.dataRoot, 'instances', fixture.id);
    await verifyInstalledPlatformFiles({
      instanceDataRoot: join(this.dataRoot, 'instances'), instanceId: fixture.id,
      readFile: (path) => Promise.resolve(readRegularNoFollow(path).toString('utf8')),
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
        `VERIFY_INSTANCE_DATA_ROOT=${join(this.dataRoot, 'instances')}`,
        `VERIFY_NETWORK_PREFIX=${this.networkPrefix}`,
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

  async proxyHttp(method, path, body) {
    const bytes = body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const encoded = bytes.toString('base64');
    const contentType = Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json';
    const script = `const http=require('http');
const body=Buffer.from(${JSON.stringify(encoded)},'base64');
const request=http.request({host:'127.0.0.1',port:2375,method:${JSON.stringify(method)},
path:${JSON.stringify(path)},headers:body.length?{'content-type':${JSON.stringify(contentType)},'content-length':body.length}:{}},response=>{
const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
console.log('TLE_PROXY_RESULT:'+JSON.stringify({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
});});request.on('error',error=>{console.error(error.message);process.exit(1)});request.end(body);`;
    const executed = await execIn(this.proxyId, ['node', '-e', script], 15_000);
    assert.equal(executed.code, 0, executed.output.slice(-500));
    const line = executed.output.replace(/\r/g, '').split('\n')
      .find((entry) => entry.startsWith('TLE_PROXY_RESULT:'));
    assert.ok(line, executed.output.slice(-500));
    return JSON.parse(line.slice('TLE_PROXY_RESULT:'.length));
  }

  async proxyDenialLines() {
    if (!this.proxyId) return [];
    const logs = dockerLogText(await raw.getContainer(this.proxyId)
      .logs({ stdout: true, stderr: true, tail: 500 }).catch(() => Buffer.alloc(0)));
    return logs.split('\n').filter((line) => line.includes('[verify-proxy] DENY'));
  }

  async proxyDenialDiagnostics() {
    if (!this.proxyId) return 'proxy-not-started';
    const lines = await this.proxyDenialLines();
    const known = this.proxyPolicyEvidence?.denialLogCount ?? 0;
    const unexpected = lines.slice(known).slice(-12);
    return unexpected.length > 0 ? unexpected.join(' | ') : 'no-new-proxy-denial';
  }

  async verifyLiveDockerProxyPolicy() {
    const instanceId = this.id('proxy-policy');
    const bootstrapInstanceId = this.id('proxy-bootstrap');
    const bootstrapTxId = 'bootstrap-policy-test';
    const foreignInstanceId = this.id('proxy-foreign');
    const foreignRunId = `${this.runId}-foreign`;
    const dataRoot = join(this.dataRoot, 'instances', instanceId);
    const dockerodeNetworkPath = (value) => {
      const query = new URLSearchParams();
      for (const key of ['Name', 'Driver', 'Labels', 'Internal']) {
        if (value[key] === undefined) continue;
        query.set(key, typeof value[key] === 'object' ? JSON.stringify(value[key]) : String(value[key]));
      }
      return `/networks/create?${query}`;
    };
    const dockerodeContainerPath = (value) => {
      const query = new URLSearchParams();
      for (const [key, entry] of Object.entries(value)) {
        if (Array.isArray(entry)) {
          for (const item of entry) query.append(key, String(item));
        } else {
          query.set(key, entry !== null && typeof entry === 'object'
            ? JSON.stringify(entry) : String(entry));
        }
      }
      return `/containers/create?${query}`;
    };
    mkdirSync(dataRoot, { mode: 0o700 });
    trustedDirectoryWithin(join(this.dataRoot, 'instances'), dataRoot);
    let foreignContainer;
    let foreignNetwork;
    let managerProbeId;
    let allowedContainerId;
    let allowedNetworkId;
    let bootstrapContainerId;
    let bootstrapNetworkId;
    const cleanupForeign = async () => {
      if (foreignContainer) {
        const info = await foreignContainer.inspect().catch(() => undefined);
        if (info) {
          assert.equal(info.Config.Labels?.[RUN_LABEL], foreignRunId);
          await foreignContainer.remove({ force: true, v: true });
        }
      }
      if (foreignNetwork) {
        const info = await foreignNetwork.inspect().catch(() => undefined);
        if (info) {
          assert.equal(info.Labels?.[RUN_LABEL], foreignRunId);
          await foreignNetwork.remove();
        }
      }
    };
    try {
      const networkCreate = await this.proxyHttp('POST', '/networks/create', {
        Name: `${this.networkPrefix}-${instanceId}`,
        Driver: 'bridge',
        Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: instanceId },
      });
      assert.equal(networkCreate.status, 201, networkCreate.body);
      allowedNetworkId = JSON.parse(networkCreate.body).Id;
      await this.resources.trackNetwork(raw.getNetwork(allowedNetworkId),
        `${this.networkPrefix}-${instanceId}`);
      const networkInfo = await raw.getNetwork(allowedNetworkId).inspect();
      assert.equal(networkInfo.Internal, true);

      const create = buildCreateOptions({
        id: instanceId, imageTag: '5.0.4-24-minimal', memoryMb: 256, cpus: 0.5,
        ports: [], adminRoot: `/red/${instanceId}/`,
        ingestToken: 'p'.repeat(32), managerUrl: `http://${this.managerName}:19100`,
        npmRegistry: `http://${this.managerName}:19100/npm/`,
      }, {
        network: allowedNetworkId, imageRepo: 'nodered/node-red',
        instanceDataRoot: join(this.dataRoot, 'instances'), timezone: 'UTC',
      });
      const containerCreate = await this.proxyHttp(
        'POST', `/containers/create?name=${create.name}`, create,
      );
      assert.equal(containerCreate.status, 201, containerCreate.body);
      allowedContainerId = JSON.parse(containerCreate.body).Id;
      const allowedContainer = raw.getContainer(allowedContainerId);
      await this.resources.trackContainer(allowedContainer, create.name);
      const allowedInfo = await allowedContainer.inspect();
      assert.equal(allowedInfo.Config.Image, this.nodeImageId);
      const started = await this.proxyHttp(
        'POST', `/containers/${allowedContainerId}/start`, undefined,
      );
      assert.equal(started.status, 204, started.body);
      const restarted = await this.proxyHttp(
        'POST', `/containers/${allowedContainerId}/restart?t=10`, { t: 10 },
      );
      assert.equal(restarted.status, 204, restarted.body);
      const stopped = await this.proxyHttp(
        'POST', `/containers/${allowedContainerId}/stop?t=10`, { t: 10 },
      );
      assert.equal(stopped.status, 204, stopped.body);

      const fakeManager = await this.createContainer({
        Image: this.managerImageId, User: 'node', Cmd: ['sleep', '300'],
        HostConfig: {
          NetworkMode: this.controlNetworkId, ReadonlyRootfs: true,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        }, Labels: {},
      }, this.managerName);
      managerProbeId = fakeManager.id;
      await fakeManager.container.start();

      const bootstrapRoot = join(this.dataRoot, 'instances', bootstrapInstanceId);
      mkdirSync(bootstrapRoot, { mode: 0o700 });
      trustedDirectoryWithin(join(this.dataRoot, 'instances'), bootstrapRoot);
      const bootstrapNetworkBody = {
        Name: `${this.networkPrefix}-${bootstrapInstanceId}`,
        Driver: 'bridge',
        Labels: {
          [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: bootstrapInstanceId,
          'com.mqttsnet.thinglinks-edge.bootstrap-tx': bootstrapTxId,
        },
      };
      const bootstrapNetworkCreate = await this.proxyHttp(
        'POST', dockerodeNetworkPath(bootstrapNetworkBody), bootstrapNetworkBody,
      );
      assert.equal(bootstrapNetworkCreate.status, 201, bootstrapNetworkCreate.body);
      bootstrapNetworkId = JSON.parse(bootstrapNetworkCreate.body).Id;
      await this.resources.trackNetwork(raw.getNetwork(bootstrapNetworkId),
        `${this.networkPrefix}-${bootstrapInstanceId}`);
      const bootstrapCreate = buildCreateOptions({
        id: bootstrapInstanceId, imageTag: '5.0.4-24-minimal', memoryMb: 256, cpus: 0.5,
        ports: [], adminRoot: `/red/${bootstrapInstanceId}/`,
        ingestToken: 'b'.repeat(32), managerUrl: `http://${this.managerName}:19100`,
        npmRegistry: `http://${this.managerName}:19100/npm/`,
      }, {
        network: bootstrapNetworkId, imageRepo: 'nodered/node-red',
        instanceDataRoot: join(this.dataRoot, 'instances'), timezone: 'UTC', bootstrapTxId,
      });
      const bootstrapContainerCreate = await this.proxyHttp(
        'POST', dockerodeContainerPath(bootstrapCreate), bootstrapCreate,
      );
      assert.equal(bootstrapContainerCreate.status, 201, bootstrapContainerCreate.body);
      bootstrapContainerId = JSON.parse(bootstrapContainerCreate.body).Id;
      await this.resources.trackContainer(raw.getContainer(bootstrapContainerId), bootstrapCreate.name);
      const bootstrapConnect = await this.proxyHttp(
        'POST', `/networks/${bootstrapNetworkId}/connect`, { Container: managerProbeId },
      );
      assert.equal(bootstrapConnect.status, 200, bootstrapConnect.body);
      const bootstrapArchive = await this.proxyHttp(
        'PUT', `/containers/${bootstrapContainerId}/archive?path=%2Fdata`,
        tarFile('settings.js', 'module.exports = {};\n', { uid: 1000, gid: 1000, mode: 0o644 }),
      );
      assert.equal(bootstrapArchive.status, 200, bootstrapArchive.body);

      foreignNetwork = await raw.createNetwork({
        Name: `${this.networkPrefix}-${foreignInstanceId}`, Driver: 'bridge', Internal: true,
        Labels: {
          [RUN_LABEL]: foreignRunId, [MANAGED_LABEL]: 'true',
          [INSTANCE_LABEL]: foreignInstanceId,
        },
        IPAM: { Driver: 'default', Config: [{
          Subnet: `10.${this.subnetSecondOctet + 1}.250.0/28`,
        }] },
      });
      const foreignNetworkInfo = await foreignNetwork.inspect();
      foreignContainer = await raw.createContainer({
        name: `tle-nr-${foreignInstanceId}`, Image: this.nodeImageId,
        User: 'node-red', Cmd: ['sleep', '300'],
        Labels: {
          [RUN_LABEL]: foreignRunId, [MANAGED_LABEL]: 'true',
          [INSTANCE_LABEL]: foreignInstanceId,
        },
        HostConfig: {
          NetworkMode: foreignNetworkInfo.Id, ReadonlyRootfs: true,
          Tmpfs: {
            '/data': 'rw,noexec,nosuid,size=16m',
            '/tmp': 'rw,noexec,nosuid,size=16m',
          },
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        },
      });
      const foreignContainerInfo = await foreignContainer.inspect();
      assert.equal((foreignContainerInfo.Mounts ?? []).some((mount) => mount.Type === 'volume'), false);
      await foreignContainer.start();

      const exactResources = async () => this.instanceDockerResiduals(instanceId);
      const expected = await exactResources();
      assert.deepEqual(expected, {
        containers: [allowedContainerId], networks: [allowedNetworkId],
      });
      const baseNetwork = {
        Name: `${this.networkPrefix}-${instanceId}`, Driver: 'bridge',
        Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: instanceId },
      };
      const maliciousNetworks = [
        ['network driver', (value) => { value.Driver = 'host'; }],
        ['network internal', (value) => { value.Internal = false; }],
        ['network options', (value) => { value.Options = { unsafe: 'true' }; }],
        ['network IPAM', (value) => { value.IPAM = { Driver: 'default' }; }],
        ['network name', (value) => { value.Name = `${this.networkPrefix}-${this.id('other')}`; }],
        ['network label', (value) => { value.Labels[INSTANCE_LABEL] = this.id('other'); }],
      ];
      for (const [name, mutate] of maliciousNetworks) {
        const value = structuredClone(baseNetwork);
        mutate(value);
        const response = await this.proxyHttp('POST', '/networks/create', value);
        assert.equal(response.status, 403, `proxy accepted ${name}`);
        assert.deepEqual(await exactResources(), expected, `${name} mutated Docker`);
      }
      const mismatchedQuery = await this.proxyHttp(
        'POST', dockerodeNetworkPath({ ...baseNetwork, Driver: 'host' }), baseNetwork,
      );
      assert.equal(mismatchedQuery.status, 403, 'proxy accepted mismatched network query');
      assert.deepEqual(await exactResources(), expected, 'mismatched network query mutated Docker');
      const malicious = [
        ['Cmd', (value) => { value.Cmd = ['sleep', '1']; }],
        ['Entrypoint', (value) => { value.Entrypoint = ['/bin/sh']; }],
        ['Image', (value) => { value.Image = 'alpine:latest'; }],
        ['User', (value) => { value.User = 'root'; }],
        ['Mounts', (value) => { value.Mounts = [{ Type: 'volume', Target: '/data' }]; }],
        ['Privileged', (value) => { value.HostConfig.Privileged = true; }],
        ['Binds', (value) => { value.HostConfig.Binds = ['/var/run/docker.sock:/data']; }],
        ['ReadonlyRootfs', (value) => { value.HostConfig.ReadonlyRootfs = false; }],
        ['CapAdd', (value) => { value.HostConfig.CapAdd = ['SYS_ADMIN']; }],
        ['CapDrop', (value) => { value.HostConfig.CapDrop = []; }],
        ['Devices', (value) => { value.HostConfig.Devices = [{ PathOnHost: '/dev/null' }]; }],
        ['PidMode', (value) => { value.HostConfig.PidMode = 'host'; }],
        ['NetworkMode', (value) => { value.HostConfig.NetworkMode = foreignNetworkInfo.Id; }],
        ['PortBindings', (value) => { value.HostConfig.PortBindings = {
          '1880/tcp': [{ HostIp: '0.0.0.0', HostPort: '1880' }],
        }; }],
        ['Memory', (value) => { value.HostConfig.Memory = 0; }],
        ['NanoCpus', (value) => { value.HostConfig.NanoCpus = 0; }],
        ['PidsLimit', (value) => { value.HostConfig.PidsLimit = 0; }],
        ['SecurityOpt', (value) => { value.HostConfig.SecurityOpt = []; }],
        ['Tmpfs', (value) => { value.HostConfig.Tmpfs = { '/tmp': 'rw,exec' }; }],
        ['instance env', (value) => { value.Env[1] = `TLE_INSTANCE_ID=${this.id('other')}`; }],
        ['admin root', (value) => { value.Env[2] = 'TLE_ADMIN_ROOT=/'; }],
        ['Manager URL', (value) => { value.Env[4] = 'TLE_MANAGER_URL=http://foreign:19100'; }],
        ['registry', (value) => { value.Env[5] = 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/'; }],
        ['duplicate env', (value) => { value.Env.push(value.Env[1]); }],
        ['name', (value) => { value.name = `tle-nr-${this.id('other')}`; }],
        ['label', (value) => { value.Labels[INSTANCE_LABEL] = this.id('other'); }],
      ];
      for (const [name, mutate] of malicious) {
        const value = structuredClone(create);
        mutate(value);
        const response = await this.proxyHttp(
          'POST', `/containers/create?name=${value.name}`, value,
        );
        assert.equal(response.status, 403, `proxy accepted ${name}`);
        assert.deepEqual(await exactResources(), expected, `${name} mutated Docker`);
      }
      const mismatchedContainerQuery = structuredClone(create);
      mismatchedContainerQuery.User = 'root';
      const rejectedContainerMirror = await this.proxyHttp(
        'POST', dockerodeContainerPath(mismatchedContainerQuery), create,
      );
      assert.equal(rejectedContainerMirror.status, 403,
        'proxy accepted mismatched container query');
      assert.deepEqual(await exactResources(), expected,
        'mismatched container query mutated Docker');

      const denied = [
        ['foreign inspect', 'GET', `/containers/${foreignContainerInfo.Id}/json`],
        ['foreign canonical inspect', 'GET', `/containers/tle-nr-${foreignInstanceId}/json`],
        ['foreign logs', 'GET', `/containers/${foreignContainerInfo.Id}/logs?stdout=1&stderr=1`],
        ['foreign stats', 'GET', `/containers/${foreignContainerInfo.Id}/stats?stream=0`],
        ['foreign network', 'GET', `/networks/${foreignNetworkInfo.Id}`],
        ['foreign canonical network', 'GET', `/networks/${this.networkPrefix}-${foreignInstanceId}`],
        ['encoded path', 'GET', `/containers/${allowedContainerId}%2fjson`],
        ['wrong method', 'POST', '/info'],
        ['archive read', 'GET', `/containers/${allowedContainerId}/archive?path=%2Fdata`],
        ['exec', 'POST', `/containers/${allowedContainerId}/exec`],
        ['events', 'GET', '/events'], ['volumes', 'GET', '/volumes'],
        ['image export', 'GET', `/images/${NODE_IMAGE}/get`], ['plugins', 'GET', '/plugins'],
        ['restart mismatch', 'POST', `/containers/${allowedContainerId}/restart?t=10`, { t: 9 }],
      ];
      for (const [name, method, path, requestBody] of denied) {
        const response = await this.proxyHttp(
          method, path, requestBody ?? (method === 'POST' ? {} : undefined),
        );
        assert.equal(response.status, 403, name);
        assert.deepEqual(await exactResources(), expected, `${name} mutated Docker`);
      }
      const foreignConnect = await this.proxyHttp(
        'POST', `/networks/${allowedNetworkId}/connect`, { Container: foreignContainerInfo.Id },
      );
      assert.equal(foreignConnect.status, 403);
      assert.deepEqual(await exactResources(), expected);
      const connect = await this.proxyHttp(
        'POST', `/networks/${allowedNetworkId}/connect`, { Container: managerProbeId },
      );
      assert.equal(connect.status, 200, connect.body);
      const disconnect = await this.proxyHttp(
        'POST', `/networks/${allowedNetworkId}/disconnect`, {
          Container: managerProbeId, Force: true,
        },
      );
      assert.equal(disconnect.status, 200, disconnect.body);
      const filtered = await this.proxyHttp('GET', `/containers/json?all=1&filters=${
        encodeURIComponent(JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }))
      }`);
      assert.equal(filtered.status, 200);
      assert.deepEqual(JSON.parse(filtered.body).map((item) => item.Id).sort(),
        [allowedContainerId, bootstrapContainerId].sort());
      const removedContainer = await this.proxyHttp(
        'DELETE', `/containers/${allowedContainerId}?force=true`, undefined,
      );
      assert.equal(removedContainer.status, 204, removedContainer.body);
      const removedContainerRead = await this.proxyHttp(
        'GET', `/containers/${allowedContainerId}/json`, undefined,
      );
      assert.equal(removedContainerRead.status, 404, removedContainerRead.body);
      const removedNetwork = await this.proxyHttp(
        'DELETE', `/networks/${allowedNetworkId}`, undefined,
      );
      assert.equal(removedNetwork.status, 204, removedNetwork.body);
      const removedNetworkRead = await this.proxyHttp(
        'GET', `/networks/${allowedNetworkId}`, undefined,
      );
      assert.equal(removedNetworkRead.status, 404, removedNetworkRead.body);
      this.proxyPolicyEvidence = {
        static: '82/82',
        liveDenied: maliciousNetworks.length + 1 + malicious.length + 1 + denied.length + 1,
      };
      this.proxyPolicyEvidence.denialLogCount = (await this.proxyDenialLines()).length;
    } finally {
      if (managerProbeId) await this.resources.removeContainer(managerProbeId).catch(() => undefined);
      if (bootstrapContainerId) await this.resources.removeContainer(bootstrapContainerId).catch(() => undefined);
      if (allowedContainerId) await this.resources.removeContainer(allowedContainerId).catch(() => undefined);
      if (bootstrapNetworkId) await this.resources.removeNetwork(bootstrapNetworkId).catch(() => undefined);
      if (allowedNetworkId) await this.resources.removeNetwork(allowedNetworkId).catch(() => undefined);
      await cleanupForeign();
      assert.deepEqual(await this.instanceDockerResiduals(instanceId), {
        containers: [], networks: [],
      });
    }
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
    const csrfId = this.id('csrf');
    const csrfBeforeDb = this.database();
    const csrfBefore = {
      instance: csrfBeforeDb.prepare('SELECT COUNT(*) AS n FROM instance WHERE id = ?').get(csrfId).n,
      journal: csrfBeforeDb.prepare(
        'SELECT COUNT(*) AS n FROM instance_node_migration WHERE instance_id = ?',
      ).get(csrfId).n,
      successAudit: csrfBeforeDb.prepare(
        `SELECT COUNT(*) AS n FROM audit
         WHERE target = ? AND action = 'create-instance' AND result = 'ok'`,
      ).get(csrfId).n,
    };
    csrfBeforeDb.close();
    const csrfDenied = await this.api('/api/instances', {
      method: 'POST', csrf: false,
      body: { id: csrfId, name: 'denied', imageTag: '5.0.4-24-minimal' },
    });
    assert.equal(csrfDenied.status, 403);
    const csrfAfterDb = this.database();
    assert.deepEqual({
      instance: csrfAfterDb.prepare('SELECT COUNT(*) AS n FROM instance WHERE id = ?').get(csrfId).n,
      journal: csrfAfterDb.prepare(
        'SELECT COUNT(*) AS n FROM instance_node_migration WHERE instance_id = ?',
      ).get(csrfId).n,
      successAudit: csrfAfterDb.prepare(
        `SELECT COUNT(*) AS n FROM audit
         WHERE target = ? AND action = 'create-instance' AND result = 'ok'`,
      ).get(csrfId).n,
    }, csrfBefore);
    csrfAfterDb.close();
    assert.deepEqual(await this.instanceDockerResiduals(csrfId), {
      containers: [], networks: [],
    });
    assert.equal(existsSync(join(this.dataRoot, 'instances', csrfId)), false);
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
        const envelope = JSON.parse(readRegularNoFollow(
          join(this.controlRoot, file), 16 * 1024,
        ).toString('utf8'));
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
      readFile: (path) => Promise.resolve(readRegularNoFollow(path).toString('utf8')),
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

  async instanceDockerResiduals(instanceId) {
    const filters = {
      label: [`${RUN_LABEL}=${this.runId}`, `${INSTANCE_LABEL}=${instanceId}`],
    };
    const containers = (await raw.listContainers({ all: true, filters }))
      .filter((item) => item.Labels?.[RUN_LABEL] === this.runId
        && item.Labels?.[INSTANCE_LABEL] === instanceId)
      .map((item) => item.Id).sort();
    const networks = (await raw.listNetworks({ filters }))
      .filter((item) => item.Labels?.[RUN_LABEL] === this.runId
        && item.Labels?.[INSTANCE_LABEL] === instanceId)
      .map((item) => item.Id).sort();
    return { containers, networks };
  }

  async platformInstallLogCount(id) {
    return (await this.platformPackageLogCounts(id)).install;
  }

  async platformPackageLogCounts(id) {
    const info = await this.currentContainer(id);
    const logs = dockerLogText(await raw.getContainer(info.Id).logs({ stdout: true, stderr: true }));
    return {
      install: (logs.match(/Installing module: @mqttsnet\/thinglinks-edge-nodes/g) ?? []).length,
      uninstall: (logs.match(
        /(?:Removing|Removed|Uninstalling|Uninstalled) module: @mqttsnet\/thinglinks-edge-nodes/g,
      ) ?? []).length,
    };
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
    assert.deepEqual(rollbackSnapshot(root), {
      checkpointFiles: expected.checkpointFiles,
      raw: expected.raw,
      edge: expected.edge,
      common: expected.common,
    });
    if (!expected.edge.exists || !expected.common.exists) {
      assert.equal(expected.edge.exists, false, 'non-staged Edge directory baseline');
      assert.equal(expected.common.exists, false, 'non-staged common directory baseline');
    }
    return this.currentContainer(id).then((info) => assert.equal(info.State.Running, expectedRunning));
  }

  assertPreservedFlowCredentials(id) {
    const expected = this.initialSnapshots.get(id);
    assert.ok(expected);
    const root = join(this.dataRoot, 'instances', id);
    const expectedFiles = new Map(expected.checkpointFiles.map((fact) => [fact.path, fact]));
    for (const path of ['flows.json', 'flows_cred.json']) {
      assert.deepEqual(artifactFact(root, path), expectedFiles.get(path));
    }
    assert.deepEqual(artifactFact(root, 'nodes'), expected.raw);
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
    if (operation.response.status !== 201) {
      throw new Error(`new instance API ${operation.response.status}: ${JSON.stringify(operation.response.body)}`
        + `; proxy=${await this.proxyDenialDiagnostics()}`);
    }
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
    assert.deepEqual(await this.instanceDockerResiduals(id), {
      containers: [], networks: [],
    });
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
        + ` node=${nodeLogs.slice(-3500)} manager=${managerLogs.slice(-300)}`
        + ` proxy=${await this.proxyDenialDiagnostics()}`);
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
    const repairedEnv = new Map(rebuilt.Config.Env.map((entry) => entry.split(/=(.*)/s, 2)));
    assert.equal(repairedEnv.get('TLE_INSTANCE_ID'), same.id);
    assert.equal(repairedEnv.get('TLE_ADMIN_ROOT'), `/red/${same.id}/`);
    assert.equal(repairedEnv.get('TLE_MANAGER_URL'), `http://${this.managerName}:19100`);
    assert.equal(repairedEnv.get('TLE_INGEST_TOKEN'),
      secret(this.master, `ingest-token:${same.id}`, 32));
    assert.equal(repairedEnv.get('NPM_CONFIG_REGISTRY'), `http://${this.managerName}:19100/npm/`);
    this.assertPreservedFlowCredentials(same.id);
    this.assertHealthyInventory(await this.inventory(same.id));
    await this.assertInstalledFiles(same.id);

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
    const rejectedEnv = new Map(rejectedNew.Config.Env.map((entry) => entry.split(/=(.*)/s, 2)));
    assert.equal(rejectedEnv.get('TLE_INSTANCE_ID'), rejected.id);
    assert.equal(rejectedEnv.get('TLE_ADMIN_ROOT'), `/red/${rejected.id}/`);
    assert.equal(rejectedEnv.get('TLE_MANAGER_URL'), `http://${this.managerName}:19100`);
    assert.equal(rejectedEnv.get('TLE_INGEST_TOKEN'),
      secret(this.master, `ingest-token:${rejected.id}`, 32));
    assert.equal(rejectedEnv.get('NPM_CONFIG_REGISTRY'), `http://${this.managerName}:19100/npm/`);
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
    const instanceDataRoot = join(this.dataRoot, 'instances');
    const stagedRoot = join(instanceDataRoot, staged.id);
    const npmRoot = join(stagedRoot, 'node_modules', '@mqttsnet');
    const edgeBefore = treeHash(join(npmRoot, 'thinglinks-edge-nodes'));
    const commonBefore = treeHash(join(npmRoot, 'thinglinks-node-red-common'));
    const packageLogsBefore = await this.platformPackageLogCounts(staged.id);
    const runtimeBefore = containerRuntimeFact(await this.currentContainer(staged.id));
    const filesBefore = rollbackSnapshot(stagedRoot);
    const migrationRootBefore = artifactFact(instanceDataRoot, '.thinglinks-migration');
    const stoppedEvidenceBefore = artifactFact(instanceDataRoot, '.thinglinks-stopped-evidence');
    const readyBefore = this.readyFiles();
    const knownReadyBefore = this.knownReady.size;
    const rejectedStaged = await this.migrateFixture('staged');
    assert.equal(rejectedStaged.response.status, 409);
    assert.deepEqual(rejectedStaged.response.body, {
      error: '迁移预检未通过，请检查实例状态后重试', code: 'preflight',
    });
    assert.deepEqual(rejectedStaged.events, [], 'running stagedBefore reached a mutation barrier');
    assert.deepEqual(containerRuntimeFact(await this.currentContainer(staged.id)), runtimeBefore);
    assert.deepEqual(rollbackSnapshot(stagedRoot), filesBefore);
    assert.deepEqual(artifactFact(instanceDataRoot, '.thinglinks-migration'), migrationRootBefore);
    assert.deepEqual(artifactFact(instanceDataRoot, '.thinglinks-stopped-evidence'), stoppedEvidenceBefore);
    assert.deepEqual(this.readyFiles(), readyBefore);
    assert.equal(this.knownReady.size, knownReadyBefore);
    assert.deepEqual(await this.platformPackageLogCounts(staged.id), packageLogsBefore);
    const rejectedDb = this.database();
    assert.equal(rejectedDb.prepare(
      'SELECT COUNT(*) AS n FROM instance_node_migration WHERE instance_id = ?',
    ).get(staged.id).n, 0);
    assert.deepEqual(rejectedDb.prepare(
      `SELECT node_runtime_mode AS mode, node_migration_state AS phase
       FROM instance WHERE id = ?`,
    ).get(staged.id), { mode: 'legacy', phase: 'idle' });
    rejectedDb.close();

    const stop = await this.api(`/api/instances/${staged.id}/stop`, {
      method: 'POST', body: {},
    });
    assert.equal(stop.status, 204,
      `running stagedBefore stop ${stop.status}: ${JSON.stringify(stop.body)}`);
    assert.equal((await this.currentContainer(staged.id)).State.Running, false);
    const stagedResult = await this.migrateFixture('staged');
    assert.equal(stagedResult.response.status, 200);
    assert.equal(stagedResult.response.body.phase, 'pending_start_verification',
      `staged response ${JSON.stringify(stagedResult.response.body)}`);
    assert.equal((await this.currentContainer(staged.id)).State.Running, false);
    assert.equal(treeHash(join(npmRoot, 'thinglinks-edge-nodes')), edgeBefore);
    assert.equal(treeHash(join(npmRoot, 'thinglinks-node-red-common')), commonBefore);
    assert.deepEqual(await this.platformPackageLogCounts(staged.id), packageLogsBefore,
      'stopped stagedBefore migration mutated the production package through Admin');
    const stagedDb = this.database();
    assert.equal(stagedDb.prepare(
      'SELECT staged_before FROM instance_node_migration WHERE instance_id = ?',
    ).get(staged.id).staged_before, 1);
    stagedDb.close();
    const stagedStart = await this.barrierApi(`/api/instances/${staged.id}/start`, {
      method: 'POST', body: {},
    });
    if (stagedStart.response.status !== 204) {
      const failedStatus = await this.migrationStatus(staged.id);
      const failedDb = this.database();
      const failedJournal = failedDb.prepare(
        `SELECT tx_id AS txId, phase, error, original_running AS originalRunning,
                staged_before AS stagedBefore, checkpoint_dir AS checkpointDir
         FROM instance_node_migration WHERE instance_id = ?`,
      ).get(staged.id);
      failedDb.close();
      const currentSnapshot = rollbackSnapshot(stagedRoot);
      const snapshotDiff = rollbackSnapshotDiff(this.initialSnapshots.get(staged.id), currentSnapshot);
      const sidecars = failedJournal?.txId
        ? transactionSidecars(stagedRoot, failedJournal.txId)
          .map((path) => relative(stagedRoot, path))
        : [];
      const authorityPath = failedJournal?.txId ? join(
        instanceDataRoot, '.thinglinks-stopped-evidence', staged.id,
        failedJournal.txId, 'manifest.json',
      ) : '';
      const authority = authorityPath && existsSync(authorityPath)
        ? JSON.parse(readRegularNoFollow(authorityPath).toString('utf8'))
        : undefined;
      const initialFiles = new Map(this.initialSnapshots.get(staged.id).checkpointFiles
        .map((fact) => [fact.path, fact]));
      const currentFiles = new Map(currentSnapshot.checkpointFiles
        .map((fact) => [fact.path, fact]));
      const compactFact = (fact) => fact && ({
        exists: fact.exists, kind: fact.kind, mode: fact.mode, sha256: fact.sha256,
      });
      const changedFacts = snapshotDiff.map((key) => {
        const stopped = authority?.artifacts?.find((artifact) => artifact.key === key);
        return {
          key,
          initial: compactFact(initialFiles.get(key)),
          current: compactFact(currentFiles.get(key)),
          prior: compactFact(stopped?.prior),
          desired: compactFact(stopped?.desired),
        };
      });
      const checkpoint = failedJournal?.checkpointDir
        ? artifactFact(instanceDataRoot, failedJournal.checkpointDir) : undefined;
      const stoppedEvidence = failedJournal?.txId ? artifactFact(instanceDataRoot,
        join('.thinglinks-stopped-evidence', staged.id, failedJournal.txId)) : undefined;
      const nodeLogs = dockerLogText(await raw.getContainer(containerName(staged.id))
        .logs({ stdout: true, stderr: true, tail: 400 }));
      const relevantNodeLogs = nodeLogs.split('\n').filter((line) => (
        /error|warn|tl-|module|palette|failed|not found/i.test(line)
      )).slice(-40).join(' | ');
      const managerLogs = dockerLogText(await raw.getContainer(this.managerId)
        .logs({ stdout: true, stderr: true, tail: 200 }));
      throw new Error(`stagedBefore explicit start failed: response=${JSON.stringify(stagedStart.response)}`
        + ` status=${JSON.stringify(failedStatus)} journal=${JSON.stringify(failedJournal)}`
        + ` events=${stagedStart.events.map((event) => `${event.phase}/${event.boundary}`).join(',')}`
        + ` changedFacts=${JSON.stringify(changedFacts)}`
        + ` sidecarCount=${sidecars.length} checkpoint=${JSON.stringify(checkpoint)}`
        + ` stoppedEvidence=${JSON.stringify(stoppedEvidence)}`
        + ` packageLogs=${JSON.stringify(await this.platformPackageLogCounts(staged.id))}`
        + ` node=${relevantNodeLogs.slice(-3500)} manager=${managerLogs.slice(-500)}`);
    }
    assert.equal(stagedStart.response.status, 204,
      `stagedBefore explicit start ${stagedStart.response.status}: `
        + JSON.stringify(stagedStart.response.body));
    const stagedStatus = await this.migrationStatus(staged.id);
    assert.equal(stagedStatus.phase, 'committed');
    assert.equal(stagedStatus.runtimeMode, 'npm');
    assert.equal((await this.currentContainer(staged.id)).State.Running, true);
    this.assertPreservedFlowCredentials(staged.id);
    this.assertHealthyInventory(await this.inventory(staged.id));
    await this.assertInstalledFiles(staged.id);
    assert.equal(treeHash(join(npmRoot, 'thinglinks-edge-nodes')), edgeBefore);
    assert.equal(treeHash(join(npmRoot, 'thinglinks-node-red-common')), commonBefore);
    assert.deepEqual(await this.platformPackageLogCounts(staged.id), packageLogsBefore,
      'stagedBefore retry unexpectedly mutated the production package through Admin');
    pass('same-image-rebuild', {
      successBoundary: true, throwBoundary: true, noJournalOnThrow: true,
      stagedBefore: true, runningRejectedReadOnly: true,
      stoppedProbe: true, explicitStart: true,
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
      `SELECT tx_id AS txId, checkpoint_dir AS checkpointDir,
              original_running AS originalRunning, staged_before AS stagedBefore
       FROM instance_node_migration WHERE instance_id = ?`,
    ).get(fixture.id);
    assert.equal(Boolean(journal.originalRunning), originalRunning);
    const instanceDataRoot = join(this.dataRoot, 'instances');
    const expected = this.initialSnapshots.get(fixture.id);
    assert.equal(Boolean(journal.stagedBefore), expected.edge.exists && expected.common.exists);
    assert.equal(existsSync(join(instanceDataRoot, journal.checkpointDir)), false);
    assert.equal(existsSync(join(instanceDataRoot, `${journal.checkpointDir}.partial`)), false);
    assert.equal(existsSync(join(
      instanceDataRoot, '.thinglinks-stopped-evidence', fixture.id, journal.txId,
    )), false);
    assert.deepEqual(transactionSidecars(join(instanceDataRoot, fixture.id), journal.txId), []);
    db.close();
  }

  async verifyRollbackInjections() {
    const observed = [];
    const staged = this.fixture('staged-rb');
    const stagedNpmRoot = join(
      this.dataRoot, 'instances', staged.id, 'node_modules', '@mqttsnet',
    );
    const stagedEdgeBefore = treeHash(join(stagedNpmRoot, 'thinglinks-edge-nodes'));
    const stagedCommonBefore = treeHash(join(stagedNpmRoot, 'thinglinks-node-red-common'));
    const stagedLogsBefore = {
      install: this.initialSnapshots.get(staged.id).installLogCount,
      uninstall: this.initialSnapshots.get(staged.id).uninstallLogCount,
    };
    let stagedInjected = false;
    const stagedRollback = await this.migrateFixture('staged-rb', (event) => {
      if (event.boundary === 'after-live-rename' && event.artifact === 'settings') {
        stagedInjected = true;
        observed.push('stagedBefore-stopped:after-live-rename:settings');
        return { action: 'throw', code: 'VERIFY_STOPPED_THROW' };
      }
      return { action: 'continue' };
    });
    assert.equal(stagedInjected, true, 'stagedBefore stopped live rename boundary not reached');
    assert.equal(stagedRollback.response.status, 200);
    assert.equal(stagedRollback.response.body.phase, 'rolled_back');
    await this.assertRolledBack('staged-rb', false);
    assert.equal(treeHash(join(stagedNpmRoot, 'thinglinks-edge-nodes')), stagedEdgeBefore);
    assert.equal(treeHash(join(stagedNpmRoot, 'thinglinks-node-red-common')), stagedCommonBefore);
    assert.deepEqual(await this.platformPackageLogCounts(staged.id), stagedLogsBefore,
      'stagedBefore rollback installed or uninstalled the production package');
    await this.assertInstalledFiles(staged.id);

    const stagedRetry = await this.migrateFixture('staged-rb');
    assert.equal(stagedRetry.response.status, 200);
    assert.equal(stagedRetry.response.body.phase, 'pending_start_verification');
    assert.equal((await this.currentContainer(staged.id)).State.Running, false);
    const stagedDb = this.database();
    assert.deepEqual(stagedDb.prepare(
      `SELECT original_running AS originalRunning, staged_before AS stagedBefore
       FROM instance_node_migration WHERE instance_id = ?`,
    ).get(staged.id), { originalRunning: 0, stagedBefore: 1 });
    stagedDb.close();
    assert.equal(treeHash(join(stagedNpmRoot, 'thinglinks-edge-nodes')), stagedEdgeBefore);
    assert.equal(treeHash(join(stagedNpmRoot, 'thinglinks-node-red-common')), stagedCommonBefore);
    assert.deepEqual(await this.platformPackageLogCounts(staged.id), stagedLogsBefore);
    const stagedStart = await this.barrierApi(`/api/instances/${staged.id}/start`, {
      method: 'POST', body: {},
    });
    assert.equal(stagedStart.response.status, 204,
      `stagedBefore rollback retry start ${stagedStart.response.status}: `
        + JSON.stringify(stagedStart.response.body));
    const stagedCommitted = await this.migrationStatus(staged.id);
    assert.equal(stagedCommitted.phase, 'committed');
    assert.equal(stagedCommitted.runtimeMode, 'npm');
    assert.equal((await this.currentContainer(staged.id)).State.Running, true);
    this.assertPreservedFlowCredentials(staged.id);
    this.assertHealthyInventory(await this.inventory(staged.id));
    await this.assertInstalledFiles(staged.id);
    assert.equal(treeHash(join(stagedNpmRoot, 'thinglinks-edge-nodes')), stagedEdgeBefore);
    assert.equal(treeHash(join(stagedNpmRoot, 'thinglinks-node-red-common')), stagedCommonBefore);
    assert.deepEqual(await this.platformPackageLogCounts(staged.id), stagedLogsBefore,
      'stagedBefore retry installed or uninstalled the production package');
    this.stagedRollbackVerified = true;
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
      stagedBeforeStoppedLiveRename: this.stagedRollbackVerified,
      stagedBeforeRetryCommitted: true,
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
    this.resetSharedFile(this.routeLog);
    this.routeProxyName = `${this.runId}-route-proxy`;
    const created = await this.createContainer({
      Image: this.managerImageId,
      User: 'node',
      Cmd: ['node', '/verify/entry.mjs', 'route-proxy'],
      Env: [
        `VERIFY_ROUTE_UPSTREAM=http://${this.managerName}:19100`,
        `VERIFY_ROUTE_LOG=${this.routeLog}`,
        `VERIFY_ROUTE_ROOT=${this.resultsRoot}`,
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
    const instanceDataRoot = trustedDirectoryWithin(this.root,
      join(this.dataRoot, 'instances'));
    const source = trustedDirectoryWithin(instanceDataRoot, join(instanceDataRoot, instanceId));
    assert.equal(existsSync(targetRoot), false, `clone target already exists ${targetRoot}`);
    cpSync(source, targetRoot, {
      recursive: true, force: false, errorOnExist: true,
    });
    trustedDirectoryWithin(this.root, targetRoot);
    makeTreeWritable(targetRoot);
    const start = await this.api(`/api/instances/${instanceId}/start`, { method: 'POST', body: {} });
    assert.equal(start.status, 204);
    assert.equal((await this.currentContainer(instanceId)).State.Running, true);
  }

  async renderHarness(targetRoot, allowEdge) {
    trustedDirectoryWithin(this.root, targetRoot);
    const logs = await this.runOneShot('render-harness-settings', {
      EDGE_DATA_ROOT: this.dataRoot,
      MASTER_KEY: this.master,
      VERIFY_SOURCE_INSTANCE: this.harnessSourceId,
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
    const allowMatch = /^\s*allowList:\s*(\[[^\r\n]*\])/m.exec(settings);
    assert.ok(allowMatch, 'rendered allowList missing');
    const allowList = JSON.parse(allowMatch[1]);
    assert.equal(allowList.includes(
      `${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`,
    ), allowEdge);
    assert.equal(allowList.some((entry) => entry.includes(PLATFORM_COMMON_PACKAGE.name)), false);
  }

  async startHarness(targetRoot, networkId) {
    trustedDirectoryWithin(this.root, targetRoot);
    if (this.harnessId) await this.resources.removeContainer(this.harnessId);
    this.harnessName = `${this.runId}-node-red-harness`;
    const token = (await this.currentContainer(this.harnessSourceId)).Config.Env
      .find((entry) => entry.startsWith('TLE_INGEST_TOKEN='))?.slice('TLE_INGEST_TOKEN='.length);
    assert.ok(token);
    const created = await this.createContainer({
      Image: this.nodeImageId,
      User: 'node-red',
      Env: [
        'TZ=UTC',
        `TLE_INSTANCE_ID=${this.harnessSourceId}`,
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
    assert.equal(environment.get('TLE_INSTANCE_ID'), this.harnessSourceId);
    assert.equal(environment.get('TLE_MANAGER_URL'), `http://${this.routeProxyName}:3000`);
    assert.equal(environment.get('TLE_INGEST_TOKEN'), token);
    await created.container.start();
    return created.id;
  }

  async harnessRequest(path, options = {}) {
    const root = `/red/${this.harnessSourceId}/`;
    const password = secret(this.master, `harness-password:${this.harnessSourceId}`, 28);
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

  async allowlistInventoryEvidence(inventory) {
    const rawPaths = PLATFORM_NODE_TYPES.map((type) => `/data/nodes/${type}.js`);
    const rawProbe = await execIn(this.harnessId, [
      'node', '-e',
      `const fs=require('fs');const paths=${JSON.stringify(rawPaths)};`
        + `const files=paths.map(path=>{try{const stat=fs.lstatSync(path);return {`
        + `basename:path.split('/').at(-1),canonicalContainerPath:fs.realpathSync(path),`
        + `regular:stat.isFile(),symlink:stat.isSymbolicLink()}}catch(error){return {`
        + `basename:path.split('/').at(-1),canonicalContainerPath:path,missing:error.code==='ENOENT'}}});`
        + `console.log('TLE_RAW_FILES:'+JSON.stringify(files));`,
    ], 15_000);
    assert.equal(rawProbe.code, 0, rawProbe.output.slice(-500));
    const rawLine = rawProbe.output.replace(/\r/g, '').split('\n')
      .find((entry) => entry.startsWith('TLE_RAW_FILES:'));
    assert.ok(rawLine, `raw file probe missing: ${rawProbe.output.slice(-500)}`);
    const rawFiles = JSON.parse(rawLine.slice('TLE_RAW_FILES:'.length));
    const rawByBasename = new Map(rawFiles.map((file) => [file.basename, file]));
    const owners = [];
    for (const entry of inventory) {
      let candidates;
      if (Array.isArray(entry?.types)) {
        candidates = [entry];
      } else if (Array.isArray(entry?.nodes)) {
        candidates = entry.nodes.map((node) => ({ ...entry, ...node }));
      } else if (entry?.nodes && typeof entry.nodes === 'object') {
        candidates = Object.entries(entry.nodes).map(([name, node]) => ({
          ...entry, ...(node && typeof node === 'object' ? node : {}), name,
        }));
      } else {
        candidates = [];
      }
      for (const candidate of candidates) {
        for (const type of typesFromInventoryEntry(candidate)
          .filter((value) => PLATFORM_NODE_TYPES.includes(value))) {
          const file = typeof candidate.file === 'string' ? candidate.file : '';
          const rawFile = rawByBasename.get(`${type}.js`);
          const canonicalContainerPath = file.startsWith('/data/')
            && /^\/data\/[A-Za-z0-9@._/-]+$/.test(file)
            ? file
            : candidate.module === 'node-red' ? rawFile?.canonicalContainerPath ?? null : null;
          owners.push({
            module: candidate.module ?? entry.module ?? null,
            name: candidate.name ?? entry.name ?? null,
            type,
            enabled: candidate.enabled ?? entry.enabled ?? null,
            fileBasename: file ? file.split('/').at(-1) : rawFile?.basename ?? null,
            canonicalContainerPath,
          });
        }
      }
    }
    const logs = dockerLogText(await raw.getContainer(this.harnessId)
      .logs({ stdout: true, stderr: true, tail: 500 }));
    const relevantLogs = logs.split('\n').filter((line) => (
      /tl-|node|module|palette|allow|deny|exclude|error|warn|register/i.test(line)
    )).slice(-80).map((line) => safeError({ message: line }));
    return { owners, rawFiles, relevantLogs };
  }

  async harnessInventory(expectedLoaded) {
    const stable = inventoryStability(expectedLoaded);
    let lastInventory = [];
    let lastState;
    let inventory;
    try {
      inventory = await waitFor('stable harness Node-RED inventory', async () => {
        const response = await this.harnessRequest('nodes').catch(() => undefined);
        if (!response || response.status !== 200) return undefined;
        const value = Array.isArray(response.body) ? response.body : response.body?.modules;
        if (!Array.isArray(value)) return undefined;
        lastInventory = value;
        const observed = stable.observe(value);
        lastState = { ...observed.state, consecutive: observed.consecutive };
        return observed.ready ? value : undefined;
      }, { timeoutMs: 90_000, intervalMs: 250 });
    } catch (error) {
      let evidence = { owners: [], rawFiles: [], relevantLogs: [] };
      if (this.harnessId && lastInventory.length > 0) {
        try {
          evidence = await this.allowlistInventoryEvidence(lastInventory);
        } catch (diagnosticError) {
          evidence = {
            ...evidence,
            diagnosticError: safeError(diagnosticError),
          };
        }
      }
      process.stderr.write(`ALLOWLIST_INVENTORY_TIMEOUT ${JSON.stringify({
        expectedLoaded, lastState: lastState ?? null, ...evidence,
      })}\n`);
      throw error;
    }
    assert.deepEqual(
      moduleTypes(inventory, PLATFORM_NODE_PACKAGE.name),
      expectedLoaded ? [...PLATFORM_NODE_TYPES].sort() : [],
    );
    assert.deepEqual(moduleTypes(inventory, PLATFORM_COMMON_PACKAGE.name), []);
    if (!expectedLoaded) {
      const all = new Set(inventory.flatMap(typesFromInventoryEntry));
      const leakedTypes = PLATFORM_NODE_TYPES.filter((type) => all.has(type));
      assert.deepEqual(leakedTypes, [], `allowList negative leaked ${leakedTypes.join(',')}`);
    } else {
      for (const type of PLATFORM_NODE_TYPES) {
        const owners = inventory.filter((entry) => typesFromInventoryEntry(entry).includes(type))
          .map((entry) => entry.module ?? entry.name ?? entry.id);
        assert.deepEqual(owners, [PLATFORM_NODE_PACKAGE.name], `${type} owner`);
      }
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
    this.resetSharedFile(join(this.resultsRoot, 'flow-output.ndjson'));
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
    const expectedOutput = {
      payload: expectedMessage,
      quality: 'good',
      canary: `canary-${this.flowMarker}`,
    };
    assert.deepEqual(output, expectedOutput);
    const token = (await this.currentContainer(this.harnessSourceId)).Config.Env
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
    ).get(this.harnessSourceId, forgedNode).n, 1);
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
    ).get(this.harnessSourceId, 'device-01').n, 1);
    assert.equal(after.prepare(
      'SELECT online FROM field_device WHERE instance_id = ? AND node_id = ?',
    ).get(this.harnessSourceId, 'device-01').online, 1);
    assert.equal(after.prepare(
      'SELECT COUNT(*) AS n FROM field_tag WHERE instance_id = ? AND node_id = ?',
    ).get(this.harnessSourceId, 'device-01').n >= 2, true);
    const values = new Map(after.prepare(
      `SELECT tag_id AS tagId, last_value AS lastValue FROM field_tag
       WHERE instance_id = ? AND node_id = ?`,
    ).all(this.harnessSourceId, 'device-01').map((row) => [row.tagId, JSON.parse(row.lastValue)]));
    assert.equal(values.get('temperature'), 23);
    assert.equal(values.get('marker'), this.flowMarker);
    assert.equal(values.get('instanceId'), 'forged-instance');
    assert.ok(after.prepare(
      'SELECT COUNT(*) AS n FROM field_value_history WHERE instance_id = ?',
    ).get(this.harnessSourceId).n >= 2);
    after.close();
    const commonPath = join(targetRoot, 'node_modules', '@mqttsnet', 'thinglinks-node-red-common');
    assert.ok(existsSync(commonPath));
    const rawCommonPath = join(targetRoot, 'nodes', 'tl-common.js');
    assert.equal(existsSync(rawCommonPath), true, 'legacy raw common helper was deleted');
    assert.equal(sha256(readFileSync(rawCommonPath)), LEGACY_PLATFORM_FILES['tl-common.js'],
      'legacy raw common helper changed');
    return { routes, token, expectedOutput };
  }

  async startPausedBroker() {
    const config = join(this.root, 'mosquitto.conf');
    writeExclusiveFile(config, 'listener 1883\nallow_anonymous true\npersistence false\n', 0o600);
    const name = `${this.runId}-mqtt`;
    const created = await this.createContainer({
      Image: this.mosquittoImageId,
      User: '1883:1883',
      Entrypoint: ['/usr/sbin/mosquitto'],
      Cmd: ['-c', '/verify/mosquitto.conf'],
      HostConfig: {
        NetworkMode: this.controlNetworkId,
        ReadonlyRootfs: true,
        Binds: [`${config}:/verify/mosquitto.conf:ro`],
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=16m',
          '/mosquitto/data': 'rw,noexec,nosuid,size=16m',
          '/mosquitto/log': 'rw,noexec,nosuid,size=16m',
        },
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

  async verify503Passthrough(token, expectedOutput) {
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
    this.resetSharedFile(this.routeLog);
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
    assert.deepEqual(readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).at(-1), expectedOutput);
    const logs = (await raw.getContainer(this.harnessId).logs({ stdout: true, stderr: true }))
      .toString('utf8');
    assert.match(logs, /回报失败 uplink：HTTP 503/);
    assert.equal((await this.migrationStatus(this.harnessSourceId)).phase, 'committed');
    await raw.getContainer(this.brokerId).unpause();
  }

  async verifyAllowlistAndRealFlow() {
    this.harnessSourceId = this.fixture('runok').id;
    this.flowMarker = `message-${this.instancePrefix}`;
    await this.deployFlows(this.harnessSourceId, acceptanceFlow(this.flowMarker));
    const harnessRoot = join(this.root, 'allowlist-harness');
    await this.cloneManagedData(this.harnessSourceId, harnessRoot);
    assertCanonicalRaw(harnessRoot);
    const networkId = await this.startRouteProxy(this.harnessSourceId);
    await this.renderHarness(harnessRoot, true);
    await this.startHarness(harnessRoot, networkId);
    await this.harnessInventory(true);
    pass('allowlist-positive', { types: [...PLATFORM_NODE_TYPES], rawExcluded: true });
    const five = await this.verifyFiveRoutesAndOwnership(harnessRoot);
    await this.verify503Passthrough(five.token, five.expectedOutput);

    await this.resources.removeContainer(this.harnessId);
    this.harnessId = undefined;
    this.resetSharedFile(this.routeLog);
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
    this.resetSharedFile(this.routeLog);
    await this.renderHarness(harnessRoot, true);
    await this.startHarness(harnessRoot, networkId);
    await this.harnessInventory(true);
    const beforeRecovery = readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).length;
    await this.harnessRequest('inject/acceptance-inject', { method: 'POST', body: {} });
    await waitFor('allowlist recovery flow', () => (
      readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).length > beforeRecovery
    ), { timeoutMs: 20_000 });
    assert.deepEqual(readNdjson(join(this.resultsRoot, 'flow-output.ndjson')).at(-1),
      five.expectedOutput);
    pass('allowlist-recovery', { types: [...PLATFORM_NODE_TYPES], flowReturned: true });

    await this.resources.removeContainer(this.harnessId);
    this.harnessId = undefined;
    await this.deployFlows(this.harnessSourceId, invalidFlow());
    const invalidRoot = join(this.root, 'invalid-harness');
    await this.cloneManagedData(this.harnessSourceId, invalidRoot);
    await this.renderHarness(invalidRoot, true);
    this.resetSharedFile(this.routeLog);
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

  async cleanup(options = {}) {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      const errors = [];
      const attempt = async (label, task) => {
        try { await task(); } catch (error) { errors.push(new Error(`${label}: ${safeError(error)}`)); }
      };
      await attempt('stop Manager', () => this.stopManager(true));
      for (let passNumber = 0; passNumber < 3; passNumber += 1) {
        await attempt('discover containers', () => this.resources.discover());
        const ids = [...this.resources.containers.keys()]
          .sort((left, right) => Number(left === this.proxyId) - Number(right === this.proxyId));
        for (const id of ids) await attempt(`remove container ${id}`, () => this.resources.removeContainer(id));
        await attempt('rediscover containers', () => this.resources.discover());
        if (this.resources.containers.size === 0) break;
      }
      for (let passNumber = 0; passNumber < 3; passNumber += 1) {
        await attempt('discover networks', () => this.resources.discover());
        for (const id of [...this.resources.networks.keys()]) {
          await attempt(`remove network ${id}`, () => this.resources.removeNetwork(id));
        }
        await attempt('rediscover networks', () => this.resources.discover());
        if (this.resources.networks.size === 0) break;
      }

      if (this.root && existsSync(this.root)) {
        let cleanupRootValidated = false;
        await attempt('validate cleanup root', async () => {
          const stat = lstatSync(this.root);
          assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
          assert.equal(realpathSync(this.root), this.root);
          assert.equal(dirname(this.root), '/private/tmp');
          assert.ok(this.root.startsWith(`/private/tmp/${this.runId}-`));
          cleanupRootValidated = true;
        });
        if (cleanupRootValidated && this.managerImageId) {
          await attempt('repair cleanup permissions', async () => {
            const cleanupName = `${this.runId}-permission-cleanup`;
            const { container, id } = await this.createContainer({
              Image: this.managerImageId,
              User: 'root',
              Cmd: ['node', '/verify/entry.mjs', 'permission-cleanup'],
              Env: ['VERIFY_PERMISSION_ROOT=/cleanup'],
              HostConfig: {
                NetworkMode: 'none', ReadonlyRootfs: true,
                Binds: [`${this.root}:/cleanup`, `${ENTRY_PATH}:/verify/entry.mjs:ro`],
                CapDrop: ['ALL'], CapAdd: ['FOWNER', 'DAC_OVERRIDE'],
                SecurityOpt: ['no-new-privileges:true'],
              },
              Labels: {},
            }, cleanupName);
            await container.start();
            const result = await container.wait({ condition: 'not-running' });
            assert.equal(result.StatusCode, 0, 'permission cleanup failed');
            await this.resources.removeContainer(id);
          });
        }
        if (cleanupRootValidated) {
          await attempt('remove cleanup root', async () => {
            const stat = lstatSync(this.root);
            assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
            assert.equal(realpathSync(this.root), this.root);
            assert.equal(dirname(this.root), '/private/tmp');
            assert.ok(this.root.startsWith(`/private/tmp/${this.runId}-`));
            rmSync(this.root, { recursive: true, force: false });
            assert.equal(existsSync(this.root), false);
          });
        }
      }
      await attempt('final resource discovery', () => this.resources.discover());
      if (this.resources.containers.size > 0) errors.push(new Error('task-owned containers remain'));
      if (this.resources.networks.size > 0) errors.push(new Error('task-owned networks remain'));
      if (errors.length > 0 && options.bestEffort !== true) throw new AggregateError(errors, 'cleanup failed');
      return errors;
    })();
    return this.cleanupPromise;
  }
}

function installBoundedSignalCleanup(verifier) {
  let handling = false;
  const handlers = new Map();
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      if (handling) return;
      handling = true;
      const timeout = new Promise((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, 30_000);
        timer.unref();
      });
      void Promise.race([verifier.cleanup({ bestEffort: true }), timeout])
        .finally(() => process.exit(code));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (
    args.length === 1 && args[0] === '--proxy-policy-test'
  ), 'usage: verify-platform-nodes.mjs [--proxy-policy-test]');
  const proxyOnly = args[0] === '--proxy-policy-test';
  const inventoryPolicy = runInventoryStabilitySelfTests();
  assert.equal(inventoryPolicy.passed, inventoryPolicy.total);
  process.stdout.write(
    `  PASS inventory-stability-self-test ${inventoryPolicy.passed}/${inventoryPolicy.total}\n`,
  );
  const proxyPolicy = await runProxyPolicySelfTests();
  assert.equal(proxyPolicy.passed, proxyPolicy.total);
  process.stdout.write(`  PASS proxy-policy-self-test ${proxyPolicy.passed}/${proxyPolicy.total}\n`);
  const verifier = new PlatformVerifier();
  const removeSignalHandlers = installBoundedSignalCleanup(verifier);
  let before;
  let protectedBefore;
  let completed = false;
  let proxyOnlyComplete = false;
  let operationError;
  try {
    before = await relevantDockerSnapshot();
    protectedBefore = await protectedDockerSnapshot();
    verifier.initializeWorkspace();
    await verifier.initializeImages();
    await verifier.startDockerProxy();
    await verifier.verifyLiveDockerProxyPolicy();
    if (proxyOnly) {
      proxyOnlyComplete = true;
    } else {
      await verifier.buildFixtures();
      await verifier.createAllFixtures();
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
    }
  } catch (error) {
    operationError = new Error(`proxy=${await verifier.proxyDenialDiagnostics()}; operation=${safeError(error)}`);
  }
  let cleanupError;
  try {
    await verifier.cleanup();
    if (before) {
      const after = await relevantDockerSnapshot();
      baselineResourcesUnchanged(before, after, new Set([
        verifier.managerImageId, verifier.nodeImageId, verifier.mosquittoImageId,
      ].filter(Boolean)));
    }
    if (protectedBefore) {
      assert.deepEqual(await protectedDockerSnapshot(), protectedBefore,
        'protected Manager or line-1 identity/state/network changed');
    }
    if (completed) {
      pass('cleanup', {
        containers: 0, networks: 0, dataRoots: 0,
        baselineContainersUnchanged: true, baselineNetworksUnchanged: true,
      });
    }
  } catch (error) {
    cleanupError = error;
  }
  removeSignalHandlers();
  if (operationError && cleanupError) {
    throw new Error(`operation failed: ${safeError(operationError)}; cleanup failed: ${safeError(cleanupError)}`);
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (proxyOnlyComplete) {
    process.stdout.write(`proxy-policy-live:${verifier.proxyPolicyEvidence.liveDenied} denied PASS · cleanup PASS\n`);
    return;
  }
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
