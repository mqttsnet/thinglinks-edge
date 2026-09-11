import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBundleImagesLoaded,
  captureDockerResource,
  captureBundleImageState,
  cleanupTrackedDockerResources,
  cleanupTrackedImageAliases,
  createInvocationIdentity,
  createOwnedTempArea,
  createTrackedImageAlias,
  expectedDockerResources,
  forbiddenDockerResources,
  removeOwnedTempArea,
  requireDockerNameAbsent,
  restoreBundleImageState,
  seededApprovalContract,
  selectBundleSource,
} from './verify-offline.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_SOURCE = readFileSync(join(SCRIPT_DIR, 'verify-offline.mjs'), 'utf8');

test('offline verifier consumes the exact bundle from verify-all before using its standalone fallback', () => {
  assert.match(VERIFY_SOURCE, /TLE_PLATFORM_OFFLINE_BUNDLE/);
  assert.match(VERIFY_SOURCE, /provided exact artifact/);
  assert.match(VERIFY_SOURCE, /standalone fallback/);
});

test('offline verifier never resets the shared verifier data root', () => {
  assert.doesNotMatch(VERIFY_SOURCE, /resetRoot|resetDataDir|TEST_EDGE_ROOT/);
  assert.match(VERIFY_SOURCE, /createOwnedTempArea/);
});

