import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, chmodSync, linkSync, symlinkSync, renameSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NetworkIntentStore, NETWORK_POLICY_OP_LABEL, NETWORK_POLICY_REALM_LABEL } from './network-intents.ts';

const opId = '1'.repeat(32);
const networkId = 'a'.repeat(64);
const intent = (id = opId, name = 'edge-line-a') => ({
  opId: id, kind: 'create' as const, name,
  labels: { 'com.mqttsnet.thinglinks-edge.managed': 'true', 'com.mqttsnet.thinglinks-edge.instance': 'line-a', [NETWORK_POLICY_OP_LABEL]: id,
    [NETWORK_POLICY_REALM_LABEL]: '3'.repeat(64) },
});
function fixture(t: { after(fn: () => void): void }) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'tle-network-intents-')));
  const root = join(parent, 'private-state');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

test('durable create intent survives reopen, records immutable network ID and commits only its own record', t => {
  const { root } = fixture(t);
  const store = new NetworkIntentStore(root);
  store.begin(intent());
  assert.deepEqual(new NetworkIntentStore(root).pending(), [intent()]);
  store.recordCreated(opId, networkId);
  assert.deepEqual(new NetworkIntentStore(root).pending(), [{ ...intent(), networkId }]);
  store.begin(intent('2'.repeat(32), 'edge-line-b'));
  store.commit(opId);
  store.commit(opId);
  assert.deepEqual(new NetworkIntentStore(root).pending(), [intent('2'.repeat(32), 'edge-line-b')]);
});

test('duplicate nonces, unfinished network names and replacement network IDs are rejected', t => {
  const { root } = fixture(t); const store = new NetworkIntentStore(root);
  store.begin(intent());
  assert.throws(() => store.begin(intent()), /already|duplicate/i);
  assert.throws(() => store.begin(intent('2'.repeat(32))), /already|duplicate/i);
  store.recordCreated(opId, networkId);
  assert.deepEqual(store.recordCreated(opId, networkId), { ...intent(), networkId });
  assert.throws(() => store.recordCreated(opId, 'b'.repeat(64)), /immutable|different/i);
  assert.equal(store.pending()[0]?.networkId, networkId);
});

test('delete intents require known IDs and may retain the original create nonce in owner labels', t => {
  const { root } = fixture(t); const store = new NetworkIntentStore(root);
  const deletion = { ...intent('2'.repeat(32)), kind: 'delete' as const, networkId, labels: intent().labels };
  assert.throws(() => store.begin({ ...deletion, networkId: undefined } as never), /network ID/i);
  store.begin(deletion);
  assert.deepEqual(new NetworkIntentStore(root).pending(), [deletion]);
});

test('create requires a valid deployment realm while delete may retain legacy labels', t => {
  const { root } = fixture(t); const store = new NetworkIntentStore(root);
  const labels: Record<string, string> = { ...intent().labels };
  delete labels[NETWORK_POLICY_REALM_LABEL];
  assert.throws(() => store.begin({ ...intent(), labels }), /realm/i);
  assert.throws(() => store.begin({ ...intent(), labels: { ...labels, [NETWORK_POLICY_REALM_LABEL]: 'not-a-realm' } }), /realm/i);
  const deletion = { ...intent(), kind: 'delete' as const, labels, networkId };
  store.begin(deletion);
  assert.deepEqual(store.pending(), [deletion]);
});

test('unknown fields and secret-bearing or mismatched owner labels never enter state', t => {
  const { root } = fixture(t); const store = new NetworkIntentStore(root);
  for (const invalid of [
    { ...intent(), Env: ['PASSWORD=must-not-persist'] },
    { ...intent(), labels: { ...intent().labels, password: 'must-not-persist' } },
    { ...intent(), labels: { ...intent().labels, [NETWORK_POLICY_OP_LABEL]: '2'.repeat(32) } },
    { ...intent(), opId: '../escape' },
    { ...intent(), name: '/foreign/network' },
    { ...intent(), networkId: 'short-id' },
  ]) assert.throws(() => store.begin(invalid as never));
  assert.deepEqual(readdirSync(root), []);
});

