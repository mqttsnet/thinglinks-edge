import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { openDb } from '../db.ts';
import { createBackup, restoreBackup, keyFingerprint } from './backup.ts';
import { tarArchive, tarFile, untar, type TarEntry } from './tar.ts';

const key = Buffer.alloc(32, 7);
const instances = [{ id: 'line-a', name: 'A', imageTag: 'tag' }];
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tle-backup-links-'));
  const source = join(root, 'instances', 'line-a');
  await mkdir(source, { recursive: true });
  const db = openDb(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const backup = () => createBackup({ db, key, instances, instanceDataRoot: join(root, 'instances'), schemaVersion: 2 });
  return { root, source, backup, target: join(root, 'restored') };
}
function legacy(entries: TarEntry[], directories?: string[]) {
  return tarArchive([
    { name: 'manifest.json', content: JSON.stringify({ product: 'thinglinks-edge', format: 1,
      instances, schemaVersion: 2, masterKeyFingerprint: keyFingerprint(key), ...(directories ? { directories } : {}) }) },
    { name: 'manager/edge.db', content: 'db' }, ...entries,
  ], { allowSymlinks: true });
}

test('npm bin and pnpm dependency symlinks survive backup and execute from restored modules', async (t) => {
  const f = await fixture(t);
  const modules = join(f.source, 'node_modules');
  const demo = join(modules, '.pnpm', 'demo@1.0.0', 'node_modules', 'demo');
  const dep = join(modules, '.pnpm', 'dep@1.0.0', 'node_modules', 'dep');
  await mkdir(join(demo, 'bin'), { recursive: true });
  await mkdir(dep, { recursive: true });
  await mkdir(join(modules, '.bin'));
  await writeFile(join(dep, 'index.js'), 'module.exports="restored-link-ok";');
  await writeFile(join(demo, 'index.js'), 'module.exports=require("dep");');
  await writeFile(join(demo, 'bin', 'run.js'), '#!/usr/bin/env node\nprocess.stdout.write(require(".."));\n');
  await chmod(join(demo, 'bin', 'run.js'), 0o755);
  await symlink('../../dep@1.0.0/node_modules/dep', join(demo, '..', 'dep'));
  await symlink('.pnpm/demo@1.0.0/node_modules/demo', join(modules, 'demo'));
  await symlink('../demo/bin/run.js', join(modules, '.bin', 'demo'));
  await restoreBackup({ archive: await f.backup(), dataRoot: f.target, key });
  const restored = join(f.target, 'instances', 'line-a', 'node_modules');
  assert.equal(await readlink(join(restored, '.bin', 'demo')), '../demo/bin/run.js');
  assert.equal(await readlink(join(restored, 'demo')), '.pnpm/demo@1.0.0/node_modules/demo');
  assert.equal(execFileSync(join(restored, '.bin', 'demo'), { encoding: 'utf8' }), 'restored-link-ok');
  assert.equal((await lstat(join(restored, '.pnpm', 'demo@1.0.0', 'node_modules', 'demo', 'bin', 'run.js'))).mode & 0o777, 0o755);
});

test('internal links to empty directories are restored without dereferencing them', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'empty'));
  await symlink('empty', join(f.source, 'alias'));
  await restoreBackup({ archive: await f.backup(), dataRoot: f.target, key });
  assert.equal(await readlink(join(f.target, 'instances', 'line-a', 'alias')), 'empty');
  assert.equal((await lstat(join(f.target, 'instances', 'line-a', 'empty'))).isDirectory(), true);
});

for (const [label, target] of [['absolute', '/etc/passwd'], ['escape', '../line-b/secret'],
  ['dangling', 'missing'], ['self-cycle', 'link'], ['windows-absolute', 'C:/outside']] as const) {
  test(`backup rejects ${label} symlink`, async (t) => {
    const f = await fixture(t);
    await symlink(target, join(f.source, 'link'));
    await assert.rejects(f.backup);
  });
}

for (const [label, entries, directories] of [
  ['absolute', [{ name: 'instances/line-a/link', content: '', symlink: '/etc/passwd' }]],
  ['escape', [{ name: 'instances/line-a/link', content: '', symlink: '../line-b/file' }]],
  ['cycle', [{ name: 'instances/line-a/a', content: '', symlink: 'b' }, { name: 'instances/line-a/b', content: '', symlink: 'a' }]],
  ['file-through-link', [{ name: 'instances/line-a/link', content: '', symlink: 'dest' },
    { name: 'instances/line-a/link/file', content: 'never' }, { name: 'instances/line-a/dest/file', content: 'old' }]],
  ['directory-through-link', [{ name: 'instances/line-a/link', content: '', symlink: 'dest' },
    { name: 'instances/line-a/dest/file', content: 'old' }], ['instances/line-a/link/nested']],
  ['escape-after-link-expansion', [
    { name: 'instances/line-a/deep/back', content: '', symlink: '..' },
    { name: 'instances/line-a/alias', content: '', symlink: 'deep/back/../line-a/file' },
    { name: 'instances/line-a/file', content: 'old' }]],
  ['manager-link', [{ name: 'manager/edge.db', content: '', symlink: '../instances/line-a/file' }]],
] as Array<[string, TarEntry[], string[]?]>) {
  test(`restore rejects ${label} before staging`, async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.target, 'manager'), { recursive: true });
    await writeFile(join(f.target, 'manager', 'edge.db'), 'old-db');
    await assert.rejects(() => restoreBackup({ archive: legacy(entries, directories), dataRoot: f.target, key }));
    assert.equal(await readFile(join(f.target, 'manager', 'edge.db'), 'utf8'), 'old-db');
    await assert.rejects(() => lstat(join(f.target, '.restore-transaction')), { code: 'ENOENT' });
  });
}

