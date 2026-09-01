import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BOOTSTRAP_OWNER_FILE,
  DockerClient,
  MANAGED_LABEL,
  type DockerClientOptions,
} from './docker-client.ts';
import { BOOTSTRAP_TX_LABEL } from './container-spec.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(over: Partial<DockerClientOptions> = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'thinglinks-docker-client-test-'));
  roots.push(temporaryRoot);
  const legacyDir = join(temporaryRoot, 'legacy-nodes');
  const instanceNodesDir = join(temporaryRoot, 'line-a', 'nodes');
  const cpCalls: Array<[string, string]> = [];
  const docker = new DockerClient({
    connection: { socketPath: '/dev/null' },
    network: 'test-edge',
    imageRepo: 'nodered/node-red',
    portRange: { min: 30_000, max: 30_999 },
    instanceDataRoot: temporaryRoot,
    timezone: 'UTC',
    nodePackageDir: legacyDir,
    copyDir: async (from, to) => { cpCalls.push([from, to]); },
    ...over,
  });
  return { docker, cpCalls, legacyDir, instanceNodesDir };
}

const missing = () => Object.assign(new Error('not found'), { statusCode: 404 });
const instanceLabel = 'com.mqttsnet.thinglinks-edge.instance';

function rawOf(docker: DockerClient): Record<string, any> {
  return docker.raw as unknown as Record<string, any>;
}

function installAbsentResourceApi(docker: DockerClient): void {
  const raw = rawOf(docker);
  raw.getContainer = () => ({ inspect: async () => { throw missing(); } });
  raw.getNetwork = () => ({ inspect: async () => { throw missing(); } });
}

function ownedLabels(instanceId: string, txId: string): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [instanceLabel]: instanceId,
    [BOOTSTRAP_TX_LABEL]: txId,
  };
}

test('npm-mode data preparation never copies legacy raw nodes', async () => {
  const f = fixture();
  await f.docker.ensureDataDir('line-a', 'npm');
  assert.equal(f.cpCalls.length, 0);
});

test('legacy-mode data preparation keeps compatibility copy', async () => {
  const f = fixture();
  await f.docker.ensureDataDir('line-a', 'legacy');
  assert.deepEqual(f.cpCalls, [[f.legacyDir, f.instanceNodesDir]]);
});

test('bootstrap data root is exclusively created and fsynced with the exact tx owner marker', async () => {
  const f = fixture();
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');
  const instanceDir = join(dirname(f.legacyDir), 'line-a');
  assert.equal(dirname(f.instanceNodesDir), instanceDir);
  assert.equal(
    readFileSync(join(instanceDir, BOOTSTRAP_OWNER_FILE), 'utf8'),
    'bootstrap-tx-a',
  );
  await assert.rejects(
    () => f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
  );
});

test('check then create race cannot adopt or overwrite a foreign data directory', async () => {
  const f = fixture();
  installAbsentResourceApi(f.docker);
  await f.docker.assertBootstrapResourcesAbsent('line-a');
  const instanceDir = join(dirname(f.legacyDir), 'line-a');
  mkdirSync(instanceDir);
  writeFileSync(join(instanceDir, 'foreign.txt'), 'foreign-data');

  await assert.rejects(
    () => f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
  );
  assert.equal(readFileSync(join(instanceDir, 'foreign.txt'), 'utf8'), 'foreign-data');
  assert.equal(existsSync(join(instanceDir, BOOTSTRAP_OWNER_FILE)), false);
});

test('bootstrap create writes the exact tx owner label to network and container only', async () => {
  const f = fixture();
  const raw = rawOf(f.docker);
  let networkOptions: Record<string, unknown> | undefined;
  let containerOptions: Record<string, unknown> | undefined;
  raw.getImage = () => ({ inspect: async () => ({}) });
  raw.createNetwork = async (options: Record<string, unknown>) => {
    networkOptions = options;
    return { id: 'network-id' };
  };
  raw.createContainer = async (options: Record<string, unknown>) => {
    containerOptions = options;
    return { putArchive: async () => undefined };
  };
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');
  await f.docker.createBootstrapInstance({
    id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
    ports: [], adminRoot: '/red/line-a/',
  }, 'module.exports = {};', 'bootstrap-tx-a');

  assert.equal(
    (networkOptions?.['Labels'] as Record<string, unknown>)[BOOTSTRAP_TX_LABEL],
    'bootstrap-tx-a',
  );
  assert.equal(
    (containerOptions?.['Labels'] as Record<string, unknown>)[BOOTSTRAP_TX_LABEL],
    'bootstrap-tx-a',
  );
});

test('network created after preflight is rejected and preserved as a foreign race winner', async () => {
  const f = fixture();
  installAbsentResourceApi(f.docker);
  await f.docker.assertBootstrapResourcesAbsent('line-a');
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');
  const raw = rawOf(f.docker);
  const foreignNetwork = {
    Id: 'foreign-network', Name: 'test-edge-line-a',
    Labels: ownedLabels('line-a', 'foreign-tx'), Containers: {},
  };
  let networkRemoveCalls = 0;
  raw.getImage = () => ({ inspect: async () => ({}) });
  raw.createNetwork = async () => { throw new Error('network name conflict'); };
  raw.getNetwork = () => ({
    inspect: async () => foreignNetwork,
    remove: async () => { networkRemoveCalls += 1; },
  });

  await assert.rejects(() => f.docker.createBootstrapInstance({
    id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
    ports: [], adminRoot: '/red/line-a/',
  }, 'module.exports = {};', 'bootstrap-tx-a'), /network name conflict/);
  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['network'] },
  );
  assert.equal(networkRemoveCalls, 0);
});

