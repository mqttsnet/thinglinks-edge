import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoRestoreTransaction, recoverRestoreTransaction, withRestoreTransaction,
} from './restore-transaction.ts';

const TX = '.restore-transaction';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-restore-tx-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'manager', 'spool'), { recursive: true });
  await mkdir(join(root, 'instances', 'old-only'), { recursive: true });
  await writeFile(join(root, 'manager', 'edge.db'), 'old-db');
  await writeFile(join(root, 'manager', 'edge.db-wal'), 'old-wal');
  await writeFile(join(root, 'manager', 'edge.db-shm'), 'old-shm');
  await writeFile(join(root, 'manager', 'spool', 'pending'), 'keep-spool');
  await writeFile(join(root, 'instances', 'old-only', 'flows.json'), 'old-flow');
  await writeFile(join(root, 'backup.tle-backup'), 'keep-backup');
  return root;
}

async function stage(root: string) {
  await mkdir(join(root, 'manager'), { recursive: true });
  await mkdir(join(root, 'instances', 'new-only'), { recursive: true });
  await writeFile(join(root, 'manager', 'edge.db'), 'new-db');
  await writeFile(join(root, 'instances', 'new-only', 'flows.json'), 'new-flow');
}

async function oldState(root: string) {
  assert.equal(await readFile(join(root, 'manager', 'edge.db'), 'utf8'), 'old-db');
  assert.equal(await readFile(join(root, 'manager', 'edge.db-wal'), 'utf8'), 'old-wal');
  assert.equal(await readFile(join(root, 'manager', 'edge.db-shm'), 'utf8'), 'old-shm');
  assert.equal(await readFile(join(root, 'instances', 'old-only', 'flows.json'), 'utf8'), 'old-flow');
  await assert.rejects(lstat(join(root, 'instances', 'new-only')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'manager', 'spool', 'pending'), 'utf8'), 'keep-spool');
  assert.equal(await readFile(join(root, 'backup.tle-backup'), 'utf8'), 'keep-backup');
}

async function newState(root: string) {
  assert.equal(await readFile(join(root, 'manager', 'edge.db'), 'utf8'), 'new-db');
  assert.equal(await readFile(join(root, 'instances', 'new-only', 'flows.json'), 'utf8'), 'new-flow');
  for (const path of ['manager/edge.db-wal', 'manager/edge.db-shm', 'instances/old-only']) {
    await assert.rejects(lstat(join(root, path)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(root, 'manager', 'spool', 'pending'), 'utf8'), 'keep-spool');
}

test('staging failure preserves all old state and clears the transaction gate', async (t) => {
  const root = await fixture(t);
  await assert.rejects(withRestoreTransaction(root, async (temporary) => {
    await stage(temporary);
    throw new Error('stage-write-failed');
  }), /stage-write-failed/);
  await oldState(root);
  await assertNoRestoreTransaction(root);
});

test('successful restore swaps the complete instance tree and preserves unrelated Manager files', async (t) => {
  const root = await fixture(t);
  await withRestoreTransaction(root, stage);
  await newState(root);
  await assertNoRestoreTransaction(root);
  await recoverRestoreTransaction(root);
  await newState(root);
  assert.equal((await readdir(root)).filter((name) => name.startsWith('.restore-trash-')).length, 0);
});

for (const partial of [false, true]) {
  test(`an interrupted initial transaction ${partial ? 'partial journal' : 'mkdir'} recovers without touching live state`, async (t) => {
    const root = await fixture(t);
    await mkdir(join(root, TX), { mode: 0o700 });
    if (partial) {
      await writeFile(join(root, TX, `journal-${randomUUID()}.partial`), '{"version":', { mode: 0o600 });
    }
    await assert.rejects(assertNoRestoreTransaction(root), /恢复|restore/i);
    await recoverRestoreTransaction(root);
    await oldState(root);
    await assertNoRestoreTransaction(root);
  });
}

test('missing journal with staging or unknown files remains gated for manual inspection', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, TX), { mode: 0o700 });
  await mkdir(join(root, TX, 'new'), { mode: 0o700 });
  await assert.rejects(recoverRestoreTransaction(root), /journal|日志|事务/i);
  await assert.rejects(assertNoRestoreTransaction(root), /恢复|restore/i);
  await oldState(root);
});

test('retired cleanup validates every candidate before deleting any and rejects symbolic links', async (t) => {
  const root = await fixture(t);
  const trusted = join(root, `.restore-trash-${randomUUID()}`);
  await mkdir(trusted, { mode: 0o700 });
  await writeFile(join(trusted, 'journal.json'), JSON.stringify({ version: 1, phase: 'staging', units: [] }), { mode: 0o600 });
  const bad = join(root, `.restore-trash-${randomUUID()}`);
  await symlink(join(root, 'manager'), bad);
  await assert.rejects(recoverRestoreTransaction(root), /目录|符号|trusted|symlink/i);
  assert.ok((await lstat(trusted)).isDirectory());
  await oldState(root);
  await rm(bad);
  await recoverRestoreTransaction(root);
  await assert.rejects(lstat(trusted), { code: 'ENOENT' });
});

