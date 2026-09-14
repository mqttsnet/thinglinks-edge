import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileDescriptorStore } from './store.ts';
import { parseDescriptor } from './descriptor.ts';

const descriptor = parseDescriptor({ networkId: 'a'.repeat(64), cidr: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'br-aaaaaaaaaaaa', ipv6Enabled: false, protectedHosts: [], peerCIDRs: [], allowedHostEndpoints: [] });

test('private descriptor store persists validated records with owner-only permissions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-net-state-')));
  try {
    const store = new FileDescriptorStore(join(root, 'state'));
    assert.deepEqual(await store.load(), []);
    await store.save([descriptor]);
    assert.deepEqual(await new FileDescriptorStore(join(root, 'state')).load(), [descriptor]);
    assert.equal((await stat(join(root, 'state'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'state', 'networks.json'))).mode & 0o777, 0o600);
    const before = await readFile(join(root, 'state', 'networks.json'), 'utf8');
    await assert.rejects(store.save([{ ...descriptor, ipv6Enabled: true } as never]));
    assert.equal(await readFile(join(root, 'state', 'networks.json'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symlink and malformed persisted descriptors fail closed instead of resetting protection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-net-state-')));
  try {
    const store = new FileDescriptorStore(join(root, 'state'));
    await store.save([descriptor]);
    const file = join(root, 'state', 'networks.json');
    await writeFile(file, '{"version":1,"networks":[{"networkId":"bad"}]}');
    await assert.rejects(store.load());
    await rm(file);
    const other = join(root, 'unrelated.json');
    await writeFile(other, 'unrelated');
    await symlink(other, file);
    await assert.rejects(store.load());
    await assert.rejects(store.save([descriptor]));
    assert.equal(await readFile(other, 'utf8'), 'unrelated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('control-domain ownership persists and is never regenerated over existing state', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tle-net-owner-')));
  try {
    const directory = join(root, 'state'), store = new FileDescriptorStore(directory);
    const owner = await store.ownerId();
    assert.match(owner, /^[a-f0-9]{32}$/);
    assert.equal(await new FileDescriptorStore(directory).ownerId(), owner);
    await store.save([descriptor]);
    await rm(join(directory, 'owner-id'));
    await assert.rejects(new FileDescriptorStore(directory).ownerId(), /控制域/);
    await writeFile(join(directory, 'owner-id'), 'corrupt', { mode: 0o600 });
    await assert.rejects(new FileDescriptorStore(directory).ownerId(), /控制域/);
    await assert.rejects(store.load(), /控制域/);
    await writeFile(join(directory, 'owner-id'), 'f'.repeat(32), { mode: 0o600 });
    await assert.rejects(new FileDescriptorStore(directory).load(), /控制域/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
