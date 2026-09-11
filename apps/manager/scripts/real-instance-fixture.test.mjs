import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  VERIFIER_INSTANCE_LABEL,
  VERIFIER_INVOCATION_LABEL,
  VERIFIER_RUN_LABEL,
  VERIFIER_SUITE_LABEL,
  allocateMappedPortInRange,
  assertExactDockerResource,
  assertPreparedRemovalAbsent,
  bootstrapBridgeCleanupDecision,
  createFixtureIdentity,
  createTrackedImageAlias,
  exactResourceLabels,
  provisionLegacyInstance,
  requireSuccessfulInstanceCreate,
  resolveCanonicalTempParent,
} from './_real-instance-fixture.mjs';

test('legacy fixture provisions a real legacy-mode shape before starting it', async () => {
  const events = [];
  const created = [];
  const adapters = {
    repo: {
      create(record, ports, credentials) {
        events.push('repo');
        created.push({ record, ports, credentials });
      },
      setIngestToken(id, token) { events.push(`token:${id}:${token}`); },
    },
    docker: {
      async createInstance(spec, settings, mode) {
        events.push(`container:${mode}`);
        assert.equal(settings, 'rendered-legacy-settings');
        assert.equal(spec.ingestToken, 'known-ingest-token');
      },
      async start(id) { events.push(`start:${id}`); },
    },
    adminRuntime: {
      async waitReady(id) { events.push(`ready:${id}`); },
    },
    renderSettings(input) {
      events.push(`settings:${input.nodeRuntimeMode}`);
      assert.equal(input.credentials[0].passwordHash, 'known-password-hash');
      return 'rendered-legacy-settings';
    },
    async afterContainerCreate(id) { events.push(`capture:${id}`); },
  };

  const result = await provisionLegacyInstance(adapters, {
    id: 'upg-main-012345abcdef',
    name: 'legacy line',
    imageTag: '4.1.13-22-minimal',
    memoryMb: 512,
    cpus: 0.5,
    ports: [{ hostPort: 30081, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'test' }],
    adminRoot: '/red/upg-main-012345abcdef/',
    credentialSecret: 'known-credential-secret',
    username: 'admin',
    password: 'known-password',
    passwordHash: 'known-password-hash',
    ingestToken: 'known-ingest-token',
    palette: { allowInstall: false, allowList: [], denyList: ['*'], catalogues: [] },
  });

  assert.deepEqual(events, [
    'repo',
    'token:upg-main-012345abcdef:known-ingest-token',
    'settings:legacy',
    'container:legacy',
    'capture:upg-main-012345abcdef',
    'start:upg-main-012345abcdef',
    'ready:upg-main-012345abcdef',
  ]);
  assert.equal(created[0].record.nodeRuntimeMode, 'legacy');
  assert.deepEqual(created[0].ports, result.ports);
  assert.deepEqual(created[0].credentials, [{
    username: 'admin', password: 'known-password', permissions: '*',
  }]);
  assert.equal(result.password, 'known-password');
  assert.equal(result.ingestToken, 'known-ingest-token');
});

test('fixture identity uses a random valid instance id instead of a production name', () => {
  const identity = createFixtureIdentity({
    suite: 'health',
    roles: ['main'],
    outerRunId: 'gha-123-1',
    randomToken: '012345abcdef',
  });

  assert.deepEqual(identity.instances, { main: 'health-main-012345abcdef' });
  assert.equal(identity.runId, 'gha-123-1');
  assert.notEqual(identity.instances.main, 'line-1');
  assert.equal(identity.networkPrefix, 'tle-health-net-012345abcdef');
});

