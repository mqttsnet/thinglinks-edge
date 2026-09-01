import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
const quarantineFor = (root: string, id: string, txId: string) =>
  join(root, `.thinglinks-bootstrap-quarantine-${id}-${txId}`);

function rawOf(docker: DockerClient): Record<string, any> {
  return docker.raw as unknown as Record<string, any>;
}

function installAbsentResourceApi(docker: DockerClient): void {
  const raw = rawOf(docker);
  raw.listContainers = async () => [];
  raw.listNetworks = async () => [];
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

test('bootstrap Manager attach uses captured network ID and never a same-name replacement', async () => {
  const f = fixture({ managerContainer: 'manager-ref' });
  const raw = rawOf(f.docker);
  let capturedConnects = 0;
  let foreignConnects = 0;
  const ownedNetwork = {
    Id: 'owned-network-id', Labels: ownedLabels('line-a', 'bootstrap-tx-a'), Containers: {},
  };
  const foreignNetwork = {
    Id: 'foreign-network-id', Labels: ownedLabels('line-a', 'foreign-tx'), Containers: {},
  };
  raw.getImage = () => ({ inspect: async () => ({}) });
  raw.createNetwork = async () => ({ id: 'owned-network-id' });
  raw.createContainer = async () => ({ putArchive: async () => undefined });
  raw.getContainer = (ref: string) => ({
    inspect: async () => ref === 'manager-ref' ? { Id: 'manager-immutable-id' } : { Id: ref },
  });
  raw.getNetwork = (ref: string) => {
    if (ref === 'owned-network-id') {
      return {
        inspect: async () => ownedNetwork,
        connect: async () => { capturedConnects += 1; },
      };
    }
    return {
      inspect: async () => foreignNetwork,
      connect: async () => { foreignConnects += 1; },
    };
  };
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  await f.docker.createBootstrapInstance({
    id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
    ports: [], adminRoot: '/red/line-a/',
  }, 'module.exports = {};', 'bootstrap-tx-a');
  assert.equal(capturedConnects, 1);
  assert.equal(foreignConnects, 0);
});

test('bootstrap Manager attach rejects captured network ID with mismatched tx label', async () => {
  const f = fixture({ managerContainer: 'manager-ref' });
  const raw = rawOf(f.docker);
  let connects = 0;
  const mismatched = {
    Id: 'owned-network-id', Labels: ownedLabels('line-a', 'foreign-tx'), Containers: {},
  };
  raw.getImage = () => ({ inspect: async () => ({}) });
  raw.createNetwork = async () => ({ id: 'owned-network-id' });
  raw.createContainer = async () => ({ putArchive: async () => undefined });
  raw.getContainer = () => ({ inspect: async () => ({ Id: 'manager-immutable-id' }) });
  raw.getNetwork = () => ({
    inspect: async () => mismatched,
    connect: async () => { connects += 1; },
  });
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  await assert.rejects(() => f.docker.createBootstrapInstance({
    id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
    ports: [], adminRoot: '/red/line-a/',
  }, 'module.exports = {};', 'bootstrap-tx-a'), /bootstrap.*network.*owner|owner.*network/i);
  assert.equal(connects, 0);
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
  raw.listContainers = async () => (
    state.containerRemoved || container.Config.Labels[BOOTSTRAP_TX_LABEL] !== txId
      ? []
      : [{ Id: container.Id, Labels: container.Config.Labels }]
  );
  raw.listNetworks = async () => (
    state.networkRemoved || network.Labels[BOOTSTRAP_TX_LABEL] !== txId
      ? []
      : [{ Id: network.Id, Labels: network.Labels }]
  );
  raw.getContainer = (ref: string) => ({
    inspect: async () => {
      if (ref === 'container-id') {
        if (state.containerRemoved) throw missing();
        return container;
      }
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
      if (ref === 'network-id') {
        if (state.networkRemoved) throw missing();
        return network;
      }
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
  assert.equal(existsSync(join(dirname(f.legacyDir), 'line-a')), false);
  assert.equal(
    existsSync(quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a')),
    true,
  );
});

test('cleanup preserves every foreign-labeled or marker-mismatched resource', async () => {
  const f = fixture();
  const state = installCleanupApi(f.docker, {
    containerLabels: ownedLabels('line-a', 'foreign-tx'),
    networkLabels: ownedLabels('line-a', 'foreign-tx'),
  });
  await f.docker.prepareBootstrapDataDir('line-a', 'foreign-tx');
  const instanceDir = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container', 'network', 'data'] },
  );
  assert.equal(state.containerRemoveCalls, 0);
  assert.equal(state.networkRemoveCalls, 0);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(readFileSync(join(quarantine, BOOTSTRAP_OWNER_FILE), 'utf8'), 'foreign-tx');
});

test('cleanup treats a missing owner marker as a data residual and preserves the directory', async () => {
  const f = fixture();
  installAbsentResourceApi(f.docker);
  const instanceDir = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');
  mkdirSync(instanceDir);
  writeFileSync(join(instanceDir, 'foreign.txt'), 'foreign-data');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(existsSync(instanceDir), false);
  assert.equal(readFileSync(join(quarantine, 'foreign.txt'), 'utf8'), 'foreign-data');
});

test('data replacement created after quarantine rename is preserved and reported as residual', async () => {
  let original = '';
  const f = fixture({
    removeDir: async (quarantine) => {
      mkdirSync(original);
      writeFileSync(join(original, 'replacement.txt'), 'foreign-replacement');
      rmSync(quarantine, { recursive: true, force: false });
    },
  });
  installAbsentResourceApi(f.docker);
  original = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(readFileSync(join(original, 'replacement.txt'), 'utf8'), 'foreign-replacement');
  assert.equal(existsSync(quarantine), false);
});

test('marker mismatch is quarantined and never auto-restored even when original is absent', async () => {
  const renames: Array<[string, string]> = [];
  const f = fixture({
    renameDir: async (source, destination) => {
      renames.push([source, destination]);
      renameSync(source, destination);
    },
  });
  installAbsentResourceApi(f.docker);
  const original = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');
  await f.docker.prepareBootstrapDataDir('line-a', 'foreign-tx');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.deepEqual(renames, [[original, quarantine]]);
  assert.equal(existsSync(original), false);
  assert.equal(readFileSync(join(quarantine, BOOTSTRAP_OWNER_FILE), 'utf8'), 'foreign-tx');
});

test('mismatched quarantine never overwrites a concurrently created empty original directory', async () => {
  let interleavings = 0;
  const f = fixture({
    afterBootstrapDataOwnershipCheck: async ({ original, ownership }) => {
      assert.equal(ownership, 'foreign');
      interleavings += 1;
      mkdirSync(original);
    },
  });
  installAbsentResourceApi(f.docker);
  const original = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');
  await f.docker.prepareBootstrapDataDir('line-a', 'foreign-tx');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(interleavings, 1);
  assert.deepEqual(readdirSync(original), []);
  assert.equal(readFileSync(join(quarantine, BOOTSTRAP_OWNER_FILE), 'utf8'), 'foreign-tx');
});

test('occupied original preserves both replacement and mismatched quarantine', async () => {
  let renameCalls = 0;
  const f = fixture({
    renameDir: async (source, destination) => {
      renameCalls += 1;
      renameSync(source, destination);
      if (renameCalls === 1) {
        mkdirSync(source);
        writeFileSync(join(source, 'replacement.txt'), 'foreign-replacement');
      }
    },
  });
  installAbsentResourceApi(f.docker);
  const original = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');
  await f.docker.prepareBootstrapDataDir('line-a', 'foreign-tx');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(readFileSync(join(original, 'replacement.txt'), 'utf8'), 'foreign-replacement');
  assert.equal(readFileSync(join(quarantine, BOOTSTRAP_OWNER_FILE), 'utf8'), 'foreign-tx');
});

test('delete failure leaves owned quarantine for a later cleanup retry', async () => {
  let removeCalls = 0;
  const f = fixture({
    removeDir: async (path) => {
      removeCalls += 1;
      if (removeCalls === 1) throw new Error('delete failed');
      rmSync(path, { recursive: true, force: false });
    },
  });
  installAbsentResourceApi(f.docker);
  const original = join(dirname(f.legacyDir), 'line-a');
  const quarantine = quarantineFor(dirname(f.legacyDir), 'line-a', 'bootstrap-tx-a');
  await f.docker.prepareBootstrapDataDir('line-a', 'bootstrap-tx-a');

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['data'] },
  );
  assert.equal(existsSync(original), false);
  assert.equal(existsSync(quarantine), true);

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: [] },
  );
  assert.equal(existsSync(quarantine), false);
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

test('cleanup deletes exact-label task resources by immutable ID while preserving same-name foreign replacements', async () => {
  const f = fixture();
  const raw = rawOf(f.docker);
  const ownedContainer = {
    Id: 'owned-container-id', Config: { Labels: ownedLabels('line-a', 'bootstrap-tx-a') },
  };
  const foreignContainer = {
    Id: 'foreign-container-id', Config: { Labels: ownedLabels('line-a', 'foreign-tx') },
  };
  const ownedNetwork = {
    Id: 'owned-network-id', Labels: ownedLabels('line-a', 'bootstrap-tx-a'), Containers: {},
  };
  const foreignNetwork = {
    Id: 'foreign-network-id', Labels: ownedLabels('line-a', 'foreign-tx'), Containers: {},
  };
  let ownedContainerDeletes = 0;
  let foreignContainerDeletes = 0;
  let ownedNetworkDeletes = 0;
  let foreignNetworkDeletes = 0;
  let ownedContainerGone = false;
  let ownedNetworkGone = false;
  raw.listContainers = async () => ownedContainerGone
    ? []
    : [{ Id: 'owned-container-id', Labels: ownedLabels('line-a', 'bootstrap-tx-a') }];
  raw.listNetworks = async () => ownedNetworkGone
    ? []
    : [{ Id: 'owned-network-id', Labels: ownedLabels('line-a', 'bootstrap-tx-a') }];
  raw.getContainer = (ref: string) => ({
    inspect: async () => {
      if (ref === 'owned-container-id') {
        if (ownedContainerGone) throw missing();
        return ownedContainer;
      }
      return foreignContainer;
    },
    remove: async () => {
      if (ref === 'owned-container-id') {
        ownedContainerDeletes += 1;
        ownedContainerGone = true;
      }
      else foreignContainerDeletes += 1;
    },
  });
  raw.getNetwork = (ref: string) => ({
    inspect: async () => {
      if (ref === 'owned-network-id') {
        if (ownedNetworkGone) throw missing();
        return ownedNetwork;
      }
      return foreignNetwork;
    },
    remove: async () => {
      if (ref === 'owned-network-id') {
        ownedNetworkDeletes += 1;
        ownedNetworkGone = true;
      }
      else foreignNetworkDeletes += 1;
    },
    disconnect: async () => undefined,
  });

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container', 'network'] },
  );
  assert.equal(ownedContainerDeletes, 1);
  assert.equal(ownedNetworkDeletes, 1);
  assert.equal(foreignContainerDeletes, 0);
  assert.equal(foreignNetworkDeletes, 0);
});

test('late exact-label container is detection-only residual and is not deleted in this pass', async () => {
  const f = fixture();
  const raw = rawOf(f.docker);
  let discoveries = 0;
  let lateDeletes = 0;
  raw.listContainers = async () => {
    discoveries += 1;
    return discoveries === 1
      ? []
      : [{ Id: 'late-container-id', Labels: ownedLabels('line-a', 'bootstrap-tx-a') }];
  };
  raw.listNetworks = async () => [];
  raw.getContainer = () => ({
    inspect: async () => { throw missing(); },
    remove: async () => { lateDeletes += 1; },
  });
  raw.getNetwork = () => ({ inspect: async () => { throw missing(); } });

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['container'] },
  );
  assert.equal(discoveries, 2);
  assert.equal(lateDeletes, 0);
});

test('late exact-label network is detection-only residual and is not deleted in this pass', async () => {
  const f = fixture();
  const raw = rawOf(f.docker);
  let discoveries = 0;
  let lateDeletes = 0;
  raw.listContainers = async () => [];
  raw.listNetworks = async () => {
    discoveries += 1;
    return discoveries === 1
      ? []
      : [{ Id: 'late-network-id', Labels: ownedLabels('line-a', 'bootstrap-tx-a') }];
  };
  raw.getContainer = () => ({ inspect: async () => { throw missing(); } });
  raw.getNetwork = () => ({
    inspect: async () => { throw missing(); },
    remove: async () => { lateDeletes += 1; },
  });

  assert.deepEqual(
    await f.docker.cleanupBootstrap('line-a', 'bootstrap-tx-a'),
    { residuals: ['network'] },
  );
  assert.equal(discoveries, 2);
  assert.equal(lateDeletes, 0);
});