function installCleanupApi(docker: DockerClient, options: {
  instanceId?: string;
  txId?: string;
  containerLabels?: Record<string, string>;
  networkLabels?: Record<string, string>;
  failContainerDelete?: boolean;
  failNetworkDelete?: boolean;
  replaceContainer?: boolean;
  replaceNetwork?: boolean;
}) {
  const id = options.instanceId ?? 'line-a';
  const txId = options.txId ?? 'bootstrap-tx-a';
  const raw = rawOf(docker);
  const state = {
    containerRemoved: false,
    networkRemoved: false,
    containerRemoveCalls: 0,
    networkRemoveCalls: 0,
  };
  const container = {
    Id: 'container-id',
    Config: { Labels: options.containerLabels ?? ownedLabels(id, txId) },
  };
  const network = {
    Id: 'network-id',
    Name: `test-edge-${id}`,
    Labels: options.networkLabels ?? ownedLabels(id, txId),
    Containers: {},
  };
  raw.getContainer = (ref: string) => ({
    inspect: async () => {
      if (ref === 'container-id') return container;
      if (state.containerRemoved) {
        if (options.replaceContainer) {
          return { ...container, Id: 'foreign-container', Config: { Labels: ownedLabels(id, 'foreign-tx') } };
        }
        throw missing();
      }
      return container;
    },
    remove: async () => {
      state.containerRemoveCalls += 1;
      if (options.failContainerDelete) throw new Error('container delete failed');
      state.containerRemoved = true;
    },
  });
  raw.getNetwork = (ref: string) => ({
    inspect: async () => {
      if (ref === 'network-id') return network;
      if (state.networkRemoved) {
        if (options.replaceNetwork) {
          return { ...network, Id: 'foreign-network', Labels: ownedLabels(id, 'foreign-tx') };
        }
        throw missing();
      }
      return network;
    },
    remove: async () => {
      state.networkRemoveCalls += 1;
      if (options.failNetworkDelete) throw new Error('network delete failed');
      state.networkRemoved = true;
    },
    disconnect: async () => undefined,
  });
  return state;
}

test('container created after preflight is preserved while owned network and data are cleaned', async () => {
  const f = fixture();
  installAbsentResourceApi(f.docker);
  await f.docker.assertBootstrapResourcesAbsent('line-a');
  const state = installCleanupApi(f.docker, {
    containerLabels: ownedLabels('line-a', 'foreign-tx'),
  });
  const raw = rawOf(f.docker);
  raw.getImage = () => ({ inspect: async () => ({}) });
  raw.createNetwork = async () => ({ id: 'network-id' });
  raw.createContainer = async () => { throw new Error('container name conflict'); };
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  await assert.rejects(() => f.docker.createBootstrapInstance({
    id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
    ports: [], adminRoot: '/red/line-a/',
  }, 'module.exports = {};', 'bootstrap-tx-a'), /container name conflict/);
  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container'] },
  );
  assert.equal(state.containerRemoveCalls, 0);
  assert.equal(state.networkRemoveCalls, 1);
  assert.equal(existsSync(join(dirname(f.legacyDir), 'line-a')), false);
});

test('cleanup continues network and data branches when owned container deletion fails', async () => {
  const f = fixture();
  const state = installCleanupApi(f.docker, { failContainerDelete: true });
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container'] },
  );
  assert.equal(state.networkRemoved, true);
  assert.equal(existsSync(join(dirname(f.legacyDir), 'line-a')), false);
});

test('cleanup reports network deletion failure while continuing owned data deletion', async () => {
  const f = fixture();
  const state = installCleanupApi(f.docker, { failNetworkDelete: true });
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['network'] },
  );
  assert.equal(state.containerRemoved, true);
  assert.equal(existsSync(join(dirname(f.legacyDir), 'line-a')), false);
});

test('cleanup reports data deletion failure after still cleaning owned container and network', async () => {
  const f = fixture({
    removeDir: async () => { throw new Error('data delete failed'); },
  });
  const state = installCleanupApi(f.docker, {});
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(state.containerRemoved, true);
  assert.equal(state.networkRemoved, true);
  assert.equal(existsSync(join(dirname(f.legacyDir), 'line-a')), true);
});

test('cleanup preserves every foreign-labeled or marker-mismatched resource', async () => {
  const f = fixture();
  const state = installCleanupApi(f.docker, {
    containerLabels: ownedLabels('line-a', 'foreign-tx'),
    networkLabels: ownedLabels('line-a', 'foreign-tx'),
  });
  await f.docker.prepareBootstrapDataDir('line-a', 'foreign-tx');
  const instanceDir = join(dirname(f.legacyDir), 'line-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container', 'network', 'data'] },
  );
  assert.equal(state.containerRemoveCalls, 0);
  assert.equal(state.networkRemoveCalls, 0);
  assert.equal(existsSync(instanceDir), true);
});

test('cleanup treats a missing owner marker as a data residual and preserves the directory', async () => {
  const f = fixture();
  installAbsentResourceApi(f.docker);
  const instanceDir = join(dirname(f.legacyDir), 'line-a');
  mkdirSync(instanceDir);
  writeFileSync(join(instanceDir, 'foreign.txt'), 'foreign-data');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(readFileSync(join(instanceDir, 'foreign.txt'), 'utf8'), 'foreign-data');
});

test('post-delete same-name replacements are residuals and are never deleted twice', async () => {
  const f = fixture();
  const state = installCleanupApi(f.docker, { replaceContainer: true, replaceNetwork: true });
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container', 'network'] },
  );
  assert.equal(state.containerRemoveCalls, 1);
  assert.equal(state.networkRemoveCalls, 1);
});
