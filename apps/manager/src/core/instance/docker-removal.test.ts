import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerClient, MANAGED_LABEL } from './docker-client.ts';

const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const CONTAINER_ID = 'a'.repeat(64), NETWORK_ID = 'b'.repeat(64), MANAGER_ID = 'c'.repeat(64);
const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });
const unavailable = () => Object.assign(new Error('daemon unavailable'), { statusCode: 500 });

function fixture(t: TestContext, manager = false) {
  const root = mkdtempSync(join(tmpdir(), 'tle-removal-test-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const data = join(root, 'line-a'); mkdirSync(data);
  writeFileSync(join(data, 'flows.json'), 'retained-data');
  const client = new DockerClient({ connection: { socketPath: '/dev/null' }, network: 'test-edge',
    imageRepo: 'nodered/node-red', portRange: { min: 30000, max: 30999 },
    instanceDataRoot: root, timezone: 'UTC', ...(manager ? { managerContainer: 'manager' } : {}) });
  const mutations: string[] = [], inspections: string[] = [];
  const state = { containerGone: false, networkGone: false, managerAttached: manager,
    containerForeign: false, networkForeign: false, replacementContainer: false,
    containerInspectError: false, networkInspectError: false,
    containerDeleteError: 0, networkDeleteError: 0, disconnectError: false,
    disconnectRace: false, vanishedDelete404: false, replacementAfterNetworkDelete: false };
  const raw = client.raw;
  raw.getContainer = ((ref: string) => ({
    inspect: async () => {
      inspections.push(`container:${ref}`);
      if (ref === 'manager') return { Id: MANAGER_ID };
      if (state.containerInspectError) throw unavailable();
      if (state.containerGone) {
        if (state.replacementContainer && ref === 'tle-nr-line-a') return { Id: 'd'.repeat(64) };
        throw notFound();
      }
      return { Id: CONTAINER_ID, Name: '/tle-nr-line-a', Config: { Labels: {
        [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: state.containerForeign ? 'line-b' : 'line-a',
      } } };
    },
    remove: async () => {
      mutations.push(`remove-container:${ref}`);
      if (state.containerDeleteError) {
        if (state.vanishedDelete404) state.containerGone = true;
        throw state.containerDeleteError === 404 ? notFound() : unavailable();
      }
      state.containerGone = true;
    },
  })) as unknown as typeof raw.getContainer;
  raw.getNetwork = ((ref: string) => ({
    inspect: async () => {
      inspections.push(`network:${ref}`);
      if (state.networkInspectError) throw unavailable();
      if (state.networkGone) throw notFound();
      return { Id: NETWORK_ID, Name: 'test-edge-line-a', Labels: {
        [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: state.networkForeign ? 'line-b' : 'line-a',
      }, Containers: state.managerAttached ? { [MANAGER_ID]: { Name: 'manager' } } : {} };
    },
    remove: async () => {
      mutations.push(`remove-network:${ref}`);
      if (state.networkDeleteError) throw state.networkDeleteError === 404 ? notFound() : unavailable();
      state.networkGone = true;
      if (state.replacementAfterNetworkDelete) state.replacementContainer = true;
    },
    disconnect: async () => {
      mutations.push(`disconnect:${ref}`);
      if (state.disconnectRace) state.managerAttached = false;
      if (state.disconnectError) throw unavailable();
      state.managerAttached = false;
    },
  })) as unknown as typeof raw.getNetwork;
  return { client, state, mutations, inspections, data, root };
}

for (const failure of ['containerForeign', 'containerInspectError', 'networkForeign', 'networkInspectError'] as const) {
  test(`removal preflight preserves all resources when ${failure}`, async t => {
    const f = fixture(t); f.state[failure] = true;
    await assert.rejects(f.client.remove('line-a', { removeData: true }));
    assert.deepEqual(f.mutations, []); assert.ok(existsSync(f.data));
  });
}

for (const status of [404, 500]) {
  test(`container delete ${status} cannot erase network or data while the immutable container remains`, async t => {
    const f = fixture(t); f.state.containerDeleteError = status;
    await assert.rejects(f.client.remove('line-a', { removeData: true }));
    assert.deepEqual(f.mutations, [`remove-container:${CONTAINER_ID}`]); assert.ok(existsSync(f.data));
  });
  test(`network delete ${status} cannot erase data while the immutable network remains`, async t => {
    const f = fixture(t); f.state.networkDeleteError = status;
    await assert.rejects(f.client.remove('line-a', { removeData: true }));
    assert.ok(existsSync(f.data));
  });
}

test('successful delete verifies immutable resources and preserves retained-data mode', async t => {
  const f = fixture(t, true);
  await f.client.remove('line-a', { removeData: false });
  assert.deepEqual(f.mutations, [`remove-container:${CONTAINER_ID}`, `disconnect:${NETWORK_ID}`, `remove-network:${NETWORK_ID}`]);
  assert.ok(f.inspections.includes(`container:${CONTAINER_ID}`));
  assert.ok(f.inspections.includes(`network:${NETWORK_ID}`));
  assert.ok(existsSync(f.data));
});

test('delete 404 is idempotent only after the immutable container is confirmed absent', async t => {
  const f = fixture(t); f.state.containerDeleteError = 404; f.state.vanishedDelete404 = true;
  await f.client.remove('line-a', { removeData: true });
  assert.ok(f.inspections.includes(`container:${CONTAINER_ID}`));
  assert.equal(existsSync(f.data), false);
});

test('a replacement at the instance name prevents retained data from being removed', async t => {
  const f = fixture(t); f.state.replacementContainer = true;
  await assert.rejects(f.client.remove('line-a', { removeData: true }));
  assert.ok(existsSync(f.data));
});

test('a container appearing during network cleanup is checked again before data deletion', async t => {
  const f = fixture(t); f.state.replacementAfterNetworkDelete = true;
  await assert.rejects(f.client.remove('line-a', { removeData: true }));
  assert.ok(existsSync(f.data));
});

test('already absent Docker resources permit explicit data cleanup', async t => {
  const f = fixture(t); f.state.containerGone = true; f.state.networkGone = true;
  await f.client.remove('line-a', { removeData: true });
  assert.deepEqual(f.mutations, []); assert.equal(existsSync(f.data), false);
});

test('invalid instance ID fails before daemon or data access', async t => {
  const f = fixture(t); f.state.containerGone = true; f.state.networkGone = true;
  await assert.rejects(f.client.remove('../line-a', { removeData: true }));
  assert.deepEqual(f.inspections, []); assert.ok(existsSync(f.data));
});

test('Manager already absent from network does not need a failing disconnect', async t => {
  const f = fixture(t, true); f.state.managerAttached = false; f.state.disconnectError = true;
  await f.client.remove('line-a', { removeData: true });
  assert.equal(f.mutations.some(item => item.startsWith('disconnect:')), false);
});

test('disconnect error succeeds only when fresh inspection proves Manager already detached', async t => {
  const f = fixture(t, true); f.state.disconnectError = true; f.state.disconnectRace = true;
  await f.client.remove('line-a', { removeData: true });
  assert.equal(existsSync(f.data), false);
});

test('a genuine Manager detach failure preserves the network and data', async t => {
  const f = fixture(t, true); f.state.disconnectError = true;
  await assert.rejects(f.client.remove('line-a', { removeData: true }));
  assert.equal(f.mutations.some(item => item.startsWith('remove-network:')), false);
  assert.ok(existsSync(f.data));
});
