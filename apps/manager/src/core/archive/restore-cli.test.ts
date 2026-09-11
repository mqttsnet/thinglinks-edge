import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../../index.ts', import.meta.url));

test('Manager refuses an interrupted restore before opening or creating its database', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tle-restore-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.restore-transaction'), { mode: 0o700 });
  const result = spawnSync(process.execPath, ['--experimental-strip-types', entrypoint], {
    env: { PATH: process.env['PATH'], EDGE_DATA_ROOT: root, EXTERNAL_URL: 'http://localhost:19100' },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restore --recover/);
  await assert.rejects(() => lstat(join(root, 'manager', 'edge.db')), { code: 'ENOENT' });
});

test('restore CLI rejects nonstandard data layout before reading the archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tle-restore-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', entrypoint, 'restore', join(root, 'missing.tle-backup'),
  ], {
    env: {
      PATH: process.env['PATH'], EDGE_DATA_ROOT: root,
      DATA_DIR: join(root, 'custom-manager'), EXTERNAL_URL: 'http://localhost:19100',
    },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATA_DIR.*INSTANCE_DATA_ROOT/);
  await assert.rejects(() => lstat(join(root, 'manager')), { code: 'ENOENT' });
});
