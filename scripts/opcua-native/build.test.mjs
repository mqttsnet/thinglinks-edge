import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
const run = promisify(execFile);
const script = fileURLToPath(new URL('./build.mjs', import.meta.url));
test('unsupported targets fail before invoking Docker or downloading a package', async () => {
  await assert.rejects(run(process.execPath, [script, '--arch=armv7', '--tag=test:never-built'], { timeout: 3000 }), /Explicit supported architecture/);
});
test('a substituted local package is rejected without executing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-builder-test-'));
  try {
    const archive = join(directory, 'invalid.tgz');
    await writeFile(archive, 'not an official package');
    await assert.rejects(run(process.execPath, [script, '--arch=arm64', '--tag=test:never-built', '--archive=' + archive], { timeout: 3000 }), /Official package integrity mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI refuses an unverified profile/architecture before accessing package data', async () => {
  await assert.rejects(run(process.execPath, [script, '--profile=5.0.7-24-minimal', '--arch=x64', '--tag=test:never-built', '--archive=/missing'], { timeout: 3000 }), /Unsupported or unverified/);
});
