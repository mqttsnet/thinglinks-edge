/**
 * 真容器端到端验证：DockerClient 创建规格的 Node-RED 实例是否真的按预期跑起来。
 *
 * 覆盖：settings.js 是否落进数据目录、httpAdminRoot 前缀是否生效、
 *      1880 是否未映射宿主、标签与目录是否按平台规则命名、删除是否只删自己的数据。
 *
 * 用法： node scripts/verify-instance.mjs [basePath]
 *   例： node scripts/verify-instance.mjs /nodered
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

const BASE_PATH = process.argv[2] ?? '';
const IMAGE_TAG = '5.0.4-24-minimal';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const identity = createFixtureIdentity({ suite: 'inst', roles: ['main'] });
const ID = identity.instances.main;
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
  assertExactDockerResource(
    await inspectOrAbsent(docker, expected.kind, expected.name),
    expected,
  );
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

/** 容器内没有 curl，用镜像自带的 node 发请求。 */
async function execInContainer(containerId, script) {
  const c = raw.getContainer(containerId);
  const ex = await c.exec({
    Cmd: ['node', '-e', script], AttachStdout: true, AttachStderr: true,
  });
  const stream = await ex.start({ hijack: true });
  let out = '';
  await new Promise((resolveStream) => {
    stream.on('data', (d) => { out += d.toString('utf8'); });
    stream.on('end', resolveStream);
    setTimeout(resolveStream, 8000);
  });
  return out.replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

async function createOwnedInstance(client, dataRoot, ledger, adminRoot, settings) {
  await client.assertBootstrapResourcesAbsent(ID);
  const networkName = client.instanceNetwork(ID);
  await requireDockerNameAbsent(raw, 'network', networkName);
  const networkLabels = {
    [MANAGED_LABEL]: 'true',
    [INSTANCE_LABEL]: ID,
    ...exactResourceLabels(identity, 'instance-network', ID),
  };
  const createdNetwork = await raw.createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Labels: networkLabels,
  });
  const network = await captureCreatedDockerResource(raw, ledger, {
    kind: 'network', name: networkName, labels: networkLabels, created: createdNetwork,
  });

  const options = buildCreateOptions(
    { id: ID, imageTag: IMAGE_TAG, memoryMb: 256, cpus: 0.5, ports: [], adminRoot },
    {
      network: network.id,
      imageRepo: 'nodered/node-red',
      instanceDataRoot: dataRoot,
      timezone: 'Asia/Shanghai',
    },
  );
  const containerLabels = {
    ...options.Labels,
    ...exactResourceLabels(identity, 'instance-container', ID),
  };
  options.Labels = containerLabels;
  assertSafeCreateOptions(options, { instanceDataRoot: dataRoot });
  await mkdir(join(dataRoot, ID), { mode: 0o777 });
  const createdContainer = await raw.createContainer(options);
  const container = await captureCreatedDockerResource(raw, ledger, {
    kind: 'container',
    name: containerName(ID),
    labels: containerLabels,
    created: createdContainer,
  });
  await raw.getContainer(container.id).putArchive(
    tarFile('settings.js', settings, { uid: 1000, gid: 1000, mode: 0o644 }),
    { path: '/data' },
  );
  await raw.getContainer(container.id).start();
  return { container, network };
}

async function runVerification(owner, ledger) {
  const client = new DockerClient({
    network: NET,
    imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 },
    instanceDataRoot: owner.dataRoot,
    timezone: 'Asia/Shanghai',
  });
  const adminRoot = adminRootFor(BASE_PATH, ID);
  const settings = renderSettings({
    instanceId: ID,
    adminRoot,
    credentials: [{
      username: 'admin',
      passwordHash: bcrypt.hashSync(identity.invocation, 8),
      permissions: '*',
    }],
    credentialSecret: identity.invocation,
  });
  const { container, network } = await createOwnedInstance(
    client,
    owner.dataRoot,
    ledger,
    adminRoot,
    settings,
  );
  check('创建实例容器与数据目录', Boolean(await lstat(join(owner.dataRoot, ID))),
    join(owner.dataRoot, ID));

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(1000);
    ready = (await client.logs(ID, 100)).includes('Server now running at');
  }
  check('容器启动并进入运行态', ready, ready ? '' : '超时未就绪');

  const logs = await client.logs(ID, 100);
  check('settings.js 已落进数据卷并被加载', logs.includes(adminRoot),
    (logs.split('\n').find((line) => line.includes('Server now running at')) || '').trim());

  const html = await execInContainer(
    container.id,
    `fetch('http://127.0.0.1:1880${adminRoot}').then(r=>r.text()).then(t=>console.log('HTTP_OK:'+t.includes('red-ui-editor')))`,
  );
  check('编辑器在带前缀的路径上响应', html.includes('HTTP_OK:true'), adminRoot);

  const rootProbe = await execInContainer(
    container.id,
    `fetch('http://127.0.0.1:1880/').then(r=>console.log('ROOT_STATUS:'+r.status)).catch(()=>console.log('ROOT_ERR'))`,
  );
  check('根路径不再响应编辑器（前缀确实生效）',
    BASE_PATH === '' ? true : rootProbe.includes('ROOT_STATUS:404'),
    BASE_PATH === '' ? '挂根路径，跳过' : rootProbe.trim());

  const info = await raw.getContainer(container.id).inspect();
  const portBindings = info.HostConfig.PortBindings || {};
  check('1880 未映射到宿主',
    !Object.keys(portBindings).some((key) => key.startsWith('1880/')),
    Object.keys(portBindings).join(',') || '(无)');
  check('平台标签正确', info.Config.Labels[MANAGED_LABEL] === 'true');
  check('verifier invocation 标签正确',
    info.Config.Labels[VERIFIER_INVOCATION_LABEL] === identity.invocation);
  check('归属校验通过', await client.assertManaged(ID).then(() => true).catch(() => false));

  const listed = await client.list();
  check('按标签可列举到该实例', listed.some((item) => item.id === ID),
    `共 ${listed.length} 个受管容器`);

  // This is the product behavior under test, not verifier scavenging. Pin the
  // exact captured IDs immediately before invoking the operation on random names.
  assertExactDockerResource(await raw.getContainer(container.id).inspect(), container);
  assertExactDockerResource(await raw.getNetwork(network.id).inspect(), network);
  await client.remove(ID, { removeData: false });
  check('删除容器时可保留数据目录', Boolean(await lstat(join(owner.dataRoot, ID))));

  await client.remove(ID, { removeData: true });
  const dataAfter = await lstat(join(owner.dataRoot, ID)).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  check('removeData 真的删除宿主数据目录', dataAfter === undefined,
    join(owner.dataRoot, ID));
}

async function main() {
  console.log(`\n──── 实例创建 · 真容器验证（basePath=${BASE_PATH || '(根路径)'}）────\n`);
  const ledger = [];
  let owner;
  let primaryError;
  try {
    owner = await createOwnedRunRoot((captured) => { owner = captured; });
    await runVerification(owner, ledger);
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
