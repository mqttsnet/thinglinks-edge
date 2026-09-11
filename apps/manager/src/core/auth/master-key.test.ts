import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMasterKey } from './master-key.ts';

const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex');

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'tle-master-key-'));
  const file = join(root, '.master.key');
  const dataDir = join(root, 'manager');
  const instanceDataRoot = join(root, 'instances');
  mkdirSync(dataDir);
  mkdirSync(instanceDataRoot);
  const env = { NODE_ENV: 'production', MASTER_KEY_FILE: file };
  const initialize = { databasePath: join(dataDir, 'edge.db'), instanceDataRoot };
  return { root, file, env, initialize, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('首次启动生成独立密钥文件，重启与恢复命令复用同一密钥', () => {
  const bed = fixture();
  try {
    const first = loadMasterKey(bed.env, bed.initialize);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(statSync(bed.file).mode & 0o777, 0o600);
    writeFileSync(bed.initialize.databasePath, 'existing database');
    assert.equal(fingerprint(loadMasterKey(bed.env, bed.initialize)), fingerprint(first));
    assert.equal(fingerprint(loadMasterKey(bed.env)), fingerprint(first));
    assert.deepEqual(readdirSync(bed.root).sort(), ['.master.key', 'instances', 'manager']);
  } finally { bed.cleanup(); }
});

test('密钥文件丢失且数据库或实例数据已存在时拒绝生成替代密钥', () => {
  for (const state of ['database', 'instance']) {
    const bed = fixture();
    try {
      if (state === 'database') writeFileSync(bed.initialize.databasePath, 'existing database');
      else mkdirSync(join(bed.initialize.instanceDataRoot, 'existing-instance'));
      assert.throws(() => loadMasterKey(bed.env, bed.initialize), /已有数据.*密钥/);
      assert.equal(existsSync(bed.file), false);
    } finally { bed.cleanup(); }
  }
});

test('已有环境密钥可接入文件模式且加密身份不变，冲突密钥拒绝覆盖', () => {
  const bed = fixture();
  try {
    writeFileSync(bed.initialize.databasePath, 'existing database');
    const env = { ...bed.env, MASTER_KEY: 'legacy-fixture-key' };
    assert.equal(fingerprint(loadMasterKey(env, bed.initialize)), fingerprint(env.MASTER_KEY));
    assert.equal(fingerprint(loadMasterKey(bed.env)), fingerprint(env.MASTER_KEY));
    const before = readFileSync(bed.file);
    assert.throws(() => loadMasterKey({ ...env, MASTER_KEY: 'different-fixture-key' }, bed.initialize), /不一致/);
    assert.deepEqual(readFileSync(bed.file), before);
  } finally { bed.cleanup(); }
});

test('未启用文件模式时保留既有环境变量契约，读取命令不会自动创建密钥', () => {
  const bed = fixture();
  try {
    assert.equal(loadMasterKey({ MASTER_KEY: 'legacy-fixture-key' }), 'legacy-fixture-key');
    assert.throws(() => loadMasterKey({ NODE_ENV: 'production' }), /拒绝启动/);
    assert.throws(() => loadMasterKey(bed.env), /密钥文件.*不存在/);
    assert.equal(existsSync(bed.file), false);
  } finally { bed.cleanup(); }
});

test('拒绝空文件、权限过宽和符号链接，不修改原文件', () => {
  for (const kind of ['empty', 'permissions', 'symlink', 'parent-symlink']) {
    const bed = fixture();
    try {
      let env = bed.env;
      if (kind === 'empty') writeFileSync(bed.file, '', { mode: 0o600 });
      if (kind === 'permissions') writeFileSync(bed.file, 'fixture-key', { mode: 0o644 });
      if (kind === 'symlink') {
        const target = join(bed.root, 'target');
        writeFileSync(target, 'fixture-key', { mode: 0o600 });
        symlinkSync(target, bed.file);
      }
      if (kind === 'parent-symlink') {
        symlinkSync(join(bed.root, 'manager'), join(bed.root, 'alias'));
        env = { ...env, MASTER_KEY_FILE: join(bed.root, 'alias', '.master.key') };
      }
      assert.throws(() => loadMasterKey(env, bed.initialize), /密钥/);
      if (kind === 'symlink') assert.equal(readFileSync(join(bed.root, 'target'), 'utf8'), 'fixture-key');
      if (kind === 'permissions') assert.equal(statSync(bed.file).mode & 0o777, 0o644);
      if (kind === 'parent-symlink') assert.equal(existsSync(env.MASTER_KEY_FILE), false);
    } finally { bed.cleanup(); }
  }
});

test('相对路径或实例目录内的密钥文件不会被自动初始化', () => {
  const bed = fixture();
  try {
    assert.throws(() => loadMasterKey({ ...bed.env, MASTER_KEY_FILE: 'relative.key' }, bed.initialize), /绝对路径/);
    assert.throws(() => loadMasterKey({ ...bed.env, MASTER_KEY_FILE: join(bed.initialize.instanceDataRoot, '.master.key') }, bed.initialize), /数据目录/);
    assert.throws(() => loadMasterKey({ ...bed.env, MASTER_KEY_FILE: join(bed.root, 'manager', '.master.key') }, bed.initialize), /数据目录/);
  } finally { bed.cleanup(); }
});

test('并发首次初始化只能发布同一个完整密钥', async () => {
  const bed = fixture();
  try {
    chmodSync(bed.root, 0o700);
    const moduleUrl = new URL('./master-key.ts', import.meta.url).href;
    const source = `import {loadMasterKey} from ${JSON.stringify(moduleUrl)};
      import {createHash} from 'node:crypto';
      const key=loadMasterKey(${JSON.stringify(bed.env)},${JSON.stringify(bed.initialize)});
      process.stdout.write(createHash('sha256').update(key).digest('hex'));`;
    const values = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source]);
      let output = ''; let error = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error)));
    })));
    assert.equal(new Set(values).size, 1);
    assert.equal(values[0], fingerprint(loadMasterKey(bed.env)));
    assert.deepEqual(readdirSync(bed.root).sort(), ['.master.key', 'instances', 'manager']);
  } finally { bed.cleanup(); }
});

test('并发读者在发布者 link 后尚未同步目录时补齐持久化屏障', () => {
  const bed = fixture();
  try {
    const source = `import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import {syncBuiltinESMExports} from 'node:module';
      import {loadMasterKey} from ${JSON.stringify(new URL('./master-key.ts', import.meta.url).href)};
      const root=${JSON.stringify(bed.root)};
      const temporary=root+'/.publisher.tmp';
      const fd=fs.openSync(temporary,'wx',384);
      fs.writeFileSync(fd,'concurrent-fixture-key');fs.fsyncSync(fd);fs.closeSync(fd);
      fs.linkSync(temporary,${JSON.stringify(bed.file)});
      // Publisher is paused immediately after linking, before directory fsync.
      let directoryFlushed=false;
      const original=fs.fsyncSync;
      fs.fsyncSync=(fd)=>{
        const stat=fs.fstatSync(fd), parent=fs.statSync(root);
        original(fd);
        if(stat.isDirectory() && stat.dev===parent.dev && stat.ino===parent.ino) directoryFlushed=true;
      };
      syncBuiltinESMExports();
      loadMasterKey(${JSON.stringify(bed.env)},${JSON.stringify(bed.initialize)});
      assert.equal(directoryFlushed,true,'reader must persist the key directory before creating a database');`;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { bed.cleanup(); }
});
