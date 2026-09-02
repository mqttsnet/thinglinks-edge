import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKPOINT_FILE_PATHS,
  MigrationCheckpointError,
  MigrationCheckpointStore,
  type MigrationCheckpointManifest,
} from './migration-checkpoint.ts';

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tle-migration-checkpoint-'));
  roots.push(root);
  const live = join(root, 'line-a');
  mkdirSync(live, { recursive: true, mode: 0o770 });
  const contents = new Map<string, Buffer>();
  for (const [index, path] of CHECKPOINT_FILE_PATHS.entries()) {
    if (path.endsWith('.backup') && index % 4 === 1) continue;
    const bytes = Buffer.from(`${path}:opaque-${index}`);
    const target = join(live, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, bytes, { mode: index % 2 === 0 ? 0o600 : 0o640 });
    chmodSync(target, index % 2 === 0 ? 0o600 : 0o640);
    contents.set(path, bytes);
  }
  return { root, live, contents, store: new MigrationCheckpointStore(root) };
}

function manifest(root: string): MigrationCheckpointManifest {
  return JSON.parse(readFileSync(
    join(root, '.thinglinks-migration', 'line-a', 'tx-01', 'manifest.json'),
    'utf8',
  )) as MigrationCheckpointManifest;
}

test('checkpoint is atomically published outside the live bind with restrictive metadata-only evidence', async () => {
  const f = fixture();
  const ready = await f.store.create('line-a', 'tx-01');

  assert.equal(ready, join(f.root, '.thinglinks-migration', 'line-a', 'tx-01'));
  assert.equal(ready.startsWith(`${f.live}/`), false);
  assert.equal(statSync(ready).mode & 0o777, 0o700);
  assert.equal(existsSync(`${ready}.partial`), false);

  const saved = manifest(f.root);
  assert.deepEqual(saved.files.map((entry) => entry.path), [...CHECKPOINT_FILE_PATHS]);
  for (const entry of saved.files) {
    const source = f.contents.get(entry.path);
    if (!source) {
      assert.deepEqual(entry, { path: entry.path, exists: false });
      continue;
    }
    assert.equal(entry.exists, true);
    if (!entry.exists) continue;
    assert.equal(entry.size, source.length);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.mode, statSync(join(f.live, entry.path)).mode & 0o777);
    assert.equal(
      statSync(join(ready, 'files', entry.path)).mode & 0o777,
      entry.mode,
    );
  }
  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /opaque-|password|token|credential bytes/i);
});

test('preparing recovery removes only the tx partial and traversal is rejected', async () => {
  const f = fixture();
  const partial = join(f.root, '.thinglinks-migration', 'line-a', 'tx-01.partial');
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  writeFileSync(join(partial, 'untrusted-secret'), 'must-not-escape');
  const liveBefore = readFileSync(join(f.live, 'settings.js'));

  await f.store.cleanupPartial('line-a', 'tx-01');
  assert.equal(existsSync(partial), false);
  assert.deepEqual(readFileSync(join(f.live, 'settings.js')), liveBefore);
  await assert.rejects(
    () => f.store.create('line-a', '../escape'),
    (error: unknown) => error instanceof MigrationCheckpointError,
  );
  await assert.rejects(
    () => f.store.cleanupPartial('../escape', 'tx-01'),
    (error: unknown) => error instanceof MigrationCheckpointError,
  );
});

test('restore validates trusted checkpoint bytes and restores exact existence, mode, and hash', async () => {
  const f = fixture();
  await f.store.create('line-a', 'tx-01');
  const originallyMissing = CHECKPOINT_FILE_PATHS.find((path, index) => (
    path.endsWith('.backup') && index % 4 === 1
  ));
  assert.ok(originallyMissing);
  writeFileSync(join(f.live, 'settings.js'), 'changed', { mode: 0o666 });
  writeFileSync(join(f.live, originallyMissing), 'created-after-checkpoint');

  await f.store.restore('line-a', 'tx-01');
  assert.deepEqual(readFileSync(join(f.live, 'settings.js')), f.contents.get('settings.js'));
  assert.equal(statSync(join(f.live, 'settings.js')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.live, originallyMissing)), false);
  await f.store.verifyLive('line-a', 'tx-01');

  writeFileSync(
    join(f.root, '.thinglinks-migration', 'line-a', 'tx-01', 'files', 'settings.js'),
    'tampered',
  );
  await assert.rejects(
    () => f.store.restore('line-a', 'tx-01'),
    /settings\.js.*hash/i,
  );
});

test('only clean terminal phases remove and verify the ready checkpoint', async () => {
  for (const phase of ['committed', 'rolled_back'] as const) {
    const f = fixture();
    await f.store.create('line-a', 'tx-01');
    assert.equal(await f.store.cleanupTerminal('line-a', 'tx-01', phase), true);
    assert.equal(await f.store.readyExists('line-a', 'tx-01'), false);
  }
  for (const phase of ['pending_start_verification', 'rolled_back_dirty', 'manual_required'] as const) {
    const f = fixture();
    await f.store.create('line-a', 'tx-01');
    assert.equal(await f.store.cleanupTerminal('line-a', 'tx-01', phase), false);
    assert.equal(await f.store.readyExists('line-a', 'tx-01'), true);
  }
});

test('checkpoint rejects symlinked Manager root, live root, files root, and manifest', async () => {
  {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'tle-migration-checkpoint-outside-'));
    roots.push(outside);
    symlinkSync(outside, join(f.root, '.thinglinks-migration'), 'dir');
    await assert.rejects(() => f.store.create('line-a', 'tx-01'), /symlink|trusted|root/i);
    assert.deepEqual(readdirSync(outside), []);
  }
  {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'tle-migration-live-outside-'));
    roots.push(outside);
    rmSync(f.live, { recursive: true });
    symlinkSync(outside, f.live, 'dir');
    await assert.rejects(() => f.store.create('line-a', 'tx-01'), /symlink|trusted|live/i);
  }
  {
    const f = fixture();
    const ready = await f.store.create('line-a', 'tx-01');
    const outside = mkdtempSync(join(tmpdir(), 'tle-migration-files-outside-'));
    roots.push(outside);
    rmSync(join(ready, 'files'), { recursive: true });
    symlinkSync(outside, join(ready, 'files'), 'dir');
    await assert.rejects(() => f.store.verify('line-a', 'tx-01'), /files root.*trusted|symlink/i);
  }
  {
    const f = fixture();
    const ready = await f.store.create('line-a', 'tx-01');
    const outside = mkdtempSync(join(tmpdir(), 'tle-migration-manifest-outside-'));
    roots.push(outside);
    const externalManifest = join(outside, 'manifest.json');
    writeFileSync(externalManifest, readFileSync(join(ready, 'manifest.json')));
    rmSync(join(ready, 'manifest.json'));
    symlinkSync(externalManifest, join(ready, 'manifest.json'));
    await assert.rejects(() => f.store.verify('line-a', 'tx-01'), /manifest.*trusted|symlink/i);
  }
});
