import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const scripts = [
  'verify-isolation.mjs',
  'verify-instance.mjs',
  'verify-container-guard.mjs',
];

const verifierModules = await Promise.all(scripts.map(async (script) => [
  script,
  await import(`./${script}`),
]));

const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

function fakeDocker(kind, initial = []) {
  const byRef = new Map();
  const removals = [];
  const put = (info) => {
    const name = kind === 'container' ? info.Name.replace(/^\//, '') : info.Name;
    byRef.set(info.Id, info);
    byRef.set(name, info);
  };
  const drop = (info) => {
    const name = kind === 'container' ? info.Name.replace(/^\//, '') : info.Name;
    byRef.delete(info.Id);
    byRef.delete(name);
  };
  for (const info of initial) put(info);
  const get = (ref) => ({
    async inspect() {
      const info = byRef.get(ref);
      if (!info) throw notFound();
      return info;
    },
    async remove(options) {
      const info = byRef.get(ref);
      if (!info) throw notFound();
      removals.push({ ref, options });
      drop(info);
    },
  });
  return {
    docker: {
      getContainer: kind === 'container' ? get : () => { throw new Error('wrong kind'); },
      getNetwork: kind === 'network' ? get : () => { throw new Error('wrong kind'); },
    },
    byRef,
    put,
    drop,
    removals,
  };
}

function resourceInfo(kind, id, name, labels) {
  return kind === 'container'
    ? { Id: id, Name: `/${name}`, Config: { Labels: labels } }
    : { Id: id, Name: name, Labels: labels };
}

for (const script of scripts) {
  test(`${script} uses invocation-scoped identities and exact ownership labels`, () => {
    const source = readFileSync(join(SCRIPT_ROOT, script), 'utf8');

    assert.match(source, /createFixtureIdentity/);
    assert.match(source, /exactResourceLabels/);
    assert.match(source, /captureCreatedDockerResource/);
    assert.match(source, /cleanupTrackedDockerResources/);
    assert.match(source, /VERIFIER_INVOCATION_LABEL/);
    assert.doesNotMatch(source, /listNetworks\([\s\S]{0,180}managed=true/);
    assert.doesNotMatch(source, /['"](?:iso-a|iso-b|verify-a|guard-test|tle-iso-net|tle-verify-net)['"]/);
    assert.doesNotMatch(source, /line-1/);
  });

  test(`${script} refuses a pre-existing Docker name instead of deleting it`, () => {
    const source = readFileSync(join(SCRIPT_ROOT, script), 'utf8');

    assert.match(source, /requireDockerNameAbsent/);
    assert.doesNotMatch(source, /getContainer\([^\n]+\)\.remove\(\{ force: true \}\)\.catch/);
    assert.doesNotMatch(source, /getNetwork\([^\n]+\)\.remove\(\)\.catch/);
  });
}

for (const [script, verifier] of verifierModules) {
  test(`${script} rejects an occupied name without a destructive call`, async () => {
    const labels = { owner: 'foreign' };
    const info = resourceInfo('container', 'foreign-id', 'occupied-name', labels);
    const bed = fakeDocker('container', [info]);

    await assert.rejects(
      verifier.requireDockerNameAbsent(bed.docker, 'container', 'occupied-name'),
      /already occupied/,
    );
    assert.deepEqual(bed.removals, []);
  });

  test(`${script} captures an immutable id and removes the exact owned resource by id`, async () => {
    const labels = {
      'com.mqttsnet.thinglinks-edge.verifier-run': 'run-1',
      'com.mqttsnet.thinglinks-edge.verifier-suite': 'suite-1',
      'com.mqttsnet.thinglinks-edge.verifier-invocation': '012345abcdef',
    };
    const info = resourceInfo('container', 'owned-id', 'owned-name', labels);
    const bed = fakeDocker('container', [info]);
    const ledger = [];

    await verifier.captureCreatedDockerResource(bed.docker, ledger, {
      kind: 'container', name: 'owned-name', labels, created: { id: 'owned-id' },
    });
    assert.equal(ledger[0].id, 'owned-id');
    assert.deepEqual(await verifier.cleanupTrackedDockerResources(bed.docker, ledger), []);
    assert.deepEqual(bed.removals, [{ ref: 'owned-id', options: { force: true } }]);
    assert.deepEqual(ledger, []);
  });

  test(`${script} preserves a same-name replacement after the captured id disappears`, async () => {
    const labels = {
      'com.mqttsnet.thinglinks-edge.verifier-run': 'run-1',
      'com.mqttsnet.thinglinks-edge.verifier-suite': 'suite-1',
      'com.mqttsnet.thinglinks-edge.verifier-invocation': '012345abcdef',
    };
    const owned = resourceInfo('network', 'owned-network-id', 'owned-network', labels);
    const bed = fakeDocker('network', [owned]);
    const ledger = [];
    await verifier.captureCreatedDockerResource(bed.docker, ledger, {
      kind: 'network', name: 'owned-network', labels, created: { id: 'owned-network-id' },
    });

    bed.drop(owned);
    const replacement = resourceInfo('network', 'foreign-network-id', 'owned-network', {
      'com.mqttsnet.thinglinks-edge.verifier-run': 'someone-else',
    });
    bed.put(replacement);
    const failures = await verifier.cleanupTrackedDockerResources(bed.docker, ledger);

    assert.equal(failures.length, 1);
    assert.match(failures[0], /disappeared but owned-network was replaced/);
    assert.deepEqual(bed.removals, []);
    assert.equal(bed.byRef.get('owned-network'), replacement);
    assert.equal(ledger.length, 1, 'failed ownership cleanup remains in the ledger');
  });
}
