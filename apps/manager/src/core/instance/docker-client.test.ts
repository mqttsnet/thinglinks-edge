import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerClient } from './docker-client.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'thinglinks-docker-client-test-'));
  roots.push(temporaryRoot);
  const legacyDir = join(temporaryRoot, 'legacy-nodes');
  const instanceNodesDir = join(temporaryRoot, 'line-a', 'nodes');
  const cpCalls: Array<[string, string]> = [];
  const docker = new DockerClient({
    connection: { socketPath: '/dev/null' },
    network: 'test-edge',
    imageRepo: 'nodered/node-red',
    portRange: { min: 30_000, max: 30_999 },
    instanceDataRoot: temporaryRoot,
    timezone: 'UTC',
    nodePackageDir: legacyDir,
    copyDir: async (from, to) => { cpCalls.push([from, to]); },
  });
  return { docker, cpCalls, legacyDir, instanceNodesDir };
}

test('npm-mode data preparation never copies legacy raw nodes', async () => {
  const f = fixture();
  await f.docker.ensureDataDir('line-a', 'npm');
  assert.equal(f.cpCalls.length, 0);
});

test('legacy-mode data preparation keeps compatibility copy', async () => {
  const f = fixture();
  await f.docker.ensureDataDir('line-a', 'legacy');
  assert.deepEqual(f.cpCalls, [[f.legacyDir, f.instanceNodesDir]]);
});
