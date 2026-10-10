import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Exact delivery roles. A separate policy image is shared by both helpers. */
export function assertImageRoles(manifest) {
  assert.ok(Array.isArray(manifest.images) && manifest.images.length >= 3, 'bundle manifest images missing');
  for (const item of manifest.images) {
    assert.ok(typeof item.image === 'string' && item.image.length > 0, 'bundle image reference missing');
    assert.match(item.id, /^sha256:[0-9a-f]{64}$/, 'bundle image Config ID invalid');
  }
  const refs = manifest.images.map(item => item.image);
  assert.equal(new Set(refs).size, refs.length, 'bundle manifest images must be unique');
  const roles = manifest.imageRoles;
  assert.ok(roles && typeof roles.manager === 'string' && typeof roles.dockerProxy === 'string'
    && typeof roles.networkIsolation === 'string' && typeof roles.initData === 'string'
    && Array.isArray(roles.nodeRed) && roles.nodeRed.length > 0
    && roles.nodeRed.every(image => typeof image === 'string'), 'bundle manifest imageRoles missing');
  const referenced = [roles.manager, roles.dockerProxy, roles.networkIsolation, roles.initData, ...roles.nodeRed];
  assert.deepEqual([...new Set(referenced)].sort(), [...refs].sort(), 'bundle image roles must reference exactly its exported images');
  assert.equal(new Set(roles.nodeRed).size, roles.nodeRed.length, 'duplicate Node-RED role images');
  const byRef = new Map(manifest.images.map(item => [item.image, item]));
  assert.equal(byRef.get(roles.dockerProxy).id, byRef.get(roles.networkIsolation).id,
    'Docker 策略与网络隔离必须使用同一发行构件的 Config ID');
  return roles;
}

/** A package-contained image may not be substituted into a different role. */
export function assertComposeImageRoles(manifest, services) {
  const roles = assertImageRoles(manifest);
  const expected = {
    manager: roles.manager,
    'docker-proxy': roles.dockerProxy,
    'network-isolation': roles.networkIsolation,
    'init-data': roles.initData,
    'node-red-image': roles.nodeRed[0],
  };
  assert.deepEqual(Object.keys(services ?? {}).sort(), Object.keys(expected).sort(), 'Compose 服务必须与离线包角色精确一致');
  for (const [service, image] of Object.entries(expected)) {
    assert.equal(services[service]?.image, image, `Compose ${service} 镜像与包内角色不一致`);
  }
}

// Runs in the already loaded Manager image with no network, capabilities,
// application data or Docker socket. Never log Compose JSON: it holds secrets.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const config = JSON.parse(readFileSync(0, 'utf8'));
    assertComposeImageRoles(manifest, config.services);
  } catch (error) {
    process.stderr.write(`offline image roles rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