test('fixture sidecar labels bind cleanup to this run, suite, invocation and instance', () => {
  const identity = createFixtureIdentity({
    suite: 'tpl', roles: ['src', 'dst'], outerRunId: 'verify-7', randomToken: 'abcdef012345',
  });
  const labels = exactResourceLabels(identity, 'bridge-in', identity.instances.src);

  assert.deepEqual(labels, {
    [VERIFIER_RUN_LABEL]: 'verify-7',
    [VERIFIER_SUITE_LABEL]: 'tpl',
    [VERIFIER_INVOCATION_LABEL]: 'abcdef012345',
    'com.mqttsnet.thinglinks-edge.verifier-role': 'bridge-in',
    [VERIFIER_INSTANCE_LABEL]: 'tpl-src-abcdef012345',
  });
});

test('cleanup ownership rejects a same-name container with a changed immutable id or label', () => {
  const expected = {
    kind: 'container',
    id: 'immutable-a',
    name: 'tle-test-sidecar',
    labels: { owner: 'this-run' },
  };
  const exact = {
    Id: 'immutable-a', Name: '/tle-test-sidecar', Config: { Labels: { owner: 'this-run' } },
  };
  assert.equal(assertExactDockerResource(exact, expected), exact);
  assert.throws(
    () => assertExactDockerResource({ ...exact, Id: 'replacement' }, expected),
    /refusing cleanup/,
  );
  assert.throws(
    () => assertExactDockerResource({ ...exact, Config: { Labels: { owner: 'other-run' } } }, expected),
    /refusing cleanup/,
  );
});

test('instance create failure preserves the first HTTP cause and cannot fall through to socat', () => {
  assert.throws(
    () => requireSuccessfulInstanceCreate(
      'upg-main-012345abcdef',
      400,
      '{"error":"platform package preflight failed"}',
    ),
    /HTTP 400 platform package preflight failed/,
  );
  assert.deepEqual(
    requireSuccessfulInstanceCreate('upg-main-012345abcdef', 201, '{"instance":{"id":"x"}}'),
    { instance: { id: 'x' } },
  );
});

test('canonical temp root falls back to Linux /tmp and rejects an escaped root', () => {
  assert.equal(resolveCanonicalTempParent({
    existsSync: (path) => path === '/tmp',
    realpathSync: (path) => path,
  }), '/tmp');
  assert.throws(() => resolveCanonicalTempParent({
    existsSync: () => false,
    realpathSync: () => '/var/tmp',
  }), /escapes allowed boundary/);
});