test('ordinary backup reads use O_NOFOLLOW and reject a file replaced just before opening', async (t) => {
  const f = await fixture(t);
  const file = join(f.source, 'flows.json');
  await writeFile(file, 'original');
  const outside = join(f.root, 'outside');
  await writeFile(outside, 'external-secret');
  const originalOpen = fs.open;
  let invoked = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]) === file && !invoked) {
      invoked = true;
      assert.equal(typeof args[1], 'number');
      assert.ok((Number(args[1]) & constants.O_NOFOLLOW) !== 0);
      await rename(file, `${file}.old`);
      await symlink(outside, file);
    }
    return Reflect.apply(originalOpen, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.backup);
  assert.equal(invoked, true);
});

test('tar symlinks require opt-in and PAX retains long paths and targets', () => {
  const name = `instances/line-a/${'a'.repeat(110)}/${'b'.repeat(110)}/link`;
  const symlink = `../${'c'.repeat(130)}/target`;
  assert.throws(() => tarArchive([{ name, content: '', symlink }]));
  const archive = tarArchive([{ name, content: '', symlink }], { allowSymlinks: true });
  assert.throws(() => untar(archive), /PAX|链接|symlink/);
  const links = untar(archive, { allowSymlinks: true });
  assert.equal(links[0]?.name, name);
  assert.equal(links[0]?.symlink, symlink);
  assert.equal(links[0]?.content.length, 0);
});

test('backup rejects replacement of a file after reading its original descriptor', async (t) => {
  const f = await fixture(t);
  const file = join(f.source, 'flows.json');
  await writeFile(file, 'original');
  const originalOpen = fs.open;
  let swapped = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await Reflect.apply(originalOpen, fs, args);
    if (String(args[0]) === file) {
      const originalRead = handle.read;
      t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof originalRead>) => {
        const result = await Reflect.apply(originalRead, handle, readArgs);
        if (!swapped) {
          swapped = true;
          await rename(file, `${file}.previous`);
          await writeFile(file, 'replaced');
        }
        return result;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.backup, /发生变化/);
  assert.equal(swapped, true);
});

test('short links are never returned by the default parser and special tar records cannot become backups', () => {
  const archive = tarArchive([{ name: 'link', content: '', symlink: 'target' }], { allowSymlinks: true });
  assert.deepEqual(untar(archive), []);
  for (const type of ['1', '3', '4', '6']) {
    const changed = Buffer.from(archive);
    changed[156] = type.charCodeAt(0);
    changed.fill(0x20, 148, 156);
    const sum = [...changed.subarray(0, 512)].reduce((left, right) => left + right, 0);
    changed.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
    changed[154] = 0; changed[155] = 0x20;
    assert.throws(() => untar(changed, { allowSymlinks: true }), /不支持/);
  }
});

test('PAX links produced by backup are understood by the system tar tool', async (t) => {
  const f = await fixture(t);
  const name = `${'a'.repeat(120)}/${'b'.repeat(120)}/link`;
  const target = `../../${'c'.repeat(140)}`;
  const archive = join(f.root, 'links.tar');
  await writeFile(archive, tarArchive([{ name, content: '', symlink: target }], { allowSymlinks: true }));
  const destination = join(f.root, 'tar-out');
  await mkdir(destination);
  execFileSync('tar', ['-xf', archive, '-C', destination]);
  assert.equal(await readlink(join(destination, name)), target);
});

test('PAX linkpath cannot repeat or attach to an ordinary file', () => {
  const record = (value: string) => {
    const suffix = ` linkpath=${value}\n`;
    let length = Buffer.byteLength(suffix) + 1;
    while (Buffer.byteLength(`${length}${suffix}`) !== length) length = Buffer.byteLength(`${length}${suffix}`);
    return `${length}${suffix}`;
  };
  for (const content of [record('target'), record('first') + record('second')]) {
    const pax = tarFile('pax', content).subarray(0, 1024);
    pax[156] = 'x'.charCodeAt(0); pax.fill(0x20, 148, 156);
    const sum = [...pax.subarray(0, 512)].reduce((left, right) => left + right, 0);
    pax.write(sum.toString(8).padStart(6, '0'), 148, 'ascii'); pax[154] = 0; pax[155] = 0x20;
    assert.throws(() => untar(Buffer.concat([pax, tarFile('regular', 'content')]), { allowSymlinks: true }), /PAX/);
  }
});

test('failed restore cutover rolls back a staged tree containing internal links', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'target'), 'new-content');
  await symlink('target', join(f.source, 'alias'));
  const archive = await f.backup();
  await mkdir(join(f.target, 'manager'), { recursive: true });
  await mkdir(join(f.target, 'instances', 'line-a'), { recursive: true });
  await writeFile(join(f.target, 'manager', 'edge.db'), 'old-db');
  await writeFile(join(f.target, 'instances', 'line-a', 'old'), 'old-content');
  const instanceRoot = join(await fs.realpath(f.target), 'instances');
  const originalRename = fs.rename;
  let interrupted = false;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof originalRename>) => {
    await Reflect.apply(originalRename, fs, args);
    if (!interrupted && String(args[1]) === instanceRoot) {
      interrupted = true;
      throw new Error('injected cutover failure');
    }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(() => restoreBackup({ archive, dataRoot: f.target, key }), /injected/);
  assert.equal(interrupted, true);
  assert.equal(await readFile(join(f.target, 'instances', 'line-a', 'old'), 'utf8'), 'old-content');
  assert.equal(await readFile(join(f.target, 'manager', 'edge.db'), 'utf8'), 'old-db');
  await assert.rejects(() => lstat(join(f.target, 'instances', 'line-a', 'alias')), { code: 'ENOENT' });
});
