import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { lockedProtocolPackages, verifyPackageArchives } from './prepare-protocol-seed.mjs';

const run = promisify(execFile);
test('mixed offline seeds still verify every protocol archive without rejecting unrelated seeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tle-protocol-mixed-test-'));
  const body = Buffer.from('locked protocol archive');
  const packages = [{ file: 'driver-1.0.0.tgz', integrity: `sha512-${createHash('sha512').update(body).digest('base64')}` }];
  try {
    await writeFile(join(root, packages[0].file), body);
    await writeFile(join(root, 'platform-node-1.0.0.tgz'), 'independent platform seed');
    await assert.rejects(verifyPackageArchives(root, packages), /Unexpected/);
    assert.equal(await verifyPackageArchives(root, packages, { allowAdditionalArchives: true }), body.length);
    await writeFile(join(root, packages[0].file), 'tampered');
    await assert.rejects(verifyPackageArchives(root, packages, { allowAdditionalArchives: true }), /integrity/);
    await rm(join(root, packages[0].file));
    await assert.rejects(verifyPackageArchives(root, packages, { allowAdditionalArchives: true }), /ENOENT/);
    assert.equal((await readFile(join(root, 'platform-node-1.0.0.tgz'))).toString(), 'independent platform seed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('protocol lock roots and integrity cannot drift from catalogue pins', async () => {
  const lock = JSON.parse(await readFile('scripts/protocol-seed/package-lock.json','utf8'));
  const packages = lockedProtocolPackages(lock);
  assert.ok(packages.length > 300);
  assert.ok(packages.some((p) => p.module === 'serialport'));
  lock.packages['node_modules/node-red-contrib-modbus'].integrity = 'sha512-modified';
  assert.throws(() => lockedProtocolPackages(lock), /pin|integrity/);
});
test('fixed lock seed downloads complete closure without npm resolution and rejects tampered bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tle-protocol-lock-test-'));
  let body = Buffer.from('original archive fixture');
  const digest = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const server = createServer((_req, res) => res.end(body));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const lock = join(root, 'package-lock.json');
  const out = join(root, 'seed');
  await writeFile(lock, JSON.stringify({packages: {
    '': {name:'fixture',dependencies:{'fixture-node':'1.0.0'}},
    'node_modules/fixture-node': {version:'1.0.0',resolved:`http://127.0.0.1:${port}/node.tgz`,integrity:digest},
    'node_modules/fixture-node/node_modules/optional-native': {version:'2.0.0',optional:true,resolved:`http://127.0.0.1:${port}/optional.tgz`,integrity:digest},
  }}));
  try {
    await run('bash', [resolve('scripts/pack-nodes.sh'),'--lock-file',lock,'--out',out]);
    assert.deepEqual((await readdir(out)).sort(), ['fixture-node-1.0.0.tgz','optional-native-2.0.0.tgz']);
    body = Buffer.from('tampered');
    await run('bash', [resolve('scripts/pack-nodes.sh'),'--lock-file',lock,'--download-cache',out,'--out',join(root,'from-cache')]);
    assert.equal((await readFile(join(root,'from-cache/fixture-node-1.0.0.tgz'))).toString(), 'original archive fixture');
    await assert.rejects(run('bash', [resolve('scripts/pack-nodes.sh'),'--lock-file',lock,'--out',out]));
    assert.equal((await readFile(join(out,'fixture-node-1.0.0.tgz'))).toString(), 'original archive fixture');
  } finally { server.close(); await rm(root,{recursive:true,force:true}); }
});
