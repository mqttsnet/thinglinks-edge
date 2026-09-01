import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo, type InstanceRecord } from './repo.ts';
import { InstanceOperationGate, type InstanceOperationLease } from './operation-gate.ts';
import { InstanceService, type CreateInstanceInput } from './service.ts';
import type { DockerClient } from './docker-client.ts';

const record = (id = 'line-a'): InstanceRecord => ({
  id,
  name: id,
  imageTag: '5.0.4-24-minimal',
  memLimit: 512,
  cpuLimit: 0.5,
  adminRoot: `/red/${id}/`,
  credSecret: 'credential-secret',
  notes: '',
});

function fixture() {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('service-gate-test', 'instance'));
  repo.create(record(), [], [{ username: 'admin', password: 'old-password', permissions: '*' }]);
  repo.setIngestToken('line-a', 'ingest-token');
  const calls: string[] = [];
  const docker = {
    raw: {},
    imageRepo: 'nodered/node-red',
    assertManaged: async (id: string) => { calls.push(`assertManaged:${id}`); },
    start: async (id: string) => { calls.push(`start:${id}`); },
    stop: async (id: string) => { calls.push(`stop:${id}`); },
    remove: async (id: string) => { calls.push(`remove:${id}`); },
    writeSettings: async (id: string) => { calls.push(`writeSettings:${id}`); },
    restart: async (id: string) => { calls.push(`restart:${id}`); },
    list: async () => [{ id: 'line-a', state: 'running', running: true }],
    assertImagePresent: async (image: string) => { calls.push(`assertImagePresent:${image}`); },
    imageRef: (tag: string) => `nodered/node-red:${tag}`,
    createInstance: async (input: { id: string }) => { calls.push(`create:${input.id}`); },
  } as unknown as DockerClient;
  const gate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const service = new InstanceService({
    db,
    repo,
    docker,
    gate,
    basePath: '',
    portRange: { min: 30_000, max: 30_100 },
    allowedImageTags: ['5.0.4-24-minimal', '5.1.0-24-minimal'],
    probeHostPorts: false,
    palettePolicy: () => ({
      mode: 'allowlist',
      allowInstall: true,
      allowList: [],
      denyList: ['*'],
      catalogueUrls: [],
    }),
  });
  return { db, repo, calls, gate, service };
}

const newInstance: CreateInstanceInput = {
  id: 'line-new',
  name: 'new line',
  imageTag: '5.0.4-24-minimal',
  memoryMb: 512,
  cpus: 0.5,
  ports: [],
  actor: 'admin',
};

test('a platform migration blocks every public service mutator before side effects', async () => {
  const actions = [
    { id: 'line-new', run: (f: ReturnType<typeof fixture>) => f.service.create(newInstance) },
    { id: 'line-a', run: (f: ReturnType<typeof fixture>) => f.service.start('line-a', 'admin') },
    { id: 'line-a', run: (f: ReturnType<typeof fixture>) => f.service.stop('line-a', 'admin') },
    { id: 'line-a', run: (f: ReturnType<typeof fixture>) => f.service.remove('line-a', { removeData: false, actor: 'admin' }) },
    { id: 'line-a', run: (f: ReturnType<typeof fixture>) => f.service.resetCredential('line-a', 'admin', 'admin') },
    { id: 'line-a', run: (f: ReturnType<typeof fixture>) => f.service.applyNodePolicy('line-a', 'admin') },
    { id: 'line-a', run: (f: ReturnType<typeof fixture>) => f.service.upgradeImage('line-a', '5.1.0-24-minimal', 'admin') },
  ];

  for (const action of actions) {
    const f = fixture();
    const beforeAudit = (f.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    const beforeCredential = f.repo.credentials('line-a')[0]?.password;
    await f.gate.run(action.id, 'platform-migration', async () => {
      await assert.rejects(() => action.run(f), /platform-migration/);
    });
    assert.deepEqual(f.calls, [], `blocked ${action.id} operation reached Docker`);
    assert.equal(f.repo.get('line-a')?.imageTag, '5.0.4-24-minimal');
    assert.equal(f.repo.credentials('line-a')[0]?.password, beforeCredential);
    assert.equal(
      (f.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
    );
    assert.equal(f.repo.get('line-new'), undefined);
  }
});

test('public start acquires one start lease and its under-lease primitive reuses it', async () => {
  const f = fixture();
  await f.service.start('line-a', 'admin');
  assert.deepEqual(f.calls, ['assertManaged:line-a', 'start:line-a']);
  assert.equal(f.gate.current('line-a'), undefined);
});

test('under-lease primitives reject fabricated and wrong-instance leases before Docker', async () => {
  const f = fixture();
  const fake = {
    instanceId: 'line-a',
    operation: 'start-instance',
  } as InstanceOperationLease;
  await assert.rejects(
    () => f.service.startUnderLease('line-a', fake, 'admin'),
    /lease.*invalid|invalid.*lease/i,
  );

  await f.gate.run('line-a', 'platform-migration', async (lease) => {
    await assert.rejects(
      () => f.service.stopUnderLease('line-b', lease, 'admin'),
      /line-b/,
    );
  });
  assert.deepEqual(f.calls, []);
});