for (const after of [false, true]) {
  for (let boundary = 1; boundary <= 6; boundary += 1) {
    test(`rename ${boundary} failure ${after ? 'after' : 'before'} mutation restores all old state`, async (t) => {
      const root = await fixture(t);
      const original = fs.rename;
      let count = 0;
      t.mock.method(fs, 'rename', async (...args: Parameters<typeof original>) => {
        const cutover = String(args[0]).includes(`${TX}/new/`)
          || String(args[1]).includes(`${TX}/old/`);
        if (cutover && ++count === boundary) {
          if (after) await original(...args);
          throw new Error('injected-rename-failure');
        }
        return original(...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(withRestoreTransaction(root, stage), /injected-rename-failure/);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      await oldState(root);
      await assertNoRestoreTransaction(root);
    });
  }
}

function crash(root: string, boundary: number) {
  const code = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const { mkdir, writeFile } = fs;
    const original = fs.rename;
    let count = 0;
    fs.rename = async (...args) => {
      await original(...args);
      if ((String(args[0]).includes('${TX}/new/') || String(args[1]).includes('${TX}/old/'))
        && ++count === ${boundary}) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    const { withRestoreTransaction } = await import(${JSON.stringify(new URL('./restore-transaction.ts', import.meta.url).href)});
    await withRestoreTransaction(process.argv[1], ${stage.toString()});
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, root], {
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}

for (let boundary = 1; boundary <= 6; boundary += 1) {
  test(`process death after rename ${boundary} is gated and explicitly recovers idempotently`, async (t) => {
    const root = await fixture(t);
    crash(root, boundary);
    await assert.rejects(assertNoRestoreTransaction(root), /恢复|restore/i);
    await recoverRestoreTransaction(root);
    await oldState(root);
    await recoverRestoreTransaction(root);
    await assertNoRestoreTransaction(root);
  });
}

for (let boundary = 1; boundary <= 6; boundary += 1) {
  test(`recovery survives another process death after rollback rename ${boundary}`, async (t) => {
    const root = await fixture(t);
    crash(root, 6);
    const code = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.rename;
      let count = 0;
      fs.rename = async (...args) => {
        await original(...args);
        if ((String(args[0]).includes('${TX}/old/') || String(args[1]).includes('${TX}/new/'))
          && ++count === ${boundary}) process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      const { recoverRestoreTransaction } = await import(${JSON.stringify(new URL('./restore-transaction.ts', import.meta.url).href)});
      await recoverRestoreTransaction(process.argv[1]);
    `;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, root], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    await assert.rejects(assertNoRestoreTransaction(root), /恢复|restore/i);
    await recoverRestoreTransaction(root);
    await oldState(root);
    await assertNoRestoreTransaction(root);
  });
}

test('failed automatic rollback retains the gate and original files for an explicit retry', async (t) => {
  const root = await fixture(t);
  const original = fs.rename;
  let count = 0;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes(`${TX}/old/`)) throw new Error('rollback-rename-failed');
    if ((String(args[0]).includes(`${TX}/new/`) || String(args[1]).includes(`${TX}/old/`))
      && ++count === 3) throw new Error('cutover-rename-failed');
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withRestoreTransaction(root, stage), /恢复事务失败/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await assert.rejects(assertNoRestoreTransaction(root), /恢复|restore/i);
  await recoverRestoreTransaction(root);
  await oldState(root);
  await assertNoRestoreTransaction(root);
});

test('failure while deleting retired trash preserves the committed state and never blocks startup', async (t) => {
  const root = await fixture(t);
  const original = fs.rm;
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes('.restore-trash-')) throw new Error('trash-delete-failed');
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withRestoreTransaction(root, stage), /trash-delete-failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await newState(root);
  await assertNoRestoreTransaction(root);
  assert.equal((await readdir(root)).filter((name) => name.startsWith('.restore-trash-')).length, 1);
  await recoverRestoreTransaction(root);
  await newState(root);
});

test('missing data root is created safely and no previous-state files are required', async (t) => {
  const parent = await fixture(t);
  const root = join(parent, 'missing', 'data');
  await assertNoRestoreTransaction(root);
  await recoverRestoreTransaction(root);
  await withRestoreTransaction(root, stage);
  assert.equal(await readFile(join(root, 'manager', 'edge.db'), 'utf8'), 'new-db');
  assert.equal(await readFile(join(root, 'instances', 'new-only', 'flows.json'), 'utf8'), 'new-flow');
  await assertNoRestoreTransaction(root);
});

for (const boundary of ['gate-mkdir', 'initial-journal', 'retire', 'payload-delete', 'before-journal-delete', 'after-journal-delete']) {
  test(`process death at ${boundary} preserves authority and explicit recovery removes all transaction data`, async (t) => {
    const root = await fixture(t);
    const code = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const { writeFile } = fs;
      const boundary = ${JSON.stringify(boundary)};
      const kill = () => process.kill(process.pid, 'SIGKILL');
      const originalMkdir = fs.mkdir;
      fs.mkdir = async (...args) => {
        const result = await originalMkdir(...args);
        if (boundary === 'gate-mkdir' && String(args[0]).endsWith('/${TX}')) kill();
        return result;
      };
      const originalRename = fs.rename;
      fs.rename = async (...args) => {
        if (boundary === 'initial-journal' && String(args[1]).endsWith('/${TX}/journal.json')) kill();
        await originalRename(...args);
        if (boundary === 'retire' && String(args[0]).endsWith('/${TX}')) kill();
      };
      const originalRm = fs.rm;
      fs.rm = async (...args) => {
        await originalRm(...args);
        if (boundary === 'payload-delete' && String(args[0]).includes('.restore-trash-')) kill();
      };
      const originalUnlink = fs.unlink;
      fs.unlink = async (...args) => {
        const selected = String(args[0]).includes('.restore-trash-') && String(args[0]).endsWith('/journal.json');
        if (boundary === 'before-journal-delete' && selected) kill();
        await originalUnlink(...args);
        if (boundary === 'after-journal-delete' && selected) kill();
      };
      syncBuiltinESMExports();
      const { mkdir } = fs;
      const { withRestoreTransaction } = await import(${JSON.stringify(new URL('./restore-transaction.ts', import.meta.url).href)});
      await withRestoreTransaction(process.argv[1], ${stage.toString()});
    `;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, root], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    await recoverRestoreTransaction(root);
    if (boundary === 'gate-mkdir' || boundary === 'initial-journal') await oldState(root);
    else await newState(root);
    assert.equal((await readdir(root)).filter((name) => name.startsWith('.restore-')).length, 0);
    await assertNoRestoreTransaction(root);
  });
}

test('committed cleanup failure keeps the new state and recovery never rolls it back', async (t) => {
  const root = await fixture(t);
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === join(root, TX)) throw new Error('cleanup-retirement-failed');
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withRestoreTransaction(root, stage), /cleanup-retirement-failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await newState(root);
  await assert.rejects(assertNoRestoreTransaction(root), /恢复|restore/i);
  await recoverRestoreTransaction(root);
  await newState(root);
  await assertNoRestoreTransaction(root);
});

test('a concurrent restore cannot take ownership of another transaction', async (t) => {
  const root = await fixture(t);
  await withRestoreTransaction(root, async (temporary) => {
    await assert.rejects(withRestoreTransaction(root, stage), /恢复|restore|EEXIST/i);
    await stage(temporary);
  });
  await newState(root);
});

test('symlink transaction, root, and staging paths never reach outside the data root', async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'tle-restore-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'sentinel'), 'untouched');
  await symlink(outside, join(root, TX));
  await assert.rejects(recoverRestoreTransaction(root), /symbolic|symlink|trusted|符号|目录/i);
  await rm(join(root, TX));
  await assert.rejects(withRestoreTransaction(root, async (temporary) => {
    await symlink(outside, join(temporary, 'manager'));
    await mkdir(join(temporary, 'instances'));
  }), /symbolic|symlink|trusted|符号|目录/i);
  const rootLink = join(outside, 'root-link');
  await symlink(root, rootLink);
  await assert.rejects(withRestoreTransaction(rootLink, stage), /symbolic|symlink|trusted|符号|目录/i);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
  await oldState(root);
});

test('tampered recovery journal is rejected without modifying either state', async (t) => {
  const root = await fixture(t);
  crash(root, 1);
  const journal = join(root, TX, 'journal.json');
  const parsed = JSON.parse(await readFile(journal, 'utf8')) as Record<string, unknown>;
  parsed['units'] = [{ path: '../../outside' }];
  await writeFile(journal, JSON.stringify(parsed), { mode: 0o600 });
  await assert.rejects(recoverRestoreTransaction(root), /journal|日志|事务/i);
  assert.ok((await readdir(join(root, TX))).length > 0);
  await chmod(journal, 0o666);
  await assert.rejects(recoverRestoreTransaction(root), /trusted|permission|日志|权限/i);
});
