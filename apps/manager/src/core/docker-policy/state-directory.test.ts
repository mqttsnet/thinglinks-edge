import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializePolicyStateDirectory } from './state-directory.ts';
import { NetworkIntentStore } from './network-intents.ts';

test('a fresh named-volume style root is initialized without changing parent permissions', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tle-policy-state-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); chmodSync(root, 0o755);
  const config = { stateRoot: root, dataRoot: '/managed/instances', networkPrefix: 'tle-net' };
  initializePolicyStateDirectory(config);
  new NetworkIntentStore(join(root, 'network-intents'));
  assert.equal(statSync(root).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'network-intents')).mode & 0o777, 0o700);
  initializePolicyStateDirectory(config);
  assert.throws(() => initializePolicyStateDirectory({ ...config, dataRoot: '/other/instances' }));
});

test('an unmarked nonempty or corrupted state volume is not silently adopted', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tle-policy-state-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { stateRoot: root, dataRoot: '/managed/instances', networkPrefix: 'tle-net' };
  const foreign = join(root, 'foreign-data'); writeFileSync(foreign, 'must stay');
  assert.throws(() => initializePolicyStateDirectory(config));
  assert.equal(readFileSync(foreign, 'utf8') === 'must stay', true);
});
