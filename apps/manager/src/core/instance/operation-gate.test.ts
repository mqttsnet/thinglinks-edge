import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo, type InstanceRecord } from './repo.ts';
import { PLATFORM_NODE_PACKAGE } from '../nodes/platform-contract.ts';
import {
  InstanceBusyError,
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
  type InstanceOperationLease,
  type RepositoryOperationPolicy,
} from './operation-gate.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ALLOW_ALL_POLICY: RepositoryOperationPolicy = {
  assertAllowed: () => undefined,
};

const record = (id: string): InstanceRecord => ({
  id,
  name: id,
  imageTag: '5.0.4-24-minimal',
  memLimit: 512,
  cpuLimit: 0.5,
  adminRoot: `/red/${id}/`,
  credSecret: 'credential-secret',
  notes: '',
});

function repositoryFixture(id = 'line-a') {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('operation-gate-test', 'instance'));
  repo.create(record(id), [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  return { db, repo };
}

function beginBootstrap(repo: InstanceRepo, txId: string): void {
  repo.beginNodeMigration({
    instanceId: 'line-a',
    txId,
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
}

test('same instance rejects concurrent mutations', async () => {
  const gate = new InstanceOperationGate(ALLOW_ALL_POLICY);
  const release = deferred<void>();
  const first = gate.run('line-a', 'platform-migration', async () => release.promise);
  await assert.rejects(
    () => gate.run('line-a', 'apply-node-policy', async () => undefined),
    /platform-migration/,
  );
  release.resolve();
  await first;
});

test('different instances may operate concurrently', async () => {
  const gate = new InstanceOperationGate(ALLOW_ALL_POLICY);
  await Promise.all([
    gate.run('line-a', 'upgrade-image', async () => undefined),
    gate.run('line-b', 'upgrade-image', async () => undefined),
  ]);
});

test('failed work always releases the instance lease', async () => {
  const gate = new InstanceOperationGate(ALLOW_ALL_POLICY);
  await assert.rejects(() => gate.run('line-a', 'stop-instance', async () => {
    throw new Error('stop failed');
  }));
  await gate.run('line-a', 'start-instance', async () => undefined);
  assert.equal(gate.current('line-a'), undefined);
});

test('runOrCurrent returns the current same-operation status without starting duplicate work', async () => {
  const gate = new InstanceOperationGate(ALLOW_ALL_POLICY);
  const release = deferred<void>();
  const first = gate.run('line-a', 'platform-migration', async () => release.promise);
  let workCalls = 0;
  const result = await gate.runOrCurrent(
    'line-a',
    'platform-migration',
    () => ({ phase: 'preparing' }),
    async () => {
      workCalls += 1;
      return { phase: 'committed' };
    },
  );
  assert.deepEqual(result, { phase: 'preparing' });
  assert.equal(workCalls, 0);
  release.resolve();
  await first;
});

test('fabricated and wrong-instance leases are rejected', async () => {
  const gate = new InstanceOperationGate(ALLOW_ALL_POLICY);
  const fake = {
    instanceId: 'line-a',
    operation: 'start-instance',
  } as InstanceOperationLease;
  assert.throws(
    () => gate.assertLease(fake, 'line-a', ['start-instance']),
    /lease.*invalid|invalid.*lease/i,
  );

  await gate.run('line-a', 'start-instance', async (lease) => {
    assert.throws(
      () => gate.assertLease(lease, 'line-b', ['start-instance']),
      /line-b/,
    );
  });
});

test('manual_required survives gate recreation and blocks every runtime mutation', async () => {
  const { repo } = repositoryFixture();
  beginBootstrap(repo, 'tx-manual');
  repo.updateNodeMigration('line-a', 'manual_required', 'state-inconsistent');

  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const operations = [
    'start-instance', 'stop-instance', 'remove-instance', 'reset-credential',
    'upgrade-image', 'same-image-rebuild', 'apply-node-policy', 'install-node',
    'flow-write', 'proxy-write', 'platform-migration',
  ] as const;
  for (const operation of operations) {
    await assert.rejects(
      () => gate.run('line-a', operation, async () => undefined),
      (error: unknown) => error instanceof InstanceBusyError
        && /manual_required/.test(error.message),
    );
  }
});

test('pending_start_verification allows only explicit start', async () => {
  const { repo } = repositoryFixture();
  beginBootstrap(repo, 'tx-pending');
  repo.updateNodeMigration('line-a', 'pending_start_verification');
  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));

  await gate.run('line-a', 'start-instance', async () => undefined);
  for (const operation of ['stop-instance', 'remove-instance', 'install-node', 'flow-write', 'proxy-write'] as const) {
    await assert.rejects(
      () => gate.run('line-a', operation, async () => undefined),
      /pending_start_verification/,
    );
  }
});

test('all interrupted durable phases block ordinary writes after restart', async () => {
  const { repo } = repositoryFixture();
  beginBootstrap(repo, 'tx-interrupted');
  for (const phase of ['preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back', 'rolled_back_dirty'] as const) {
    repo.updateNodeMigration('line-a', phase);
    const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
    await assert.rejects(
      () => gate.run('line-a', 'proxy-write', async () => undefined),
      new RegExp(phase),
    );
  }
});

test('repository policy fails closed when journal and projection disagree after construction', async () => {
  const { db, repo } = repositoryFixture();
  beginBootstrap(repo, 'tx-policy-mismatch');
  db.prepare(
    `UPDATE instance
     SET node_migration_state = 'idle', node_migration_error = 'none'
     WHERE id = 'line-a'`,
  ).run();

  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  await assert.rejects(
    () => gate.run('line-a', 'start-instance', async () => undefined),
    /不一致|inconsistent/i,
  );
});

test('repository policy fails closed when a non-idle projection has no journal', async () => {
  const { db, repo } = repositoryFixture();
  db.prepare(
    `UPDATE instance
     SET node_migration_state = 'pending_start_verification', node_migration_error = 'none'
     WHERE id = 'line-a'`,
  ).run();

  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  await assert.rejects(
    () => gate.run('line-a', 'start-instance', async () => undefined),
    /不一致|inconsistent/i,
  );
});
