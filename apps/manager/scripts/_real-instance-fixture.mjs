/**
 * Shared real-container fixture for Manager verifiers.
 *
 * New instances now complete a trusted npm bootstrap before POST /api/instances
 * returns.  A verifier therefore needs the same operation gate, Admin runtime,
 * platform-package trust root, private registry, and migration wiring as the
 * production Manager.  Keeping that wiring here prevents feature verifiers from
 * silently drifting back to an incomplete InstanceService construction.
 */
import Docker from 'dockerode';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const VERIFIER_RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
export const VERIFIER_SUITE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-suite';
export const VERIFIER_INVOCATION_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-invocation';
export const VERIFIER_ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-role';
export const VERIFIER_INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-instance';

const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const BOOTSTRAP_TX_LABEL = 'com.mqttsnet.thinglinks-edge.bootstrap-tx';
const REGISTRY_PORT = 19100;
const SOCAT_IMAGE = 'alpine/socat@sha256:5f275aa1b6e9889c851f61097142ee050fc6ac4615b4ea64ac1f2b0e81ff8d7f';
const SAFE_SEGMENT = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SAFE_SUITE = /^[a-z][a-z0-9-]{1,15}[a-z0-9]$/;
const SAFE_RUN = /^[a-z0-9][a-z0-9_.-]{0,79}$/;

export function resolveCanonicalTempParent(adapters = {}) {
  const pathExists = adapters.existsSync ?? existsSync;
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const candidate = pathExists('/private/tmp') ? '/private/tmp' : '/tmp';
  const canonical = canonicalize(candidate);
  if (canonical !== '/private/tmp' && canonical !== '/tmp') {
    throw new Error(`canonical temp parent escapes allowed boundary: ${canonical}`);
  }
  return canonical;
}

/** Create names that cannot collide with an existing production instance. */
export function createFixtureIdentity({
  suite,
  roles,
  outerRunId = process.env.TLE_VERIFY_RUN_ID?.trim() || '',
  randomToken = randomBytes(6).toString('hex'),
} = {}) {
  if (!SAFE_SUITE.test(suite ?? '')) throw new Error(`invalid verifier suite: ${suite}`);
  if (!Array.isArray(roles) || roles.length === 0 || new Set(roles).size !== roles.length) {
    throw new Error('verifier roles must be a non-empty unique array');
  }
  if (!/^[a-f0-9]{12}$/.test(randomToken)) throw new Error('invalid verifier random token');
  const runId = outerRunId || `local-${randomToken}`;
  if (!SAFE_RUN.test(runId)) throw new Error(`invalid verifier run id: ${runId}`);

  const instances = {};
  for (const role of roles) {
    if (!/^[a-z][a-z0-9-]{0,7}$/.test(role)) throw new Error(`invalid verifier role: ${role}`);
    const id = `${suite}-${role}-${randomToken}`;
    if (!SAFE_SEGMENT.test(id)) throw new Error(`generated instance id is invalid: ${id}`);
    instances[role] = id;
  }
  return Object.freeze({
    suite,
    invocation: randomToken,
    runId,
    instances: Object.freeze(instances),
    networkPrefix: `tle-${suite}-net-${randomToken}`,
    registryAlias: `tle-${suite}-registry-${randomToken}`,
    rootPrefix: `tle-${suite}-${randomToken}-`,
  });
}

export function exactResourceLabels(identity, role, instanceId = '') {
  return {
    [VERIFIER_RUN_LABEL]: identity.runId,
    [VERIFIER_SUITE_LABEL]: identity.suite,
    [VERIFIER_INVOCATION_LABEL]: identity.invocation,
    [VERIFIER_ROLE_LABEL]: role,
    ...(instanceId ? { [VERIFIER_INSTANCE_LABEL]: instanceId } : {}),
  };
}

const hasAllLabels = (actual, expected) => Object.entries(expected)
  .every(([key, value]) => actual?.[key] === value);

/**
 * Verify both mutable discovery facts and the immutable Docker ID before a
 * destructive cleanup call.  Callers remove by `expected.id`, never by name.
 */
export function assertExactDockerResource(info, expected) {
  const actualName = expected.kind === 'container'
    ? String(info?.Name ?? '').replace(/^\//, '')
    : info?.Name;
  if (
    !info
    || info.Id !== expected.id
    || actualName !== expected.name
    || !hasAllLabels(
      expected.kind === 'container' ? info.Config?.Labels : info.Labels,
      expected.labels,
    )
  ) {
    throw new Error(`refusing cleanup for mismatched ${expected.kind} ${expected.name}`);
  }
  return info;
}

export function requireSuccessfulInstanceCreate(id, status, bodyText) {
  if (status === 201) {
    try { return JSON.parse(bodyText); } catch { return {}; }
  }
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    detail = typeof parsed?.error === 'string' ? parsed.error : bodyText;
  } catch {
    // Keep the bounded raw response when it is not JSON.
  }
  throw new Error(`创建实例 ${id} 失败：HTTP ${status} ${String(detail).slice(0, 400)}`);
}

export function bootstrapBridgeCleanupDecision(capturedTxId, requestedTxId) {
  if (capturedTxId === undefined) return 'delegate';
  if (capturedTxId !== requestedTxId) {
    throw new Error('refusing bridge compensation for mismatched transaction');
  }
  return 'remove';
}

