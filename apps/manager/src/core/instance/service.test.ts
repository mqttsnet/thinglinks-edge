import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import {
  InstanceRepo,
  type InstanceRecord,
  type NodeMigrationErrorCode,
  type NodeMigrationState,
} from './repo.ts';
import {
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
  type InstanceOperationLease,
  type RepositoryOperationPolicy,
} from './operation-gate.ts';
import { InstanceService, type CreateInstanceInput } from './service.ts';
import type { DockerClient } from './docker-client.ts';
import { PLATFORM_NODE_PACKAGE } from '../nodes/platform-contract.ts';

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

type PolicySetup = (
  repo: InstanceRepo,
  db: ReturnType<typeof openDb>,
) => RepositoryOperationPolicy;

function persistedPolicy(
  state: NodeMigrationState,
  error: NodeMigrationErrorCode = 'none',
): PolicySetup {
  return (repo, db) => {
    if (state === 'idle') {
      db.prepare(
        'UPDATE instance SET node_migration_state = ?, node_migration_error = ? WHERE id = ?',
      ).run(state, error, 'line-a');
      return new InstanceRepositoryOperationPolicy(repo);
    }
    repo.beginNodeMigration({
      instanceId: 'line-a',
      txId: `tx-service-${state}`,
      operationKind: 'bootstrap',
      phase: 'preparing',
      originalRunning: false,
      stagedBefore: false,
      modeBefore: 'legacy',
      imageIdBefore: 'sha256:image-a',
      targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
      checkpointDir: '',
      snapshot: { version: 1, kind: 'bootstrap' },
      actor: 'admin',
    });
    if (state === 'committed') {
      db.transaction(() => {
        db.prepare(
          'UPDATE instance_node_migration SET phase = ?, error = ? WHERE instance_id = ?',
        ).run(state, error, 'line-a');
        db.prepare(
          'UPDATE instance SET node_migration_state = ?, node_migration_error = ? WHERE id = ?',
        ).run(state, error, 'line-a');
      })();
    } else if (state !== 'preparing' || error !== 'none') {
      repo.updateNodeMigration('line-a', state, error);
    }
    return new InstanceRepositoryOperationPolicy(repo);
  };
}

function fixture(policySetup?: PolicySetup) {
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
  const gate = new InstanceOperationGate(
    policySetup?.(repo, db) ?? { assertAllowed: () => undefined },
  );
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

test('under-lease primitives reject wrong-operation and expired leases before Docker', async () => {
  const f = fixture();
  let expired: InstanceOperationLease | undefined;
  await f.gate.run('line-a', 'start-instance', async (lease) => {
    expired = lease;
    await assert.rejects(
      () => f.service.stopUnderLease('line-a', lease, 'admin'),
      /cannot authorize/,
    );
  });
  assert.deepEqual(f.calls, []);

  assert.ok(expired);
  await assert.rejects(
    () => f.service.startUnderLease('line-a', expired, 'admin'),
    /invalid|no longer active/,
  );
  assert.deepEqual(f.calls, []);
});

test('repository-backed manual_required blocks every public service mutator before side effects', async () => {
  const actions = [
    (f: ReturnType<typeof fixture>) => f.service.start('line-a', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.stop('line-a', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.remove('line-a', { removeData: false, actor: 'admin' }),
    (f: ReturnType<typeof fixture>) => f.service.resetCredential('line-a', 'admin', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.applyNodePolicy('line-a', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.upgradeImage('line-a', '5.1.0-24-minimal', 'admin'),
  ];

  for (const run of actions) {
    const f = fixture(persistedPolicy('manual_required', 'state-inconsistent'));
    const beforeAudit = (f.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    const beforeCredential = f.repo.credentials('line-a')[0]?.password;
    await assert.rejects(() => run(f), /manual_required\/state-inconsistent/);
    assert.deepEqual(f.calls, []);
    assert.ok(f.repo.get('line-a'));
    assert.equal(f.repo.get('line-a')?.imageTag, '5.0.4-24-minimal');
    assert.equal(f.repo.credentials('line-a')[0]?.password, beforeCredential);
    assert.equal(
      (f.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
    );
  }
});

for (const state of ['idle', 'committed', 'rolled_back'] as const) {
  test(`public start remains usable in clean ${state}`, async () => {
    const f = fixture(persistedPolicy(state));
    await f.service.start('line-a', 'admin');
    assert.deepEqual(f.calls, ['assertManaged:line-a', 'start:line-a']);
    const audit = f.db.prepare(
      "SELECT result FROM audit WHERE action = 'start-instance' AND target = 'line-a'",
    ).get() as { result: string } | undefined;
    assert.equal(audit?.result, 'ok');
  });
}

test('clean pending_start_verification permits only the public start facade', async () => {
  const start = fixture(persistedPolicy('pending_start_verification'));
  await start.service.start('line-a', 'admin');
  assert.deepEqual(start.calls, ['assertManaged:line-a', 'start:line-a']);

  const blocked = [
    (f: ReturnType<typeof fixture>) => f.service.stop('line-a', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.remove('line-a', { removeData: false, actor: 'admin' }),
    (f: ReturnType<typeof fixture>) => f.service.resetCredential('line-a', 'admin', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.applyNodePolicy('line-a', 'admin'),
    (f: ReturnType<typeof fixture>) => f.service.upgradeImage('line-a', '5.1.0-24-minimal', 'admin'),
  ];
  for (const run of blocked) {
    const f = fixture(persistedPolicy('pending_start_verification'));
    const beforeAudit = (f.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    await assert.rejects(() => run(f), /pending_start_verification\/none/);
    assert.deepEqual(f.calls, []);
    assert.equal(
      (f.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
    );
  }
});