test('fixture cleanup source contains no global managed-network sweep', () => {
  const source = readFileSync(new URL('./_real-instance-fixture.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /listNetworks\([\s\S]{0,160}managed=true/);
  assert.match(source, /filters: \{ label: labelFilters\(exactInstanceLabels\(id\)\) \}/);
  assert.match(source, /expectedInstanceContainers\.get\(id\)/);
  assert.match(source, /expectedNetworks\.get\(id\)/);
  assert.doesNotMatch(source, /kind: 'container', id: summary\.Id, name: `tle-nr-/);
});

test('bootstrap compensation removes exact fixture bridges before production cleanup', () => {
  const source = readFileSync(new URL('./_real-instance-fixture.mjs', import.meta.url), 'utf8');
  const wrapper = source.slice(source.indexOf('docker.cleanupBootstrap = async'));
  assert.ok(wrapper.indexOf('await removeBootstrapBridges(id, txId)') >= 0);
  assert.ok(
    wrapper.indexOf('await removeBootstrapBridges(id, txId)')
      < wrapper.indexOf('return productionCleanupBootstrap(id, txId)'),
  );
  assert.match(source, /getNetwork\(expectedNetwork\.id\)\.connect\(\{/);
  assert.match(source, /EndpointConfig: \{ Aliases: \[identity\.registryAlias\] \}/);
  assert.match(source, /getNetwork\(expectedNetwork\.id\)\.disconnect\(\{/);
});

test('host-mode fixture routes InstanceService health probes through the captured inbound bridge', () => {
  const source = readFileSync(new URL('./_real-instance-fixture.mjs', import.meta.url), 'utf8');
  assert.match(source,
    /upstreamFor: \(id\) => `http:\/\/127\.0\.0\.1:\$\{inboundPorts\.get\(id\)\}`/);
});

test('Manager listener uses kernel-assigned port zero without an allocate-close race', () => {
  const source = readFileSync(new URL('./_real-instance-fixture.mjs', import.meta.url), 'utf8');
  assert.match(source, /server\.listen\(\{ host: '0\.0\.0\.0', port: 0 \}\)/);
  assert.match(source, /managerPort = managerAddress\.port/);
  assert.doesNotMatch(source, /const managerPort = await allocatePort\(\)/);
});

test('mapped-port allocation samples the Manager range directly and retries occupied candidates', async () => {
  const candidates = [30010, 30011, 42000];
  const reserved = new Set([30010]);
  const probed = [];
  const port = await allocateMappedPortInRange(reserved, {
    nextCandidate: () => candidates.shift(),
    canBind: async (candidate) => {
      probed.push(candidate);
      return candidate === 42000;
    },
  });
  assert.equal(port, 42000);
  assert.deepEqual(probed, [30011, 42000]);
  assert.equal(reserved.has(42000), true);
});

test('bootstrap compensation delegates when failure happened before the bridge barrier', () => {
  assert.equal(bootstrapBridgeCleanupDecision(undefined, 'bootstrap-current'), 'delegate');
  assert.equal(bootstrapBridgeCleanupDecision('bootstrap-current', 'bootstrap-current'), 'remove');
  assert.throws(
    () => bootstrapBridgeCleanupDecision('bootstrap-foreign', 'bootstrap-current'),
    /mismatched transaction/,
  );
});

test('sidecars use the pinned multi-arch socat index and expose exact removal preparation', () => {
  const source = readFileSync(new URL('./_real-instance-fixture.mjs', import.meta.url), 'utf8');
  const digest = 'alpine/socat@sha256:5f275aa1b6e9889c851f61097142ee050fc6ac4615b4ea64ac1f2b0e81ff8d7f';
  assert.equal(source.split(digest).length - 1, 1);
  assert.equal(source.split('Image: SOCAT_IMAGE').length - 1, 2);
  assert.doesNotMatch(source, /Image: 'alpine\/socat'/);
  assert.match(source, /const prepareInstanceRemoval = async \(role\)/);
  assert.match(source, /await removeInstanceBridges\(id\)/);
});

test('image alias ledger is durable in memory before post-tag inspect can fail', async () => {
  const ledger = new Map();
  let aliasInspections = 0;
  await assert.rejects(() => createTrackedImageAlias({
    ledger,
    inspectImage: async (ref) => {
      if (ref === 'alpine:3.22') return { Id: 'sha256:source' };
      aliasInspections += 1;
      if (aliasInspections === 1) return undefined;
      throw new Error('injected post-tag inspect failure');
    },
    tagImage: async () => undefined,
  }, {
    sourceRef: 'alpine:3.22',
    alias: 'nodered/node-red:tle-broken-owned',
  }), /post-tag inspect failure/);

  assert.equal(ledger.get('nodered/node-red:tle-broken-owned'), 'sha256:source');
});

test('prepared removal proves both immutable ids and mutable names are absent', async () => {
  const calls = [];
  const removal = Object.freeze({
    instanceId: 'api-primary-012345abcdef',
    containerId: 'container-id',
    networkId: 'network-id',
    networkName: 'network-name',
  });
  await assertPreparedRemovalAbsent({
    inspectContainer: async (ref) => { calls.push(`container:${ref}`); return undefined; },
    inspectNetwork: async (ref) => { calls.push(`network:${ref}`); return undefined; },
  }, removal);
  assert.deepEqual(calls, [
    'container:container-id',
    'container:tle-nr-api-primary-012345abcdef',
    'network:network-id',
    'network:network-name',
  ]);

  await assert.rejects(() => assertPreparedRemovalAbsent({
    inspectContainer: async () => undefined,
    inspectNetwork: async (ref) => ref === 'network-name' ? { Id: 'replacement' } : undefined,
  }, removal), /still exists/);
});