export async function createTrackedImageAlias(adapters, input) {
  if (await adapters.inspectImage(input.alias)) {
    throw new Error(`verifier image alias already exists: ${input.alias}`);
  }
  const source = await adapters.inspectImage(input.sourceRef);
  if (!source?.Id) throw new Error(`verifier source image is unavailable: ${input.sourceRef}`);
  await adapters.tagImage(source.Id, input.alias);
  // The tag side effect already happened. Record it before any fallible verification
  // so final cleanup can still resolve and remove this exact alias.
  adapters.ledger.set(input.alias, source.Id);
  const tagged = await adapters.inspectImage(input.alias);
  if (!tagged || tagged.Id !== source.Id) {
    throw new Error(`verifier image alias identity mismatch: ${input.alias}`);
  }
  return input.alias;
}

export async function assertPreparedRemovalAbsent(adapters, removal) {
  const resources = await Promise.all([
    adapters.inspectContainer(removal.containerId),
    adapters.inspectContainer(`tle-nr-${removal.instanceId}`),
    adapters.inspectNetwork(removal.networkId),
    adapters.inspectNetwork(removal.networkName),
  ]);
  if (resources.some(Boolean)) {
    throw new Error(`prepared instance removal still exists: ${removal.instanceId}`);
  }
  return true;
}

/**
 * Fixture-only legacy provisioning path. It composes the real repository,
 * settings renderer, Docker client and Admin runtime while deliberately avoiding
 * the new-instance npm bootstrap. This models an instance that existed before
 * npm-mode creation became mandatory; it must never be used by the create API.
 */
export async function provisionLegacyInstance(adapters, input) {
  const ports = input.ports.map((port) => ({ ...port }));
  adapters.repo.create({
    id: input.id,
    name: input.name,
    imageTag: input.imageTag,
    memLimit: input.memoryMb,
    cpuLimit: input.cpus,
    adminRoot: input.adminRoot,
    credSecret: input.credentialSecret,
    notes: '',
    nodeRuntimeMode: 'legacy',
  }, ports, [{
    username: input.username,
    password: input.password,
    permissions: '*',
  }]);
  adapters.repo.setIngestToken(input.id, input.ingestToken);

  const settings = adapters.renderSettings({
    instanceId: input.id,
    adminRoot: input.adminRoot,
    credentialSecret: input.credentialSecret,
    credentials: [{
      username: input.username,
      passwordHash: input.passwordHash,
      permissions: '*',
    }],
    palette: input.palette,
    nodeRuntimeMode: 'legacy',
  });
  await adapters.docker.createInstance({
    id: input.id,
    imageTag: input.imageTag,
    memoryMb: input.memoryMb,
    cpus: input.cpus,
    ports,
    adminRoot: input.adminRoot,
    ingestToken: input.ingestToken,
  }, settings, 'legacy');
  await adapters.afterContainerCreate(input.id);
  await adapters.docker.start(input.id);
  await adapters.adminRuntime.waitReady(input.id, { timeoutMs: 30_000, intervalMs: 250 });
  return { password: input.password, ingestToken: input.ingestToken, ports };
}

const allocatePort = () => new Promise((resolvePort, reject) => {
  const listener = createTcpServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    if (!address || typeof address === 'string') {
      listener.close();
      reject(new Error('unable to allocate verifier port'));
      return;
    }
    listener.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const canBindMappedPort = (port) => new Promise((resolveBind, reject) => {
  const listener = createTcpServer();
  listener.once('error', (error) => {
    if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') {
      resolveBind(false);
      return;
    }
    reject(error);
  });
  listener.listen(port, '127.0.0.1', () => {
    listener.close((error) => error ? reject(error) : resolveBind(true));
  });
});

export async function allocateMappedPortInRange(reserved, adapters = {}) {
  if (!(reserved instanceof Set)) throw new TypeError('reserved ports must be a Set');
  const nextCandidate = adapters.nextCandidate ?? (() => randomInt(30000, 61000));
  const canBind = adapters.canBind ?? canBindMappedPort;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const port = nextCandidate();
    if (!Number.isInteger(port) || port < 30000 || port > 60999 || reserved.has(port)) continue;
    if (!await canBind(port)) continue;
    reserved.add(port);
    return port;
  }
  throw new Error('unable to allocate a verifier port inside the Manager range');
}

