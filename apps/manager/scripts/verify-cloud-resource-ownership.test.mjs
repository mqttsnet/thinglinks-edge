import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const scripts = [
  'verify-cloud-gateway.mjs',
  'verify-cloud-link.mjs',
  'verify-cloud-tls.mjs',
];

const verifierModules = await Promise.all(scripts.map(async (script) => [
  script,
  await import(`./${script}`),
]));

const missing = () => Object.assign(new Error('No such object: test'), {
  status: 1,
  stderr: 'Error: No such object: test',
});

function fakeDockerRunner(initial = []) {
  const byRef = new Map();
  const removals = [];
  const put = (info) => {
    const name = info.Name.replace(/^\//, '');
    byRef.set(info.Id, info);
    byRef.set(name, info);
  };
  const drop = (info) => {
    const name = info.Name.replace(/^\//, '');
    byRef.delete(info.Id);
    byRef.delete(name);
  };
  for (const info of initial) put(info);

  const runner = (args) => {
    if (args[0] === 'inspect') {
      const info = byRef.get(args.at(-1));
      if (!info) throw missing();
      return JSON.stringify([info]);
    }
    if (args[0] === 'rm') {
      const ref = args.at(-1);
      const info = byRef.get(ref);
      if (!info) throw missing();
      removals.push(ref);
      drop(info);
      return ref;
    }
    throw new Error(`unexpected Docker command: ${args.join(' ')}`);
  };
  return { runner, byRef, put, drop, removals };
}

const containerInfo = (id, name, labels) => ({
  Id: id,
  Name: `/${name}`,
  Config: { Labels: labels },
});

for (const script of scripts) {
  test(`${script} uses random run-scoped Docker ownership`, () => {
    const source = readFileSync(join(SCRIPT_ROOT, script), 'utf8');

    assert.match(source, /createFixtureIdentity/);
    assert.match(source, /exactResourceLabels/);
    assert.match(source, /captureCreatedDockerResource/);
    assert.match(source, /cleanupTrackedDockerResources/);
    assert.match(source, /VERIFIER_INVOCATION_LABEL/);
    assert.match(source, /requireDockerNameAbsent/);
    assert.doesNotMatch(source, /['"]tle-(?:mqtt-verify|cloudlink-mqtt|cloudtls-mqtt|cloudlink-net|cloudtls-net)['"]/);
    assert.doesNotMatch(source, /\[['"]rm['"], ['"]-f['"], NAME\]/);
    assert.doesNotMatch(source, /line-1/);
  });

  test(`${script} owns and verifies every temporary root before removal`, () => {
    const source = readFileSync(join(SCRIPT_ROOT, script), 'utf8');

    assert.match(source, /createOwnedTempRoot/);
    assert.match(source, /cleanupOwnedTempRoot/);
    assert.match(source, /resolveCanonicalTempParent/);
    assert.match(source, /\.verifier-owner/);
    assert.match(source, /mkdtempSync/);
    assert.match(source, /renameSync/);
    assert.match(source, /rmSync/);
    assert.doesNotMatch(source, /tmpdir\(\)/);
  });
}

for (const [script, verifier] of verifierModules) {
  test(`${script} refuses an occupied broker name without deleting it`, () => {
    const foreign = containerInfo('f'.repeat(64), 'occupied-broker', { owner: 'foreign' });
    const bed = fakeDockerRunner([foreign]);

    assert.throws(
      () => verifier.requireDockerNameAbsent(bed.runner, 'occupied-broker'),
      /already occupied/,
    );
    assert.deepEqual(bed.removals, []);
    assert.equal(bed.byRef.get('occupied-broker'), foreign);
  });

  test(`${script} captures and removes only the immutable broker id`, () => {
    const id = 'a'.repeat(64);
    const name = 'owned-broker';
    const labels = {
      'com.mqttsnet.thinglinks-edge.verifier-run': 'run-1',
      'com.mqttsnet.thinglinks-edge.verifier-suite': 'suite-1',
      'com.mqttsnet.thinglinks-edge.verifier-invocation': '012345abcdef',
    };
    const bed = fakeDockerRunner([containerInfo(id, name, labels)]);
    const ledger = [];

    verifier.captureCreatedDockerResource(bed.runner, ledger, {
      name, labels, createdId: `${id}\n`,
    });
    assert.equal(ledger[0].id, id);
    assert.deepEqual(verifier.cleanupTrackedDockerResources(bed.runner, ledger), []);
    assert.deepEqual(bed.removals, [id]);
    assert.deepEqual(ledger, []);
  });

  test(`${script} rejects an abbreviated Docker id as non-immutable cleanup evidence`, () => {
    const ledger = [];
    assert.throws(() => verifier.captureCreatedDockerResource(() => {
      throw new Error('inspect must not run for an invalid id');
    }, ledger, {
      name: 'owned-broker', labels: {}, createdId: 'abcdef123456',
    }), /did not return an immutable id/);
    assert.deepEqual(ledger, []);
  });

  test(`${script} preserves a same-name replacement after its captured id disappears`, () => {
    const ownedId = 'a'.repeat(64);
    const name = 'owned-broker';
    const labels = {
      'com.mqttsnet.thinglinks-edge.verifier-run': 'run-1',
      'com.mqttsnet.thinglinks-edge.verifier-suite': 'suite-1',
      'com.mqttsnet.thinglinks-edge.verifier-invocation': '012345abcdef',
    };
    const owned = containerInfo(ownedId, name, labels);
    const bed = fakeDockerRunner([owned]);
    const ledger = [];
    verifier.captureCreatedDockerResource(bed.runner, ledger, {
      name, labels, createdId: ownedId,
    });

    bed.drop(owned);
    const replacement = containerInfo('b'.repeat(64), name, { owner: 'foreign' });
    bed.put(replacement);
    const failures = verifier.cleanupTrackedDockerResources(bed.runner, ledger);

    assert.equal(failures.length, 1);
    assert.match(failures[0], /captured id disappeared.*was replaced/);
    assert.deepEqual(bed.removals, []);
    assert.equal(bed.byRef.get(name), replacement);
    assert.equal(ledger.length, 1);
  });

  test(`${script} deletes its owner-marked sensitive temp root on normal and exceptional paths`, () => {
    const normal = verifier.createOwnedTempRoot('normal-test');
    writeFileSync(join(normal.root, 'private-key.pem'), 'sensitive test material', { mode: 0o600 });
    verifier.cleanupOwnedTempRoot(normal);
    assert.equal(existsSync(normal.root), false);

    const exceptional = verifier.createOwnedTempRoot('exception-test');
    writeFileSync(join(exceptional.root, 'edge.db'), 'sensitive test material', { mode: 0o600 });
    try {
      throw new Error('simulated verifier failure');
    } catch {
      verifier.cleanupOwnedTempRoot(exceptional);
    }
    assert.equal(existsSync(exceptional.root), false);
  });

  test(`${script} rejects a temp-root purpose that can introduce a path segment`, () => {
    assert.throws(
      () => verifier.createOwnedTempRoot('../escape'),
      /invalid verifier temp purpose/,
    );
  });

  test(`${script} preserves a temp root whose owner marker was replaced`, () => {
    const owner = verifier.createOwnedTempRoot('tamper-test');
    writeFileSync(owner.marker, 'foreign-owner');
    assert.throws(() => verifier.cleanupOwnedTempRoot(owner), /unowned temp root/);
    assert.equal(existsSync(owner.root), true);

    // Restore the exact marker only to avoid leaking this test's own fixture.
    writeFileSync(owner.marker, owner.payload);
    verifier.cleanupOwnedTempRoot(owner);
    assert.equal(existsSync(owner.root), false);
  });
}

const gateway = verifierModules.find(([script]) => script === 'verify-cloud-gateway.mjs')[1];

test('gateway stops before subscribe when the spy did not reconnect', async () => {
  let subscriptions = 0;
  const spy = {
    connected: false,
    async subscribeAsync() { subscriptions += 1; },
  };

  await assert.rejects(
    gateway.requireSpyReconnect(spy, '/topic/#', {
      waitForConnection: async () => false,
      subscribeTimeoutMs: 10,
    }),
    /spy.*未重连/,
  );
  assert.equal(subscriptions, 0);
});

test('gateway bounds subscribeAsync and clears its timeout after either outcome', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    gateway.requireSpyReconnect({
      connected: true,
      subscribeAsync: async () => never,
    }, '/topic/#', {
      waitForConnection: async () => true,
      subscribeTimeoutMs: 5,
    }),
    /subscribe.*超时/,
  );

  let cleared = 0;
  await gateway.requireSpyReconnect({
    connected: true,
    subscribeAsync: async () => ({ granted: true }),
  }, '/topic/#', {
    waitForConnection: async () => true,
    subscribeTimeoutMs: 50,
    clearTimer: (timer) => { cleared += 1; clearTimeout(timer); },
  });
  assert.equal(cleared, 1);
});

test('gateway broker port is random per run but remains explicit across restart', () => {
  const source = readFileSync(join(SCRIPT_ROOT, 'verify-cloud-gateway.mjs'), 'utf8');
  assert.match(source, /const brokerPort = await allocatePort\(\)/);
  assert.match(source, /startBroker\(brokerDir, brokerPort\)/);
  assert.match(source, /`127\.0\.0\.1:\$\{hostPort\}:1883`/);
  assert.doesNotMatch(source, /127\.0\.0\.1::1883/);
});

test('cloud-link broker port is random per run but remains explicit across stop/start', () => {
  const source = readFileSync(join(SCRIPT_ROOT, 'verify-cloud-link.mjs'), 'utf8');
  assert.match(source, /const brokerPort = await allocatePort\(\)/);
  assert.match(source, /startBroker\(brokerDir, brokerPort\)/);
  assert.match(source, /`127\.0\.0\.1:\$\{hostPort\}:1883`/);
  assert.doesNotMatch(source, /127\.0\.0\.1::1883/);
});
