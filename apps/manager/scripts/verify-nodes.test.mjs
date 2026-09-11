import assert from 'node:assert/strict';
import test from 'node:test';
import { verifierStoreMatches } from './verify-nodes.mjs';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from '../dist/core/nodes/platform-contract.js';

const importedBeforeBootstrap = [
  'node-red-contrib-tle-fixture-ok',
  'node-red-contrib-tle-fixture-denied',
  'node-red-contrib-tle-fixture-urldep',
  'tle-fixture-urldep-lib',
];
const allFixtures = [...importedBeforeBootstrap, 'node-red-contrib-tle-fixture-upstream'];
const roots = [PLATFORM_NODE_PACKAGE, PLATFORM_COMMON_PACKAGE];
const fixturePackages = (names) => names.map((name) => ({ name, version: '1.0.0' }));
const inventory = (packages) => ({
  modules: () => [...new Set(packages.map((pkg) => pkg.name))].sort(),
  versions: (module) => packages.filter((pkg) => pkg.name === module).map((pkg) => pkg.version).sort(),
});

test('bootstrap failure checks the four imported fixtures without requiring a future upstream download', () => {
  const store = inventory([...roots, ...fixturePackages(importedBeforeBootstrap)]);
  assert.equal(verifierStoreMatches(store, importedBeforeBootstrap), true);
  // A complete run must still contain the later downloaded package.
  assert.equal(verifierStoreMatches(store), false);
});

test('before fixture import only the two exact platform roots are expected', () => {
  assert.equal(verifierStoreMatches(inventory(roots), []), true);
});

test('a complete run requires all five fixture names and their exact versions', () => {
  assert.equal(verifierStoreMatches(inventory([...roots, ...fixturePackages(allFixtures)])), true);
  const changed = fixturePackages(allFixtures);
  changed[0].version = '2.0.0';
  assert.equal(verifierStoreMatches(inventory([...roots, ...changed])), false);
});

test('missing an already imported fixture fails the inventory check', () => {
  const store = inventory([...roots, ...fixturePackages(importedBeforeBootstrap.slice(1))]);
  assert.equal(verifierStoreMatches(store, importedBeforeBootstrap), false);
});

test('unknown packages, future fixtures and additional versions never enter the expected inventory', () => {
  const before = [...roots, ...fixturePackages(importedBeforeBootstrap)];
  for (const extra of [
    { name: 'unknown-package', version: '1.0.0' },
    { name: 'node-red-contrib-tle-fixture-upstream', version: '1.0.0' },
    { name: importedBeforeBootstrap[0], version: '2.0.0' },
    { name: PLATFORM_NODE_PACKAGE.name, version: '99.0.0' },
  ]) assert.equal(verifierStoreMatches(inventory([...before, extra]), importedBeforeBootstrap), false);
});

test('an unknown name cannot be made trusted by adding it to the completed fixture list', () => {
  const names = [...allFixtures, 'unknown-package'];
  assert.throws(() => verifierStoreMatches(inventory([...roots, ...fixturePackages(names)]), names),
    /unknown verifier fixture/);
});