const streamBuffer = (stream, maxBytes = 64 * 1024 * 1024) =>
  new Promise((resolveBuffer, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy(new Error('Manager seed archive exceeds 64 MiB'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on('end', () => resolveBuffer(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

const isDockerNotFound = (error) => error?.statusCode === 404;
const isFsNotFound = (error) => error?.code === 'ENOENT';

/**
 * Assemble and start one isolated host-mode Manager fixture.  The returned
 * cleanup is idempotent and never enumerates or removes unrelated managed
 * resources.
 */
export async function createRealInstanceFixture(options) {
  const identity = options?.identity;
  if (!identity?.suite || !identity?.instances) throw new Error('fixture identity is required');
  if (!Array.isArray(options.allowedImageTags) || options.allowedImageTags.length === 0) {
    throw new Error('allowedImageTags is required');
  }

  const raw = options.rawDocker ?? new Docker();
  const managerImageRef = options.managerImage?.trim() || process.env.MANAGER_IMAGE?.trim() || '';
  const canonicalParent = resolveCanonicalTempParent(options.tempAdapters);
  const expectedContainers = new Map();
  const expectedInstanceContainers = new Map();
  const expectedNetworks = new Map();
  const imageAliases = new Map();
  const instanceTx = new Map();
  const bootstrapDiagnostics = new Map();
  const preparedRemovals = new Map();
  const inboundPorts = new Map();
  const reservedPorts = new Set();
  let runRoot;
  let fixtureInstanceDataRoot;
  let db;
  let server;
  let cleanupResult;

  const inspectContainer = async (ref) => raw.getContainer(ref).inspect().catch((error) => {
    if (isDockerNotFound(error)) return undefined;
    throw error;
  });
  const inspectNetwork = async (ref) => raw.getNetwork(ref).inspect().catch((error) => {
    if (isDockerNotFound(error)) return undefined;
    throw error;
  });
  const labelFilters = (labels) => Object.entries(labels).map(([key, value]) => `${key}=${value}`);

  const assertRunRoot = async () => {
    if (!runRoot) throw new Error('verifier run root was not created');
    const actual = await realpath(runRoot);
    const stat = await lstat(runRoot);
    const rel = relative(canonicalParent, actual);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || dirname(actual) !== canonicalParent
      || rel.startsWith('..')
      || resolve(canonicalParent, rel) !== actual
      || !basename(actual).startsWith(identity.rootPrefix)
    ) throw new Error(`verifier run root escapes boundary: ${actual}`);
    return actual;
  };

  const createVerifyContainer = async (createOptions, role, instanceId = '', start = false) => {
    const labels = {
      ...exactResourceLabels(identity, role, instanceId),
      ...(instanceId && instanceTx.get(instanceId)
        ? { [BOOTSTRAP_TX_LABEL]: instanceTx.get(instanceId) }
        : {}),
    };
    const name = createOptions.name;
    if (typeof name !== 'string' || expectedContainers.has(name)) {
      throw new Error(`invalid or duplicate verifier container name: ${name}`);
    }
    const created = await raw.createContainer({ ...createOptions, Labels: labels });
    const expected = { kind: 'container', id: created.id, name, labels };
    const info = assertExactDockerResource(await inspectContainer(created.id), expected);
    expectedContainers.set(name, expected);
    if (start) await raw.getContainer(info.Id).start();
    return info;
  };

  const exactInstanceLabels = (id) => ({ [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: id });
  const networkName = (id) => `${identity.networkPrefix}-${id}`;

  const captureInstanceResources = async (id) => {
    const container = await inspectContainer(`tle-nr-${id}`);
    if (!container || !hasAllLabels(container.Config?.Labels, exactInstanceLabels(id))) {
      throw new Error(`bootstrap instance container ownership mismatch: ${id}`);
    }
    const txId = container.Config?.Labels?.[BOOTSTRAP_TX_LABEL];
    if (!txId || (instanceTx.get(id) && instanceTx.get(id) !== txId)) {
      throw new Error(`bootstrap transaction ownership mismatch: ${id}`);
    }
    instanceTx.set(id, txId);
    expectedInstanceContainers.set(id, {
      kind: 'container',
      id: container.Id,
      name: `tle-nr-${id}`,
      labels: { ...exactInstanceLabels(id), [BOOTSTRAP_TX_LABEL]: txId },
    });

    const network = await inspectNetwork(networkName(id));
    if (!network || !hasAllLabels(network.Labels, {
      ...exactInstanceLabels(id), [BOOTSTRAP_TX_LABEL]: txId,
    })) throw new Error(`bootstrap instance network ownership mismatch: ${id}`);
    expectedNetworks.set(id, {
      kind: 'network', id: network.Id, name: networkName(id),
      labels: { ...exactInstanceLabels(id), [BOOTSTRAP_TX_LABEL]: txId },
    });
    return { container, network, txId };
  };

  const captureLegacyResiduals = async (id) => {
    const labels = exactInstanceLabels(id);
    const container = await inspectContainer(`tle-nr-${id}`);
    if (container) {
      if (
        !hasAllLabels(container.Config?.Labels, labels)
        || container.Config?.Labels?.[BOOTSTRAP_TX_LABEL] !== undefined
      ) throw new Error(`legacy instance container ownership mismatch: ${id}`);
      expectedInstanceContainers.set(id, {
        kind: 'container', id: container.Id, name: `tle-nr-${id}`, labels,
      });
    }

    const network = await inspectNetwork(networkName(id));
    if (network) {
      if (
        !hasAllLabels(network.Labels, labels)
        || network.Labels?.[BOOTSTRAP_TX_LABEL] !== undefined
      ) throw new Error(`legacy instance network ownership mismatch: ${id}`);
      expectedNetworks.set(id, {
        kind: 'network', id: network.Id, name: networkName(id), labels,
      });
    }
    return { container, network };
  };

  const captureLegacyResources = async (id) => {
    const resources = await captureLegacyResiduals(id);
    if (!resources.container || !resources.network) {
      throw new Error(`legacy instance resources are incomplete: ${id}`);
    }
    return resources;
  };

  const bridgeNames = (id) => ({
    inbound: `tle-${identity.suite}-in-${id}`,
    outbound: identity.registryAlias,
  });

  const createInboundBridge = async (id, network) => {
    if (!fixtureInstanceDataRoot) throw new Error('fixture instance data root is not ready');
    await chmod(`${fixtureInstanceDataRoot}/${id}`, 0o777);
    const names = bridgeNames(id);
    const inboundPort = inboundPorts.get(id);
    if (!inboundPort) throw new Error(`missing inbound bridge port for ${id}`);
    return createVerifyContainer({
      name: names.inbound,
      Image: SOCAT_IMAGE,
      Cmd: ['TCP-LISTEN:1880,fork,reuseaddr', `TCP:tle-nr-${id}:1880`],
      ExposedPorts: { '1880/tcp': {} },
      HostConfig: {
        NetworkMode: network.Id,
        PortBindings: { '1880/tcp': [{ HostIp: '127.0.0.1', HostPort: String(inboundPort) }] },
      },
    }, 'bridge-in', id, true);
  };

  const execVerifierCommand = async (containerId, command) => {
    const exec = await raw.getContainer(containerId).exec({
      Cmd: command, AttachStdout: true, AttachStderr: true, Tty: true,
    });
    const stream = await exec.start({ hijack: true });
    await new Promise((resolveStream, reject) => {
      stream.on('end', resolveStream);
      stream.on('error', reject);
      stream.resume();
    });
    const result = await exec.inspect();
    if (result.ExitCode !== 0) throw new Error(`verifier bridge probe failed with exit ${result.ExitCode}`);
  };

  const createBootstrapBridges = async (id) => {
    const { network } = await captureInstanceResources(id);
    const names = bridgeNames(id);
    // Host-mode verifier uid differs from the official Node-RED uid 1000 on CI.
    // createInboundBridge only widens this fresh random fixture directory.
    const inbound = await createInboundBridge(id, network);

    let existingOutbound = expectedContainers.get(names.outbound);
    let startOutbound = false;
    if (!existingOutbound) {
      const expectedNetwork = expectedNetworks.get(id);
      if (!expectedNetwork) throw new Error(`bootstrap network was not captured for ${id}`);
      assertExactDockerResource(network, expectedNetwork);
      const created = await createVerifyContainer({
        name: names.outbound,
        Image: SOCAT_IMAGE,
        Cmd: [`TCP-LISTEN:${REGISTRY_PORT},fork,reuseaddr`, `TCP:host.docker.internal:${managerPort}`],
        HostConfig: {
          NetworkMode: expectedNetwork.id,
          ExtraHosts: ['host.docker.internal:host-gateway'],
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [expectedNetwork.name]: { Aliases: [identity.registryAlias] },
          },
        },
      }, 'bridge-out');
      existingOutbound = expectedContainers.get(names.outbound);
      if (!existingOutbound || existingOutbound.id !== created.Id) {
        throw new Error('registry bridge immutable identity was not captured');
      }
      startOutbound = true;
    } else {
      assertExactDockerResource(await inspectContainer(existingOutbound.id), existingOutbound);
      const expectedNetwork = expectedNetworks.get(id);
      if (!expectedNetwork) throw new Error(`bootstrap network was not captured for ${id}`);
      assertExactDockerResource(network, expectedNetwork);
      await raw.getNetwork(expectedNetwork.id).connect({
        Container: existingOutbound.id,
        EndpointConfig: { Aliases: [identity.registryAlias] },
      });
    }
    if (startOutbound) await raw.getContainer(existingOutbound.id).start();
    const expectedNetwork = expectedNetworks.get(id);
    if (!expectedNetwork) throw new Error(`bootstrap network was not captured for ${id}`);
    const connected = assertExactDockerResource(
      await inspectNetwork(expectedNetwork.id), expectedNetwork,
    );
    if (!Object.hasOwn(connected.Containers ?? {}, existingOutbound.id)) {
      throw new Error(`registry bridge was not connected to ${id}`);
    }

    // Probe from another container on the same private network. This verifies the
    // registry container name, Docker DNS, host-gateway hop, and Manager listener
    // before Node-RED starts and npm bootstrap depends on all four.
    await execVerifierCommand(inbound.Id, [
      'wget', '-q', '-O', '/dev/null', `http://${identity.registryAlias}:${REGISTRY_PORT}/healthz`,
    ]);
    bootstrapDiagnostics.set(id, 'registry-bridge-ok');
  };

  /**
   * Test sidecars must not make production bootstrap compensation report a
   * network residual. Remove/detach only the exact sidecars captured for this
   * transaction, then delegate to the untouched DockerClient implementation.
   */
  const removeInstanceBridges = async (id) => {
    const names = bridgeNames(id);
    const inbound = expectedContainers.get(names.inbound);
    if (inbound) {
      assertExactDockerResource(await inspectContainer(inbound.id), inbound);
      await raw.getContainer(inbound.id).remove({ force: true });
      expectedContainers.delete(names.inbound);
    }

    const outbound = expectedContainers.get(names.outbound);
    const expectedNetwork = expectedNetworks.get(id);
    if (outbound && expectedNetwork) {
      assertExactDockerResource(await inspectContainer(outbound.id), outbound);
      const network = assertExactDockerResource(
        await inspectNetwork(expectedNetwork.id), expectedNetwork,
      );
      if (Object.hasOwn(network.Containers ?? {}, outbound.id)) {
        await raw.getNetwork(expectedNetwork.id).disconnect({
          Container: outbound.id,
          Force: true,
        });
      }
      const after = assertExactDockerResource(
        await inspectNetwork(expectedNetwork.id), expectedNetwork,
      );
      if (Object.hasOwn(after.Containers ?? {}, outbound.id)) {
        throw new Error(`registry bridge remains connected to ${id}`);
      }
      const outboundInfo = assertExactDockerResource(
        await inspectContainer(outbound.id), outbound,
      );
      if (Object.keys(outboundInfo.NetworkSettings?.Networks ?? {}).length === 0) {
        await raw.getContainer(outbound.id).remove({ force: true });
        expectedContainers.delete(names.outbound);
      }
    }
  };

  const removeBootstrapBridges = async (id, txId) => {
    bootstrapBridgeCleanupDecision(instanceTx.get(id), txId);
    await removeInstanceBridges(id);
  };

  const resolveManagerImage = async () => {
    if (!managerImageRef) {
      throw new Error('real-instance verifier requires explicit MANAGER_IMAGE');
    }
    const info = await raw.getImage(managerImageRef).inspect().catch((error) => {
      throw new Error(`MANAGER_IMAGE is unavailable: ${error.message}`);
    });
    if (!/^sha256:[a-f0-9]{64}$/.test(info.Id)) {
      throw new Error('MANAGER_IMAGE did not resolve to an immutable sha256 image ID');
    }
    return info.Id;
  };

  const seedPlatformPackages = async (store, imageId, contract, untar) => {
    const seedName = `tle-${identity.suite}-seed-${identity.invocation}`;
    const seed = await createVerifyContainer({
      name: seedName,
      Image: imageId,
      NetworkDisabled: true,
      HostConfig: { NetworkMode: 'none' },
    }, 'seed-source');
    try {
      const archive = await streamBuffer(
        await raw.getContainer(seed.Id).getArchive({ path: '/app/npm-seed' }),
      );
      const wanted = new Map([
        [`mqttsnet-thinglinks-edge-nodes-${contract.PLATFORM_NODE_PACKAGE.version}.tgz`,
          contract.PLATFORM_NODE_PACKAGE],
        [`mqttsnet-thinglinks-node-red-common-${contract.PLATFORM_COMMON_PACKAGE.version}.tgz`,
          contract.PLATFORM_COMMON_PACKAGE],
      ]);
      const found = new Set();
      for (const entry of untar(archive)) {
        const pin = wanted.get(basename(entry.name));
        if (!pin) continue;
        if (found.has(pin.name)) throw new Error(`Manager image has duplicate seed for ${pin.name}`);
        const meta = store.add(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content));
        if (meta.name !== pin.name || meta.version !== pin.version || meta.integrity !== pin.integrity) {
          throw new Error(`Manager image seed does not match ${pin.name}@${pin.version}`);
        }
        found.add(pin.name);
      }
      for (const pin of [contract.PLATFORM_NODE_PACKAGE, contract.PLATFORM_COMMON_PACKAGE]) {
        if (!found.has(pin.name)) throw new Error(`Manager image is missing reviewed seed ${pin.name}`);
      }
    } finally {
      const expected = expectedContainers.get(seedName);
      if (expected) {
        assertExactDockerResource(await inspectContainer(expected.id), expected);
        await raw.getContainer(expected.id).remove({ force: true });
        expectedContainers.delete(seedName);
      }
    }
  };

  const cleanup = async () => {
    if (cleanupResult) return cleanupResult;
    const failures = [];
    const remember = (error) => failures.push(error instanceof Error ? error.message : String(error));

    if (server) {
      try { await server.close(); } catch (error) { remember(error); }
      server = undefined;
    }

    // Verifier sidecars and seed containers: exact run/suite/invocation labels, then immutable IDs.
    try {
      const labels = {
        [VERIFIER_RUN_LABEL]: identity.runId,
        [VERIFIER_SUITE_LABEL]: identity.suite,
        [VERIFIER_INVOCATION_LABEL]: identity.invocation,
      };
      const summaries = await raw.listContainers({ all: true, filters: { label: labelFilters(labels) } });
      for (const summary of summaries) {
        try {
          const info = await inspectContainer(summary.Id);
          const name = String(info?.Name ?? '').replace(/^\//, '');
          const expected = expectedContainers.get(name);
          if (!expected || summary.Id !== expected.id) {
            throw new Error(`refusing cleanup for unknown verifier container ${summary.Id}`);
          }
          assertExactDockerResource(info, expected);
          await raw.getContainer(expected.id).remove({ force: true });
          expectedContainers.delete(name);
        } catch (error) { remember(error); }
      }
    } catch (error) { remember(error); }

    for (const expected of expectedContainers.values()) {
      try {
        const info = await inspectContainer(expected.name);
        if (!info) continue;
        assertExactDockerResource(info, expected);
        await raw.getContainer(expected.id).remove({ force: true });
      } catch (error) { remember(error); }
    }
    expectedContainers.clear();

    // Product containers do not accept verifier-only labels. Their immutable ID and
    // bootstrap ownership are captured before they start; later intentional replacements
    // must be explicitly recaptured by the verifier before cleanup may touch them.
    for (const id of Object.values(identity.instances)) {
      try {
        const matches = await raw.listContainers({
          all: true,
          filters: { label: labelFilters(exactInstanceLabels(id)) },
        });
        for (const summary of matches) {
          const info = await inspectContainer(summary.Id);
          const expected = expectedInstanceContainers.get(id);
          if (!expected || expected.id !== summary.Id) {
            throw new Error(`refusing cleanup for uncaptured instance container ${id}`);
          }
          assertExactDockerResource(info, expected);
          await raw.getContainer(expected.id).remove({ force: true });
          expectedInstanceContainers.delete(id);
        }
        const named = await inspectContainer(`tle-nr-${id}`);
        if (named) throw new Error(`instance container remains after scoped cleanup: ${id}`);
      } catch (error) { remember(error); }
    }

    for (const id of Object.values(identity.instances)) {
      try {
        const matches = await raw.listNetworks({
          filters: { label: labelFilters(exactInstanceLabels(id)) },
        });
        for (const summary of matches) {
          const info = await inspectNetwork(summary.Id);
          const expected = expectedNetworks.get(id);
          if (!expected || expected.id !== summary.Id) {
            throw new Error(`refusing cleanup for uncaptured instance network ${id}`);
          }
          assertExactDockerResource(info, expected);
          await raw.getNetwork(expected.id).remove();
        }
        const named = await inspectNetwork(networkName(id));
        if (named) throw new Error(`instance network remains after scoped cleanup: ${id}`);
      } catch (error) { remember(error); }
    }

    for (const [ref, imageId] of imageAliases) {
      try {
        const info = await raw.getImage(ref).inspect().catch((error) => {
          if (isDockerNotFound(error)) return undefined;
          throw error;
        });
        if (!info) continue;
        if (info.Id !== imageId) throw new Error(`refusing cleanup for changed image alias ${ref}`);
        await raw.getImage(ref).remove();
        const remains = await raw.getImage(ref).inspect().then(() => true).catch((error) => {
          if (isDockerNotFound(error)) return false;
          throw error;
        });
        if (remains) throw new Error(`image alias remains after cleanup: ${ref}`);
      } catch (error) { remember(error); }
    }
    imageAliases.clear();

    if (db?.open) {
      try { db.close(); } catch (error) { remember(error); }
    }

    if (runRoot) {
      try {
        const actual = await assertRunRoot();
        if (failures.length === 0) {
          await rm(actual, { recursive: true, force: false });
          await lstat(actual).then(
            () => { throw new Error(`verifier run root remains: ${actual}`); },
            (error) => { if (!isFsNotFound(error)) throw error; },
          );
        }
      } catch (error) { remember(error); }
    }
    cleanupResult = failures;
    return failures;
  };

  // Let the kernel reserve the Manager listener atomically. allocate-close-listen leaves
  // a TOCTOU window in which another local process can take the selected port.
  let managerPort = 0;
  reservedPorts.add(managerPort);
  try {
    const managerImageId = await resolveManagerImage();
    runRoot = await mkdtemp(join(canonicalParent, identity.rootPrefix));
    await assertRunRoot();
    await chmod(runRoot, 0o777);
    const dataDir = `${runRoot}/manager`;
    const instanceDataRoot = `${runRoot}/instances`;
    fixtureInstanceDataRoot = instanceDataRoot;
    await mkdir(`${dataDir}/npm`, { recursive: true, mode: 0o777 });
    await mkdir(instanceDataRoot, { recursive: true, mode: 0o777 });
    for (const id of Object.values(identity.instances)) {
      const port = await allocatePort();
      inboundPorts.set(id, port);
      reservedPorts.add(port);
    }

    const modules = await Promise.all([
      import('../dist/core/db.js'),
      import('../dist/core/config.js'),
      import('../dist/core/auth/crypto.js'),
      import('../dist/core/auth/service.js'),
      import('../dist/core/instance/repo.js'),
      import('../dist/core/instance/service.js'),
      import('../dist/core/instance/docker-client.js'),
      import('../dist/core/instance/settings-template.js'),
      import('../dist/core/instance/operation-gate.js'),
      import('../dist/core/instance/proxy-session-registry.js'),
      import('../dist/core/nodes/store.js'),
      import('../dist/core/nodes/catalog.js'),
      import('../dist/core/nodes/policy.js'),
      import('../dist/core/nodes/migration-checkpoint.js'),
      import('../dist/core/nodes/platform-migration.js'),
      import('../dist/core/nodes/platform-contract.js'),
      import('../dist/core/archive/tar.js'),
      import('../dist/http/app.js'),
      import('../dist/index.js'),
      import('bcryptjs'),
    ]);
    const [
      { openDb }, { adminRootFor }, { deriveKey, generatePassword }, { AuthService },
      { InstanceRepo }, { InstanceService }, { DockerClient }, { renderSettings },
      { InstanceOperationGate, InstanceRepositoryOperationPolicy },
      { ProxySessionRegistry }, { NodeStore }, { NodeCatalog }, { buildPolicy },
      { MigrationCheckpointStore },
      { NodeRedPlatformMigrationAdminActions, PlatformMigrationService }, contract,
      { untar }, { buildServer },
      { assembleInstanceAdminRuntime, assemblePlatformNodeServices, assemblePlatformOperationBarrier },
      bcrypt,
    ] = modules;

    db = openDb(join(dataDir, 'edge.db'));
    const key = deriveKey(randomBytes(32).toString('base64url'), 'thinglinks-edge:instance-cred');
    const repo = new InstanceRepo(db, key);
    const auth = new AuthService(db, key);
    const adminPassword = `Aa1!${randomBytes(24).toString('base64url')}`;
    const adminNextPassword = `Bb2!${randomBytes(24).toString('base64url')}`;
    auth.ensureInitialUser('admin', adminPassword);

    const store = new NodeStore(`${dataDir}/npm`);
    await seedPlatformPackages(store, managerImageId, contract, untar);
    const catalog = new NodeCatalog(db);
    const platformNodeServices = assemblePlatformNodeServices({ store, catalog });

    const docker = new DockerClient({
      network: identity.networkPrefix,
      imageRepo: 'nodered/node-red',
      portRange: { min: 30000, max: 60999 },
      instanceDataRoot,
      timezone: 'Asia/Shanghai',
      npmRegistry: `http://${identity.registryAlias}:${REGISTRY_PORT}/npm/`,
      managerUrl: `http://${identity.registryAlias}:${REGISTRY_PORT}`,
    });
    const productionCleanupBootstrap = docker.cleanupBootstrap.bind(docker);
    docker.cleanupBootstrap = async (id, txId) => {
      if (bootstrapBridgeCleanupDecision(instanceTx.get(id), txId) === 'remove') {
        await removeBootstrapBridges(id, txId);
      }
      return productionCleanupBootstrap(id, txId);
    };
    const platformOperation = assemblePlatformOperationBarrier({
      barrier: {
        async reach(event) {
          if (
            Object.values(identity.instances).includes(event.instanceId)
            && event.phase === 'preparing'
            && event.boundary === 'after-container-create'
          ) {
            instanceTx.set(event.instanceId, event.txId);
            try {
              await createBootstrapBridges(event.instanceId);
            } catch (error) {
              bootstrapDiagnostics.set(event.instanceId, `bridge-error:${error.message}`);
              throw error;
            }
          }
          await options.onBarrier?.(event);
        },
      },
    });
    const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
    const proxySessions = new ProxySessionRegistry();
    const instanceAdmin = assembleInstanceAdminRuntime({
      repo,
      upstreamFor: (id) => `http://127.0.0.1:${inboundPorts.get(id)}`,
    });
    let migrationService;
    const pendingStartCompletion = {
      completePendingStartUnderLease(id, lease, actor) {
        if (!migrationService) throw new Error('migration service is not assembled');
        return migrationService.completePendingStartUnderLease(id, lease, actor);
      },
    };
    const palettePolicy = () => buildPolicy(catalog.approved(), {
      allowInstall: true,
      catalogueUrl: '/npm/-/catalogue.json',
      publicCatalogueUrl: 'https://catalogue.nodered.org/catalogue.json',
      mode: 'allowlist',
    });
    const service = new InstanceService({
      ...instanceAdmin.instanceServiceDeps,
      ...platformOperation.instanceServiceDeps,
      db,
      repo,
      docker,
      gate: operationGate,
      instanceDataRoot,
      platformPackages: platformNodeServices.platformPackages,
      pendingStartCompletion,
      basePath: '',
      portRange: { min: 30000, max: 60999 },
      allowedImageTags: options.allowedImageTags,
      probeHostPorts: false,
      // HealthProbe lives inside InstanceService; host-mode verifiers must route it
      // through the same captured inbound bridge as AdminRuntime.
      upstreamFor: (id) => `http://127.0.0.1:${inboundPorts.get(id)}`,
      readHostStats: options.readHostStats ?? (async () => ({
        cpuCount: 4,
        loadPercent: 1,
        memTotalMb: 4096,
        memUsedMb: 512,
        memPercent: 12.5,
        memReliable: true,
        diskTotalGb: 100,
        diskUsedGb: 10,
        diskPercent: 10,
        uptimeSec: 100,
      })),
      palettePolicy,
    });
    migrationService = new PlatformMigrationService({
      repo,
      gate: operationGate,
      proxySessions,
      docker,
      adminRuntime: instanceAdmin.adminRuntime,
      admin: new NodeRedPlatformMigrationAdminActions(instanceAdmin.adminRuntime),
      platformPackages: platformNodeServices.platformPackages,
      checkpoint: new MigrationCheckpointStore(instanceDataRoot),
      settings: service,
      repair: service,
      bootstrapRecovery: service,
      ...platformOperation.migrationServiceDeps,
      instanceDataRoot,
    });

    const extraServerDeps = await options.createServerExtras?.({
      service, db, repo, runRoot, dataDir, instanceDataRoot,
    }) ?? {};
    const config = {
      externalUrl: `http://127.0.0.1:${managerPort}`,
      basePath: '',
      cookieSecure: false,
      allowedOrigins: [`http://127.0.0.1:${managerPort}`],
      listenAddr: '127.0.0.1',
      listenPort: managerPort,
      dataDir,
      dataRoot: runRoot,
      instanceDataRoot,
      portRange: { min: 30000, max: 60999 },
      timezone: 'Asia/Shanghai',
      updateCheckUrl: '',
    };
    server = buildServer({
      ...instanceAdmin.serverDeps,
      ...platformNodeServices.serverDeps,
      ...extraServerDeps,
      config,
      db,
      auth,
      repo,
      service,
      operationGate,
      migrationService,
      proxySessions,
      upstreamFor: (id) => `http://127.0.0.1:${inboundPorts.get(id)}`,
      nodeStore: store,
      nodeCatalog: catalog,
      npmRegistryUrl: `http://${identity.registryAlias}:${REGISTRY_PORT}/npm/`,
    });
    await server.listen({ host: '0.0.0.0', port: 0 });
    const managerAddress = server.server.address();
    if (!managerAddress || typeof managerAddress === 'string') {
      throw new Error('Manager verifier listener did not expose a TCP port');
    }
    managerPort = managerAddress.port;

    const baseUrl = `http://127.0.0.1:${managerPort}`;
    const createInstance = async (role, session, input) => {
      const id = identity.instances[role];
      if (!id) throw new Error(`unknown fixture instance role: ${role}`);
      const response = await fetch(`${baseUrl}/api/instances`, {
        method: 'POST',
        headers: session.headers,
        body: JSON.stringify({
          id,
          name: input.name ?? id,
          imageTag: input.imageTag,
          memoryMb: input.memoryMb ?? 512,
          cpus: input.cpus ?? 0.5,
          ports: input.ports ?? [],
        }),
      });
      const bodyText = await response.text();
      let body;
      try {
        body = requireSuccessfulInstanceCreate(id, response.status, bodyText);
      } catch (error) {
        const journal = repo.nodeMigration(id);
        const diagnostic = bootstrapDiagnostics.get(id) ?? 'bridge-not-reached';
        throw new Error(
          `${error.message}; bootstrap=${journal?.phase ?? 'missing'}/${journal?.error ?? 'missing'}; ${diagnostic}`,
          { cause: error },
        );
      }
      await captureInstanceResources(id);
      return { status: response.status, body };
    };

    const createLegacyInstance = async (role, input) => {
      const id = identity.instances[role];
      if (!id) throw new Error(`unknown fixture instance role: ${role}`);
      if (!options.allowedImageTags.includes(input.imageTag)) {
        throw new Error(`legacy fixture image is not allowed: ${input.imageTag}`);
      }
      await docker.assertBootstrapResourcesAbsent(id);
      const username = input.username ?? 'admin';
      const password = generatePassword();
      const credentialSecret = generatePassword(24);
      const ingestToken = generatePassword(32);
      const adminRoot = adminRootFor('', id);
      const bcryptApi = bcrypt.default ?? bcrypt;
      try {
        return await provisionLegacyInstance({
          repo,
          docker,
          adminRuntime: instanceAdmin.adminRuntime,
          renderSettings,
          afterContainerCreate: async (instanceId) => {
            const { network } = await captureLegacyResources(instanceId);
            await createInboundBridge(instanceId, network);
          },
        }, {
          id,
          name: input.name ?? id,
          imageTag: input.imageTag,
          memoryMb: input.memoryMb ?? 512,
          cpus: input.cpus ?? 0.5,
          ports: input.ports ?? [],
          adminRoot,
          credentialSecret,
          username,
          password,
          passwordHash: bcryptApi.hashSync(password, 8),
          ingestToken,
          palette: palettePolicy(),
        });
      } catch (error) {
        // Capture only exact random-id residuals so the outer cleanup can remove by
        // immutable ID. If creation failed before any Docker side effect this is a no-op.
        await captureLegacyResiduals(id);
        throw error;
      }
    };

    /**
     * Record the immutable container identity after an intentional image replacement.
     * The instance network must remain the exact bootstrap-owned network captured earlier.
     */
    const captureCurrentInstance = async (role) => {
      const id = identity.instances[role];
      if (!id) throw new Error(`unknown fixture instance role: ${role}`);
      const container = await inspectContainer(`tle-nr-${id}`);
      if (!container || !hasAllLabels(container.Config?.Labels, exactInstanceLabels(id))) {
        throw new Error(`replacement instance container ownership mismatch: ${id}`);
      }
      const labels = exactInstanceLabels(id);
      const bootstrapTx = container.Config?.Labels?.[BOOTSTRAP_TX_LABEL];
      if (bootstrapTx) labels[BOOTSTRAP_TX_LABEL] = bootstrapTx;
      expectedInstanceContainers.set(id, {
        kind: 'container', id: container.Id, name: `tle-nr-${id}`, labels,
      });

      const expectedNetwork = expectedNetworks.get(id);
      if (!expectedNetwork) throw new Error(`instance network was never captured: ${id}`);
      assertExactDockerResource(await inspectNetwork(expectedNetwork.id), expectedNetwork);
      return container;
    };

    const createImageAlias = async (sourceRef, repoName, tag) => {
      const alias = `${repoName}:${tag}`;
      return createTrackedImageAlias({
        ledger: imageAliases,
        inspectImage: (ref) => raw.getImage(ref).inspect().catch((error) => {
          if (isDockerNotFound(error)) return undefined;
          throw error;
        }),
        tagImage: (sourceId) => raw.getImage(sourceId).tag({ repo: repoName, tag }),
      }, { sourceRef, alias });
    };

    const prepareInstanceRemoval = async (role) => {
      const id = identity.instances[role];
      if (!id) throw new Error(`unknown fixture instance role: ${role}`);
      const expectedContainer = expectedInstanceContainers.get(id);
      const expectedNetwork = expectedNetworks.get(id);
      if (!expectedContainer || !expectedNetwork) {
        throw new Error(`instance network was never captured: ${id}`);
      }
      assertExactDockerResource(await inspectContainer(expectedContainer.id), expectedContainer);
      assertExactDockerResource(await inspectNetwork(expectedNetwork.id), expectedNetwork);
      const removal = Object.freeze({
        instanceId: id,
        containerId: expectedContainer.id,
        networkId: expectedNetwork.id,
        networkName: expectedNetwork.name,
      });
      await removeInstanceBridges(id);
      preparedRemovals.set(id, removal);
      return removal;
    };

    const assertPreparedInstanceRemoved = async (removal) => {
      if (!removal || preparedRemovals.get(removal.instanceId) !== removal) {
        throw new Error('prepared removal token is unknown or changed');
      }
      await assertPreparedRemovalAbsent({ inspectContainer, inspectNetwork }, removal);
      expectedInstanceContainers.delete(removal.instanceId);
      expectedNetworks.delete(removal.instanceId);
      preparedRemovals.delete(removal.instanceId);
      return true;
    };

    const allocateMappedPort = () => allocateMappedPortInRange(reservedPorts);

    return {
      identity,
      raw,
      baseUrl,
      adminPassword,
      adminNextPassword,
      db,
      repo,
      auth,
      docker,
      service,
      operationGate,
      migrationService,
      proxySessions,
      platformPackages: platformNodeServices.platformPackages,
      extraServerDeps,
      runRoot,
      dataDir,
      instanceDataRoot,
      inboundPort: (role) => inboundPorts.get(identity.instances[role]),
      createInstance,
      createLegacyInstance,
      captureCurrentInstance,
      createImageAlias,
      prepareInstanceRemoval,
      assertPreparedInstanceRemoved,
      allocateMappedPort,
      cleanup,
    };
  } catch (error) {
    const cleanupFailures = await cleanup();
    if (cleanupFailures.length > 0) {
      throw new Error(`${error.message}; cleanup failed: ${cleanupFailures.join(' | ')}`, { cause: error });
    }
    throw error;
  }
}