test('offline verifier uses invocation-scoped Docker identities and immutable ownership cleanup', () => {
  assert.match(VERIFY_SOURCE, /createInvocationIdentity/);
  assert.match(VERIFY_SOURCE, /requireDockerNameAbsent/);
  assert.match(VERIFY_SOURCE, /captureDockerResource/);
  assert.match(VERIFY_SOURCE, /cleanupTrackedDockerResources/);
  assert.match(VERIFY_SOURCE, /com\.docker\.compose\.project/);
  assert.doesNotMatch(VERIFY_SOURCE, /const PREFIX = 'tle-off'/);
  assert.doesNotMatch(VERIFY_SOURCE, /const ID = 'off-a'/);
  assert.doesNotMatch(VERIFY_SOURCE, /rmi', '-f'/);
});

test('offline verifier owns and verifies every recursive temporary-directory cleanup', () => {
  assert.match(VERIFY_SOURCE, /assertOwnedTempArea/);
  assert.match(VERIFY_SOURCE, /\.tle-offline-owner/);
  assert.doesNotMatch(VERIFY_SOURCE, /rmSync\(outDir/);
  assert.doesNotMatch(VERIFY_SOURCE, /rmSync\(seedDir/);
});

test('provided exact artifact auto-approves only the pinned Edge package while fallback seeds stay unapproved', () => {
  const exact = [
    { module: '@mqttsnet/thinglinks-edge-nodes', approved: true },
    { module: '@mqttsnet/thinglinks-node-red-common', approved: false },
  ];
  assert.equal(seededApprovalContract('provided', exact), true);
  assert.equal(seededApprovalContract('provided', exact.map((item) => ({ ...item, approved: false }))), false);
  assert.equal(seededApprovalContract('provided', [exact[0], { ...exact[1], approved: true }]), false);
  assert.equal(seededApprovalContract('fallback', [{ module: 'fixture', approved: false }]), true);
  assert.equal(seededApprovalContract('fallback', [{ module: 'fixture', approved: true }]), false);
});

const immutableId = (digit) => `sha256:${digit.repeat(64)}`;

class FakeDocker {
  constructor() {
    this.byName = { container: new Map(), network: new Map() };
    this.byId = { container: new Map(), network: new Map() };
    this.removals = [];
  }

  put(kind, info) {
    const name = kind === 'container' ? info.Name.replace(/^\//, '') : info.Name;
    const record = { info, removed: false };
    this.byName[kind].set(name, record);
    this.byId[kind].set(info.Id, record);
    return record;
  }

  drop(kind, ref) {
    const record = this.byId[kind].get(ref) ?? this.byName[kind].get(ref);
    if (record) record.removed = true;
  }

  handle(kind, ref) {
    return {
      inspect: async () => {
        const record = this.byId[kind].get(ref) ?? this.byName[kind].get(ref);
        if (!record || record.removed) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return record.info;
      },
      remove: async () => {
        const record = this.byId[kind].get(ref) ?? this.byName[kind].get(ref);
        if (!record || record.removed) throw Object.assign(new Error('not found'), { statusCode: 404 });
        this.removals.push({ kind, ref });
        record.removed = true;
      },
    };
  }

  getContainer(ref) { return this.handle('container', ref); }
  getNetwork(ref) { return this.handle('network', ref); }
}

function containerInfo(id, name, labels) {
  return { Id: id, Name: `/${name}`, Config: { Labels: labels }, State: { Running: true } };
}

test('provided exact artifact wins and standalone fallback is not called', async () => {
  let fallbackCalls = 0;
  const selected = await selectBundleSource({
    providedBundle: ' /tmp/exact.tar.gz ',
    validateProvided: (value) => `validated:${value}`,
    buildFallback: async () => {
      fallbackCalls += 1;
      return '/tmp/fallback.tar.gz';
    },
  });
  assert.deepEqual(selected, { mode: 'provided', bundle: 'validated:/tmp/exact.tar.gz' });
  assert.equal(fallbackCalls, 0);
});

test('standalone fallback is explicit when no exact artifact was provided', async () => {
  const selected = await selectBundleSource({
    providedBundle: '',
    validateProvided: () => assert.fail('provided validator must not run'),
    buildFallback: async () => '/tmp/fallback.tar.gz',
  });
  assert.deepEqual(selected, { mode: 'fallback', bundle: '/tmp/fallback.tar.gz' });
});

test('invocation identity is deterministic for its run+nonce and never uses legacy fixed names', () => {
  const first = createInvocationIdentity({ outerRunId: 'gha-42-1', randomToken: 'a1b2c3d4e5f6' });
  const same = createInvocationIdentity({ outerRunId: 'gha-42-1', randomToken: 'a1b2c3d4e5f6' });
  const other = createInvocationIdentity({ outerRunId: 'gha-42-1', randomToken: 'f6e5d4c3b2a1' });
  assert.deepEqual(first, same);
  assert.notEqual(first.prefix, other.prefix);
  assert.notEqual(first.instanceId, 'off-a');
  assert.notEqual(first.managerName, 'tle-off-manager');
  assert.match(first.fakeImages.manager, new RegExp(`/${first.scope}/manager:probe$`));
  assert.equal(first.defaultComposeNetwork, `${first.project}_default`);
});

test('compose default network is forbidden by network_mode:none and retained only for exact detection', () => {
  const identity = createInvocationIdentity({
    outerRunId: 'entry-test-default-net',
    randomToken: 'deafbeefcafe',
  });
  assert.equal(expectedDockerResources(identity).some(
    (item) => item.name === identity.defaultComposeNetwork,
  ), false);
  assert.deepEqual(forbiddenDockerResources(identity), [{
    kind: 'network',
    name: `${identity.project}_default`,
    cleanupOrder: 39,
    labels: {
      'com.docker.compose.project': identity.project,
      'com.docker.compose.network': 'default',
    },
  }]);
});

test('preflight refuses an external same-name container without deleting it', async () => {
  const raw = new FakeDocker();
  const name = 'tle-off-deadbeefcafe-manager';
  raw.put('container', containerInfo(immutableId('1'), name, { owner: 'external' }));
  await assert.rejects(
    requireDockerNameAbsent(raw, { kind: 'container', name }),
    /refusing pre-existing container name/,
  );
  assert.deepEqual(raw.removals, []);
});

test('captured container cleanup rechecks ownership and deletes only by immutable ID', async () => {
  const raw = new FakeDocker();
  const id = immutableId('2');
  const name = 'tle-off-deadbeefcafe-manager';
  const labels = {
    'com.docker.compose.project': 'tle-offline-deadbeefcafe',
    'com.docker.compose.service': 'manager',
  };
  raw.put('container', containerInfo(id, name, labels));
  const expected = { kind: 'container', name, labels, cleanupOrder: 20 };
  const ledger = new Map();
  await captureDockerResource(raw, ledger, expected);
  await cleanupTrackedDockerResources(raw, ledger);
  assert.deepEqual(raw.removals, [{ kind: 'container', ref: id }]);
  assert.equal(ledger.size, 0);
});

test('cleanup refuses a same-name replacement after captured ID disappears', async () => {
  const raw = new FakeDocker();
  const originalId = immutableId('3');
  const replacementId = immutableId('4');
  const name = 'tle-off-deadbeefcafe-manager';
  const labels = {
    'com.docker.compose.project': 'tle-offline-deadbeefcafe',
    'com.docker.compose.service': 'manager',
  };
  raw.put('container', containerInfo(originalId, name, labels));
  const ledger = new Map();
  await captureDockerResource(raw, ledger, { kind: 'container', name, labels, cleanupOrder: 20 });
  raw.drop('container', originalId);
  raw.put('container', containerInfo(replacementId, name, { owner: 'external' }));
  await assert.rejects(cleanupTrackedDockerResources(raw, ledger), /offline Docker cleanup failed/);
  assert.deepEqual(raw.removals, []);
});

test('image aliases refuse pre-existing names and cleanup refuses a repointed tag', async () => {
  const sourceId = immutableId('5');
  const replacementId = immutableId('6');
  const state = new Map([['source:tag', { Id: sourceId }]]);
  const removals = [];
  const adapters = {
    inspect: async (ref) => state.get(ref),
    tag: async (id, alias) => state.set(alias, { Id: id }),
    remove: async (alias) => { removals.push(alias); state.delete(alias); },
  };
  const ledger = new Map();
  state.set('external:probe', { Id: replacementId });
  await assert.rejects(
    createTrackedImageAlias(adapters, ledger, 'source:tag', 'external:probe'),
    /refusing pre-existing image alias/,
  );
  state.delete('external:probe');
  await createTrackedImageAlias(adapters, ledger, 'source:tag', 'owned:probe');
  state.set('owned:probe', { Id: replacementId });
  await assert.rejects(cleanupTrackedImageAliases(adapters, ledger), /image-alias cleanup failed/);
  assert.deepEqual(removals, []);
});

test('image alias cleanup removes the owned tag and never removes its source ID', async () => {
  const sourceId = immutableId('7');
  const state = new Map([['source:tag', { Id: sourceId }]]);
  const removals = [];
  const adapters = {
    inspect: async (ref) => state.get(ref),
    tag: async (id, alias) => state.set(alias, { Id: id }),
    remove: async (alias) => { removals.push(alias); state.delete(alias); },
  };
  const ledger = new Map();
  await createTrackedImageAlias(adapters, ledger, 'source:tag', 'owned:probe');
  await cleanupTrackedImageAliases(adapters, ledger);
  assert.deepEqual(removals, ['owned:probe']);
  assert.deepEqual(state.get('source:tag'), { Id: sourceId });
});

test('exact bundle load restores pre-existing descriptor tags and removes newly introduced refs', async () => {
  const descriptorId = immutableId('8');
  const configId = immutableId('9');
  const state = new Map([['existing:tag', { Id: descriptorId }]]);
  const tags = [];
  const removals = [];
  const adapters = {
    inspect: async (ref) => state.get(ref),
    tag: async (id, alias) => { tags.push({ id, alias }); state.set(alias, { Id: id }); },
    remove: async (alias) => { removals.push(alias); state.delete(alias); },
  };
  const manifest = { images: [
    { image: 'existing:tag', id: configId },
    { image: 'new:tag', id: configId },
  ] };
  const captured = await captureBundleImageState(adapters, manifest);
  state.set('existing:tag', { Id: configId });
  state.set('new:tag', { Id: configId });
  for (const entry of captured.values()) entry.loadedId = configId;
  await restoreBundleImageState(adapters, captured);
  assert.deepEqual(tags, [{ id: descriptorId, alias: 'existing:tag' }]);
  assert.deepEqual(removals, ['new:tag']);
  assert.equal(state.get('existing:tag').Id, descriptorId);
  assert.equal(state.has('new:tag'), false);
});

test('standalone fake ref accepts its captured descriptor after load, then removes only that tag', async () => {
  const descriptorId = immutableId('a');
  const configId = immutableId('b');
  const state = new Map();
  const removals = [];
  const adapters = {
    inspect: async (ref) => state.get(ref),
    tag: async (id, alias) => state.set(alias, { Id: id }),
    remove: async (alias) => { removals.push(alias); state.delete(alias); },
  };
  const manifest = { images: [{ image: 'random-fake:probe', id: configId }] };
  const captured = await captureBundleImageState(
    adapters,
    manifest,
    new Map([['random-fake:probe', descriptorId]]),
  );
  state.set('random-fake:probe', { Id: descriptorId });
  await assertBundleImagesLoaded(adapters, captured);
  await restoreBundleImageState(adapters, captured);
  assert.deepEqual(removals, ['random-fake:probe']);
  assert.equal(state.has('random-fake:probe'), false);
});

test('owned install directory removes extracted images.tar on success', () => {
  const identity = createInvocationIdentity({
    outerRunId: 'entry-test-001',
    randomToken: '0123456789ab',
  });
  const area = createOwnedTempArea(identity, 'install');
  const images = join(area.path, 'images.tar');
  writeFileSync(images, 'fixture');
  removeOwnedTempArea(area);
  assert.equal(existsSync(area.path), false);
  assert.equal(existsSync(images), false);
});

test('owned recursive cleanup refuses a changed marker', () => {
  const identity = createInvocationIdentity({
    outerRunId: 'entry-test-002',
    randomToken: 'abcdef012345',
  });
  const area = createOwnedTempArea(identity, 'install');
  try {
    writeFileSync(area.marker, 'external\n');
    assert.throws(() => removeOwnedTempArea(area), /marker changed owner/);
    assert.equal(existsSync(area.path), true);
  } finally {
    writeFileSync(area.marker, area.ownerText);
    removeOwnedTempArea(area);
  }
});

test('owned recursive cleanup refuses symlinked and hard-linked owner markers', () => {
  const identity = createInvocationIdentity({
    outerRunId: 'entry-test-003',
    randomToken: '123456abcdef',
  });

  const symlinkArea = createOwnedTempArea(identity, 'install');
  const outside = `${symlinkArea.path}-external-marker`;
  try {
    writeFileSync(outside, symlinkArea.ownerText);
    rmSync(symlinkArea.marker);
    symlinkSync(outside, symlinkArea.marker);
    assert.throws(() => removeOwnedTempArea(symlinkArea), /ownership marker changed/);
  } finally {
    rmSync(symlinkArea.marker, { force: true });
    writeFileSync(symlinkArea.marker, symlinkArea.ownerText);
    removeOwnedTempArea(symlinkArea);
    rmSync(outside, { force: true });
  }

  const hardlinkArea = createOwnedTempArea(identity, 'install');
  const alias = `${hardlinkArea.marker}.alias`;
  try {
    linkSync(hardlinkArea.marker, alias);
    assert.throws(() => removeOwnedTempArea(hardlinkArea), /ownership marker changed/);
  } finally {
    rmSync(alias, { force: true });
    removeOwnedTempArea(hardlinkArea);
  }
});