test('published corruption, unknown envelope fields and hard links fail closed', t => {
  const { root, parent } = fixture(t); const store = new NetworkIntentStore(root);
  store.begin(intent());
  const path = join(root, `${opId}.json`);
  const original = readFileSync(path);
  writeFileSync(path, '{truncated-json', { mode: 0o600 });
  assert.throws(() => store.pending(), /corrupt/i);
  writeFileSync(path, original);
  const disk = JSON.parse(original.toString());
  writeFileSync(path, JSON.stringify({ ...disk, extra: true }), { mode: 0o600 });
  assert.throws(() => new NetworkIntentStore(root).pending(), /invalid|corrupt|unknown/i);
  writeFileSync(path, original);
  const changed = JSON.parse(original.toString()); changed.intent.name = 'edge-changed';
  writeFileSync(path, JSON.stringify(changed));
  assert.throws(() => store.pending(), /integrity|checksum|corrupt/i);
  writeFileSync(path, original);
  linkSync(path, join(parent, 'outside-hardlink'));
  assert.throws(() => store.pending(), /file|link/i);
});

test('symlinked files, nonprivate roots and replaced root directories are refused', t => {
  const { root, parent } = fixture(t);
  mkdirSync(root, { mode: 0o755 });
  assert.throws(() => new NetworkIntentStore(root), /private|permission/i);
  chmodSync(root, 0o700);
  const store = new NetworkIntentStore(root);
  writeFileSync(join(parent, 'outside'), '{}', { mode: 0o600 });
  symlinkSync(join(parent, 'outside'), join(root, `${opId}.json`));
  assert.throws(() => store.pending(), /file|link/i);
  rmSync(join(root, `${opId}.json`));
  renameSync(root, `${root}-old`);
  mkdirSync(root, { mode: 0o700 });
  assert.throws(() => store.begin(intent()), /directory|changed/i);
  rmdirSync(root); symlinkSync(`${root}-old`, root);
  assert.throws(() => new NetworkIntentStore(root), /directory|canonical|link/i);
});

test('size and entry caps reject before overwriting an existing intent', t => {
  const { root } = fixture(t); const store = new NetworkIntentStore(root, { maxEntries: 1 });
  store.begin(intent());
  assert.throws(() => store.begin(intent('2'.repeat(32), 'edge-line-b')), /capacity|limit/i);
  assert.throws(() => new NetworkIntentStore(root, { maxFileBytes: 128 }).pending(), /size|limit/i);
  assert.deepEqual(store.pending(), [intent()]);
});

test('write failures before publication preserve prior state; failures after publication remain recoverable', t => {
  const { root } = fixture(t);
  let interrupt = '';
  const store = new NetworkIntentStore(root, { onWriteStep: step => { if (step === interrupt) throw new Error('fixture interruption'); } });
  store.begin(intent());
  interrupt = 'before-publish';
  assert.throws(() => store.recordCreated(opId, networkId), /fixture interruption/);
  assert.deepEqual(new NetworkIntentStore(root).pending(), [intent()]);
  interrupt = 'after-publish';
  assert.throws(() => store.recordCreated(opId, networkId), /fixture interruption/);
  assert.deepEqual(new NetworkIntentStore(root).pending(), [{ ...intent(), networkId }]);
});

test('process interruption leaves an unpublished temporary file without losing the prior recovery intent', t => {
  const { root } = fixture(t); new NetworkIntentStore(root).begin(intent());
  const moduleUrl = new URL('./network-intents.ts', import.meta.url).href;
  const script = `import {NetworkIntentStore} from ${JSON.stringify(moduleUrl)};
    const store=new NetworkIntentStore(process.argv[1],{onWriteStep:step=>{if(step==='before-publish')process.exit(73);}});
    store.recordCreated(${JSON.stringify(opId)},${JSON.stringify(networkId)});`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, root], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  assert.ok(readdirSync(root).some(name => name.endsWith('.tmp')));
  assert.deepEqual(new NetworkIntentStore(root).pending(), [intent()]);
});
