/**
 * 实例间网络隔离验证。
 *
 * 背景：Node-RED 的 Function 节点等于容器内 RCE（Node 官方明确 vm 不是安全机制）。
 * 若实例共处一个网络，实例 A 的 Function 节点可直接 fetch 实例 B 的 1880，
 * 绕过 Manager 的全部鉴权 —— 这是设计级漏洞，必须在真实环境验证而非假设。
 *
 * 用法： node scripts/verify-isolation.mjs
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import Docker from 'dockerode';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { tarFile } from '../dist/core/archive/tar.js';
import { adminRootFor } from '../dist/core/config.js';
import {
  assertSafeCreateOptions,
  buildCreateOptions,
  containerName,
} from '../dist/core/instance/container-spec.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { renderSettings } from '../dist/core/instance/settings-template.js';
import {
  VERIFIER_INVOCATION_LABEL,
  assertExactDockerResource,
  createFixtureIdentity,
  exactResourceLabels,
  resolveCanonicalTempParent,
} from './_real-instance-fixture.mjs';

const IMAGE_TAG = '5.0.4-24-minimal';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const identity = createFixtureIdentity({ suite: 'iso', roles: ['a', 'b'] });
const A = identity.instances.a;
const B = identity.instances.b;
const NET = identity.networkPrefix;
const raw = new Docker();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dockerRef = (docker, kind, ref) => kind === 'container'
  ? docker.getContainer(ref)
  : docker.getNetwork(ref);

const inspectOrAbsent = async (docker, kind, ref) => {
  try {
    return await dockerRef(docker, kind, ref).inspect();
  } catch (error) {
    if (error?.statusCode === 404) return undefined;
    throw error;
  }
};

export async function requireDockerNameAbsent(docker, kind, name) {
  if (await inspectOrAbsent(docker, kind, name)) {
    throw new Error(`verifier ${kind} name is already occupied: ${name}`);
  }
}

export async function captureCreatedDockerResource(
  docker,
  ledger,
  { kind, name, labels, created },
) {
  if (!created?.id || typeof created.id !== 'string') {
    throw new Error(`created ${kind} ${name} did not return an immutable id`);
  }
  const expected = { kind, id: created.id, name, labels };
  // Record immediately after the side effect. Any later inspection failure must
  // still leave enough immutable evidence for the final cleanup attempt.
  ledger.push(expected);
  assertExactDockerResource(await inspectOrAbsent(docker, kind, expected.id), expected);
  assertExactDockerResource(await inspectOrAbsent(docker, kind, expected.name), expected);
  return expected;
}

async function removeTrackedDockerResource(docker, expected) {
  const byId = await inspectOrAbsent(docker, expected.kind, expected.id);
  if (!byId) {
    const replacement = await inspectOrAbsent(docker, expected.kind, expected.name);
    if (replacement) {
      throw new Error(
        `recorded ${expected.kind} ${expected.id} disappeared but ${expected.name} was replaced`,
      );
    }
    return;
  }
  assertExactDockerResource(byId, expected);
  const byName = await inspectOrAbsent(docker, expected.kind, expected.name);
  assertExactDockerResource(byName, expected);
  await dockerRef(docker, expected.kind, expected.id).remove(
    expected.kind === 'container' ? { force: true } : undefined,
  );
  if (await inspectOrAbsent(docker, expected.kind, expected.id)) {
    throw new Error(`${expected.kind} ${expected.id} still exists after cleanup`);
  }
  if (await inspectOrAbsent(docker, expected.kind, expected.name)) {
    throw new Error(`${expected.kind} name ${expected.name} was replaced during cleanup`);
  }
}

export async function cleanupTrackedDockerResources(docker, ledger) {
  const failures = [];
  for (const expected of [...ledger].reverse()) {
    try {
      await removeTrackedDockerResource(docker, expected);
      ledger.splice(ledger.indexOf(expected), 1);
    } catch (error) {
      failures.push(`${expected.kind} ${expected.name}: ${error.message}`);
    }
  }
  return failures;
}

async function createOwnedRunRoot(onCapture) {
  const parent = resolveCanonicalTempParent();
  const root = await realpath(await mkdtemp(join(parent, identity.rootPrefix)));
  const owner = {
    root,
    parent,
    marker: join(root, '.verifier-owner'),
    payload: JSON.stringify(exactResourceLabels(identity, 'data-root')),
  };
  onCapture(owner);
  const stat = await lstat(root);
  assert.equal(dirname(root), parent);
  assert.ok(basename(root).startsWith(identity.rootPrefix));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  await writeFile(owner.marker, owner.payload, { flag: 'wx', mode: 0o600 });
  const dataRoot = join(root, 'instances');
  await mkdir(dataRoot, { mode: 0o777 });
  await chmod(root, 0o777);
  return { ...owner, dataRoot };
}

async function cleanupOwnedRunRoot(owner) {
  if (!owner) return;
  const stat = await lstat(owner.root).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return;
  const actual = await realpath(owner.root);
  assert.equal(actual, owner.root);
  assert.equal(dirname(actual), owner.parent);
  assert.ok(basename(actual).startsWith(identity.rootPrefix));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const markerStat = await lstat(owner.marker);
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink());
  assert.equal(await readFile(owner.marker, 'utf8'), owner.payload);

  // Rename first, then verify ownership again. A same-name replacement created
  // after the rename remains at the original path and is never recursively removed.
  const quarantine = `${owner.root}.cleanup-${identity.invocation}`;
  assert.equal(await lstat(quarantine).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }), undefined);
  await rename(owner.root, quarantine);
  const movedMarker = join(quarantine, '.verifier-owner');
  assert.equal(await readFile(movedMarker, 'utf8'), owner.payload);
  await rm(quarantine, { recursive: true, force: false });
  const replacement = await lstat(owner.root).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (replacement) {
    throw new Error(`verifier data root was replaced during cleanup: ${owner.root}`);
  }
}

/** 在容器内执行 node 脚本并取回输出 */
async function execIn(containerId, script) {
  const ex = await raw.getContainer(containerId).exec({
    Cmd: ['node', '-e', script], AttachStdout: true, AttachStderr: true,
  });
  const stream = await ex.start({ hijack: true });
  let out = '';
  await new Promise((resolveStream) => {
    stream.on('data', (d) => { out += d.toString('utf8'); });
    stream.on('end', resolveStream);
    setTimeout(resolveStream, 12000);
  });
  return out.replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

async function createAndStart(client, dataRoot, ledger, id, slot) {
  await client.assertBootstrapResourcesAbsent(id);
  const networkName = client.instanceNetwork(id);
  await requireDockerNameAbsent(raw, 'network', networkName);
  const networkLabels = {
    [MANAGED_LABEL]: 'true',
    [INSTANCE_LABEL]: id,
    ...exactResourceLabels(identity, `${slot}-network`, id),
  };
  const createdNetwork = await raw.createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Internal: true,
    Labels: networkLabels,
  });
  const network = await captureCreatedDockerResource(raw, ledger, {
    kind: 'network', name: networkName, labels: networkLabels, created: createdNetwork,
  });

  const adminRoot = adminRootFor('', id);
  const options = buildCreateOptions(
    { id, imageTag: IMAGE_TAG, memoryMb: 256, cpus: 0.5, ports: [], adminRoot },
    {
      network: network.id,
      imageRepo: 'nodered/node-red',
      instanceDataRoot: dataRoot,
      timezone: 'Asia/Shanghai',
    },
  );
  const containerLabels = {
    ...options.Labels,
    ...exactResourceLabels(identity, `${slot}-container`, id),
  };
  options.Labels = containerLabels;
  assertSafeCreateOptions(options, { instanceDataRoot: dataRoot });
  await mkdir(join(dataRoot, id), { mode: 0o777 });
  const createdContainer = await raw.createContainer(options);
  const container = await captureCreatedDockerResource(raw, ledger, {
    kind: 'container',
    name: containerName(id),
    labels: containerLabels,
    created: createdContainer,
  });
  const settings = renderSettings({
    instanceId: id,
    adminRoot,
    credentialSecret: identity.invocation,
    credentials: [{
      username: 'admin',
      passwordHash: bcrypt.hashSync(identity.invocation, 8),
      permissions: '*',
    }],
  });
  await raw.getContainer(container.id).putArchive(
    tarFile('settings.js', settings, { uid: 1000, gid: 1000, mode: 0o644 }),
    { path: '/data' },
  );
  await raw.getContainer(container.id).start();
  return container;
}

