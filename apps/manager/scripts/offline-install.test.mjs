import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function fixture({ policyHealthy = true, networkHealthy = true, foreignImage = false, nodeRepo = 'nodered/node-red' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tle-offline-install-test-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/offline/install.sh'), join(root, 'install.sh'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ platform: 'linux/amd64', images: [
    { image: 'fixture/manager:1', id: 'fixture-manager-id' }, { image: 'fixture/init:1', id: 'fixture-init-id' },
    { image: `${nodeRepo}:fixture`, id: 'fixture-node-id' },
  ], imageRoles: { manager: 'fixture/manager:1', dockerProxy: 'fixture/manager:1', networkIsolation: 'fixture/manager:1',
    initData: 'fixture/init:1', nodeRed: [`${nodeRepo}:fixture`] } }, null, 2));
  writeFileSync(join(root, '.env'), 'EXTERNAL_URL=http://127.0.0.1:19100\nINITIAL_PASSWORD=local-fixture-password\n');
  const executable = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\nset -e\n${body}\n`); chmodSync(path, 0o755); };
  executable('shasum', 'exit 0'); executable('sleep', 'exit 0');
  executable('docker', `
case "$*" in
  info) exit 0 ;;
  'compose version') exit 0 ;;
  'version --format {{.Server.Arch}}') echo amd64 ;;
  'load -i images.tar') echo 'Loaded fixture image' ;;
  *'config --images') printf '%s\\n' fixture/manager:1 fixture/init:1 ${foreignImage ? 'legacy/proxy:1' : `${nodeRepo}:fixture`} ;;
  *'up -d') touch '${join(root, 'started')}' ;;
  *'ps'*'docker-proxy'*) echo 'fixture-docker-proxy Up (${policyHealthy ? 'healthy' : 'unhealthy'})' ;;
  *'ps'*'network-isolation'*) echo 'fixture-network-isolation Up (${networkHealthy ? 'healthy' : 'unhealthy'})' ;;
  *'ps'*) echo 'fixture-manager Up (healthy)' ;;
  *) echo 'unexpected fixture Docker call' >&2; exit 91 ;;
esac`);
  return {
    root,
    run: () => spawnSync('bash', [join(root, 'install.sh'), '--yes'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('offline installation does not report success while the Docker policy service is unhealthy', () => {
  const f = fixture({ policyHealthy: false });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker-proxy/);
  } finally { f.cleanup(); }
});

test('old configuration cannot silently start a proxy image outside the delivered artifact', () => {
  const f = fixture({ foreignImage: true });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /包外镜像/);
    assert.equal(existsSync(join(f.root, 'started')), false);
  } finally { f.cleanup(); }
});

test('offline installation succeeds only after all three management services are healthy', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(join(f.root, 'started')), true);
    assert.match(result.stdout, /独立端口/);
  } finally { f.cleanup(); }
});

test('a private Node-RED image repository is listed from explicit roles and does not fail after successful startup', () => {
  const f = fixture({ nodeRepo: 'registry.invalid/private/node-red' });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /registry\.invalid\/private\/node-red:fixture/);
  } finally { f.cleanup(); }
});

test('offline installation must not report success when the host network isolation service is unhealthy', () => {
  const f = fixture({ networkHealthy: false });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /network-isolation/);
  } finally { f.cleanup(); }
});
