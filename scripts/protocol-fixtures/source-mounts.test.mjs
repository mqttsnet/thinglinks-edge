import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrySourceMounts } from './source-mounts.mjs';

test('protocol registries receive only public source paths, never the repository root or local settings', () => {
  const root = '/workspace/edge';
  const args = registrySourceMounts(root);
  assert.ok(args.length > 0);
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], '--mount');
    const mount = args[i + 1];
    assert.match(mount, /,readonly$/);
    const source = /src=([^,]+)/.exec(mount)[1];
    assert.notEqual(source, root);
    for (const privatePath of ['.env', '.git/config', 'data/manager.db', 'settings.js']) {
      const path = `${root}/${privatePath}`;
      assert.ok(path !== source && !path.startsWith(`${source}/`), `${privatePath} exposed by source mount`);
    }
  }
});