async function runVerification(dataRoot, ledger) {
  const client = new DockerClient({
    network: NET,
    imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 },
    instanceDataRoot: dataRoot,
    timezone: 'Asia/Shanghai',
  });
  const resources = new Map();
  resources.set(A, await createAndStart(client, dataRoot, ledger, A, 'a'));
  resources.set(B, await createAndStart(client, dataRoot, ledger, B, 'b'));

  for (const id of [A, B]) {
    let ready = false;
    for (let i = 0; i < 45 && !ready; i++) {
      await sleep(1000);
      ready = (await client.logs(id, 40)).includes('Server now running at');
    }
    check(`实例 ${id} 就绪`, ready);
    if (!ready) throw new Error(`${id} 未就绪`);
  }

  const probe = `
    const t = setTimeout(() => { console.log('RESULT:TIMEOUT'); process.exit(0); }, 6000);
    fetch('http://${containerName(B)}:1880/red/${B}/')
      .then(r => { clearTimeout(t); console.log('RESULT:REACHABLE:' + r.status); })
      .catch(e => { clearTimeout(t); console.log('RESULT:BLOCKED:' + (e.cause?.code || e.message)); });
  `;
  const out = await execIn(resources.get(A).id, probe);
  check('实例 A 无法访问实例 B 的 1880', !out.includes('RESULT:REACHABLE'),
    (out.match(/RESULT:[A-Z]+(:[^\s]*)?/) ?? ['(无输出)'])[0]);

  const outRev = await execIn(
    resources.get(B).id,
    probe.replace(containerName(B), containerName(A)).replace(`/red/${B}/`, `/red/${A}/`),
  );
  check('实例 B 无法访问实例 A 的 1880', !outRev.includes('RESULT:REACHABLE'),
    (outRev.match(/RESULT:[A-Z]+(:[^\s]*)?/) ?? ['(无输出)'])[0]);

  const infoA = await raw.getContainer(resources.get(A).id).inspect();
  const infoB = await raw.getContainer(resources.get(B).id).inspect();
  const netsA = Object.keys(infoA.NetworkSettings.Networks);
  const netsB = Object.keys(infoB.NetworkSettings.Networks);
  const shared = netsA.filter((name) => netsB.includes(name));
  check('两实例不共处任何网络', shared.length === 0,
    `A=[${netsA.join(',')}] B=[${netsB.join(',')}]`);
  check('资源带本次不可混淆的 invocation 标签',
    infoA.Config.Labels[VERIFIER_INVOCATION_LABEL] === identity.invocation
      && infoB.Config.Labels[VERIFIER_INVOCATION_LABEL] === identity.invocation);
}

async function main() {
  console.log('\n──── 实例间网络隔离 · 真实容器验证 ────\n');
  const ledger = [];
  let owner;
  let primaryError;
  try {
    owner = await createOwnedRunRoot((captured) => { owner = captured; });
    await runVerification(owner.dataRoot, ledger);
  } catch (error) {
    primaryError = error;
  }

  const cleanupFailures = await cleanupTrackedDockerResources(raw, ledger);
  if (cleanupFailures.length === 0) {
    try {
      await cleanupOwnedRunRoot(owner);
    } catch (error) {
      cleanupFailures.push(`data root: ${error.message}`);
    }
  } else if (owner) {
    cleanupFailures.push(`data root preserved because Docker cleanup failed: ${owner.root}`);
  }
  if (primaryError || cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupFailures.map((message) => new Error(message))].filter(Boolean),
      primaryError?.message ?? 'verifier cleanup failed',
    );
  }

  const pass = results.filter((result) => result.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  return pass === results.length ? 0 : 1;
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error('\n验证失败：', error.message);
      process.exitCode = 1;
    });
}
