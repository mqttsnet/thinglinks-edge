/**
 * 真容器验证：确认参数白名单生成的配置，在真实 Docker 上确实生效。
 *
 * 单元测试只能验证我们生成的 JS 对象；Docker 是否照做必须在真实环境复核。
 * 用法： node scripts/verify-container-guard.mjs
 */
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertSafeCreateOptions,
  buildCreateOptions,
} from '../dist/core/instance/container-spec.js';
import {
  VERIFIER_INVOCATION_LABEL,
  assertExactDockerResource,
  createFixtureIdentity,
  exactResourceLabels,
  resolveCanonicalTempParent,
} from './_real-instance-fixture.mjs';

const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const identity = createFixtureIdentity({ suite: 'guard', roles: ['main'] });
const ID = identity.instances.main;
const NET = identity.networkPrefix;
const docker = new Docker();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const dockerRef = (client, kind, ref) => kind === 'container'
  ? client.getContainer(ref)
  : client.getNetwork(ref);

const inspectOrAbsent = async (client, kind, ref) => {
  try {
    return await dockerRef(client, kind, ref).inspect();
  } catch (error) {
    if (error?.statusCode === 404) return undefined;
    throw error;
  }
};

export async function requireDockerNameAbsent(client, kind, name) {
  if (await inspectOrAbsent(client, kind, name)) {
    throw new Error(`verifier ${kind} name is already occupied: ${name}`);
  }
}

export async function captureCreatedDockerResource(
  client,
  ledger,
  { kind, name, labels, created },
) {
  if (!created?.id || typeof created.id !== 'string') {
    throw new Error(`created ${kind} ${name} did not return an immutable id`);
  }
  const expected = { kind, id: created.id, name, labels };
  ledger.push(expected);
  assertExactDockerResource(await inspectOrAbsent(client, kind, expected.id), expected);
  assertExactDockerResource(await inspectOrAbsent(client, kind, expected.name), expected);
  return expected;
}

async function removeTrackedDockerResource(client, expected) {
  const byId = await inspectOrAbsent(client, expected.kind, expected.id);
  if (!byId) {
    const replacement = await inspectOrAbsent(client, expected.kind, expected.name);
    if (replacement) {
      throw new Error(
        `recorded ${expected.kind} ${expected.id} disappeared but ${expected.name} was replaced`,
      );
    }
    return;
  }
  assertExactDockerResource(byId, expected);
  assertExactDockerResource(
    await inspectOrAbsent(client, expected.kind, expected.name),
    expected,
  );
  await dockerRef(client, expected.kind, expected.id).remove(
    expected.kind === 'container' ? { force: true } : undefined,
  );
  if (await inspectOrAbsent(client, expected.kind, expected.id)) {
    throw new Error(`${expected.kind} ${expected.id} still exists after cleanup`);
  }
  if (await inspectOrAbsent(client, expected.kind, expected.name)) {
    throw new Error(`${expected.kind} name ${expected.name} was replaced during cleanup`);
  }
}

export async function cleanupTrackedDockerResources(client, ledger) {
  const failures = [];
  for (const expected of [...ledger].reverse()) {
    try {
      await removeTrackedDockerResource(client, expected);
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
  const quarantine = `${owner.root}.cleanup-${identity.invocation}`;
  assert.equal(await lstat(quarantine).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }), undefined);
  await rename(owner.root, quarantine);
  assert.equal(await readFile(join(quarantine, '.verifier-owner'), 'utf8'), owner.payload);
  await rm(quarantine, { recursive: true, force: false });
  const replacement = await lstat(owner.root).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (replacement) {
    throw new Error(`verifier data root was replaced during cleanup: ${owner.root}`);
  }
}

async function runVerification(owner, ledger) {
  await requireDockerNameAbsent(docker, 'network', NET);
  const networkLabels = exactResourceLabels(identity, 'guard-network', ID);
  const createdNetwork = await docker.createNetwork({
    Name: NET,
    Driver: 'bridge',
    Internal: true,
    Labels: networkLabels,
  });
  const network = await captureCreatedDockerResource(docker, ledger, {
    kind: 'network', name: NET, labels: networkLabels, created: createdNetwork,
  });

  const hostPort = 30000 + (Number.parseInt(identity.invocation.slice(0, 4), 16) % 1000);
  const spec = {
    id: ID,
    imageTag: '5.0.4-24-minimal',
    memoryMb: 256,
    cpus: 0.5,
    ports: [{
      hostPort, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1',
    }],
    adminRoot: `/red/${ID}/`,
  };
  const options = buildCreateOptions(spec, {
    network: network.id,
    imageRepo: 'nodered/node-red',
    instanceDataRoot: owner.dataRoot,
    timezone: 'Asia/Shanghai',
  });
  const containerLabels = {
    ...options.Labels,
    ...exactResourceLabels(identity, 'guard-container', ID),
  };
  options.Labels = containerLabels;
  assertSafeCreateOptions(options, { instanceDataRoot: owner.dataRoot });
  await requireDockerNameAbsent(docker, 'container', options.name);
  await mkdir(join(owner.dataRoot, ID), { mode: 0o777 });
  const createdContainer = await docker.createContainer(options);
  const tracked = await captureCreatedDockerResource(docker, ledger, {
    kind: 'container', name: options.name, labels: containerLabels, created: createdContainer,
  });
  const info = await docker.getContainer(tracked.id).inspect();
  const host = info.HostConfig;

  check('以非 root 运行', info.Config.User === 'node-red', `User=${info.Config.User}`);
  check('只读根文件系统生效', host.ReadonlyRootfs === true);
  check('内存配额生效', host.Memory === 256 * 1024 * 1024, `${host.Memory / 1024 / 1024} MB`);
  check('CPU 配额生效', host.NanoCpus === 5e8, `${host.NanoCpus / 1e9} 核`);
  check('能力已全部裁剪', Array.isArray(host.CapDrop) && host.CapDrop.includes('ALL'),
    JSON.stringify(host.CapDrop));
  check('no-new-privileges 生效', (host.SecurityOpt || []).includes('no-new-privileges:true'));
  check('非特权容器', host.Privileged === false);
  check('仅挂载本实例数据目录',
    (host.Binds || []).every((bind) => bind === `${owner.dataRoot}/${spec.id}:/data`),
    JSON.stringify(host.Binds));
  check('1880 未映射到宿主',
    !Object.keys(host.PortBindings || {}).some((key) => key.startsWith('1880/')),
    Object.keys(host.PortBindings || {}).join(',') || '(无)');
  check('已加入内部网络', Object.keys(info.NetworkSettings.Networks).includes(NET));
  check('PidsLimit 生效', host.PidsLimit === 512, String(host.PidsLimit));
  check('verifier invocation 标签正确',
    info.Config.Labels[VERIFIER_INVOCATION_LABEL] === identity.invocation);
  check('平台归属标签仍然正确',
    info.Config.Labels[MANAGED_LABEL] === 'true'
      && info.Config.Labels[INSTANCE_LABEL] === ID);
}

async function main() {
  console.log('\n──── 容器参数白名单 · 真实 Docker 验证 ────\n');
  const ledger = [];
  let owner;
  let primaryError;
  try {
    owner = await createOwnedRunRoot((captured) => { owner = captured; });
    await runVerification(owner, ledger);
  } catch (error) {
    primaryError = error;
  }

  const cleanupFailures = await cleanupTrackedDockerResources(docker, ledger);
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
      console.error('验证失败：', error.message);
      process.exitCode = 1;
    });
}
