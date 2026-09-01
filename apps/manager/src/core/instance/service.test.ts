import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
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
import {
  BootstrapCompensationError,
  InstanceService,
  type CreateInstanceInput,
} from './service.ts';
import type { DockerClient } from './docker-client.ts';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from '../nodes/platform-contract.ts';
import type { InstanceAdminRuntime } from './admin-runtime.ts';
import type { PlatformNodeOperationBarrier } from '../nodes/platform-operation-barrier.ts';
import { registerInstances } from '../../http/instance/crud.ts';
import type { HttpContext } from '../../http/context.ts';

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
    createInstance: async (input: { id: string }, _settings: string, mode: string) => {
      calls.push(`create:${input.id}:${mode}`);
    },
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
    readHostStats: async () => ({
      cpuCount: 4, loadPercent: 1, memTotalMb: 4096, memUsedMb: 512,
      memPercent: 12.5, memReliable: true, diskTotalGb: 100, diskUsedGb: 10,
      diskPercent: 10, uptimeSec: 100,
    }),
    palettePolicy: () => ({
      mode: 'allowlist',
      allowInstall: true,
      allowList: [],
      denyList: ['*'],
      catalogueUrls: [],
    }),
  });
  return { db, repo, calls, gate, service, docker };
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

test('image upgrade and rollback both preserve the explicitly persisted npm runtime mode', async () => {
  const success = fixture();
  success.db.prepare("UPDATE instance SET node_runtime_mode = 'npm' WHERE id = 'line-a'").run();
  await success.service.upgradeImage('line-a', '5.1.0-24-minimal', 'admin');
  assert.ok(success.calls.includes('create:line-a:npm'));

  const rollback = fixture();
  rollback.db.prepare("UPDATE instance SET node_runtime_mode = 'npm' WHERE id = 'line-a'").run();
  let creates = 0;
  (rollback.docker as unknown as {
    createInstance: (input: { id: string }, settings: string, mode: string) => Promise<void>;
  }).createInstance = async (input, _settings, mode) => {
    rollback.calls.push(`create:${input.id}:${mode}`);
    creates += 1;
    if (creates === 1) throw new Error('new image failed');
  };
  await assert.rejects(
    () => rollback.service.upgradeImage('line-a', '5.1.0-24-minimal', 'admin'),
    /已回滚/,
  );
  assert.deepEqual(
    rollback.calls.filter((call) => call.startsWith('create:')),
    ['create:line-a:npm', 'create:line-a:npm'],
  );
});

type BootstrapFailure =
  | 'trust'
  | 'data'
  | 'create'
  | 'start'
  | 'readiness'
  | 'install'
  | 'node-set'
  | 'on-disk';

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeInstalledFiles(root: string, id: string, corruptLock: boolean): void {
  const instance = join(root, id);
  const edgePath = `node_modules/${PLATFORM_NODE_PACKAGE.name}`;
  const commonPath = `node_modules/${PLATFORM_COMMON_PACKAGE.name}`;
  json(join(instance, 'package.json'), {
    dependencies: { [PLATFORM_NODE_PACKAGE.name]: PLATFORM_NODE_PACKAGE.version },
  });
  json(join(instance, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [PLATFORM_NODE_PACKAGE.name]: PLATFORM_NODE_PACKAGE.version } },
      [edgePath]: {
        version: PLATFORM_NODE_PACKAGE.version,
        integrity: corruptLock ? 'sha512-corrupt' : PLATFORM_NODE_PACKAGE.integrity,
        dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
      },
      [commonPath]: {
        version: PLATFORM_COMMON_PACKAGE.version,
        integrity: PLATFORM_COMMON_PACKAGE.integrity,
      },
    },
  });
  json(join(instance, edgePath, 'package.json'), {
    name: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
    'node-red': { nodes: Object.fromEntries(PLATFORM_NODE_TYPES.map((type) => [type, `${type}.js`])) },
  });
  json(join(instance, commonPath, 'package.json'), {
    name: PLATFORM_COMMON_PACKAGE.name,
    version: PLATFORM_COMMON_PACKAGE.version,
  });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function bootstrapFixture(options: {
  failure?: BootstrapFailure;
  residuals?: Array<'container' | 'network' | 'data'>;
} = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tle-bootstrap-service-'));
  const instanceDataRoot = join(base, 'instances');
  mkdirSync(instanceDataRoot, { recursive: true });
  const flowPath = join(instanceDataRoot, 'line-existing', 'flows.json');
  json(flowPath, [{ id: 'existing-flow', type: 'tab' }]);
  const initialFlowHash = sha256(flowPath);
  const seedPath = join(base, 'npm-seed', 'platform-seed.tgz');
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(seedPath, 'global-seed-must-survive');

  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('bootstrap-service-test', 'instance'));
  const events: string[] = [];
  let containerPresent = false;

  const healthyNodeSets = PLATFORM_NODE_TYPES.map((type) => ({
    id: type,
    name: type,
    module: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    types: [type],
    enabled: true,
    err: '',
    local: false,
  }));
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"test-token"}');
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/nodes')) {
      events.push('install');
      if (options.failure === 'install') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"code":"install_failed","detail":"opaque-secret-value"}');
        return;
      }
      const nodes = options.failure === 'node-set' ? healthyNodeSets.slice(0, 2) : healthyNodeSets;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: PLATFORM_NODE_PACKAGE.name,
        version: PLATFORM_NODE_PACKAGE.version,
        nodes,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const docker = {
    raw: {},
    imageRepo: 'nodered/node-red',
    imageRef: (tag: string) => `nodered/node-red:${tag}`,
    assertBootstrapResourcesAbsent: async () => { events.push('resources-absent'); },
    prepareBootstrapDataDir: async (id: string, txId: string) => {
      events.push(`data:${txId}`);
      if (options.failure === 'data') throw new Error('opaque-secret-value');
      writeInstalledFiles(instanceDataRoot, id, options.failure === 'on-disk');
    },
    createBootstrapInstance: async (_spec: unknown, _settings: string, txId: string) => {
      events.push(`create:${txId}`);
      if (options.failure === 'create') throw new Error('opaque-secret-value');
      containerPresent = true;
    },
    start: async () => {
      events.push('start');
      if (options.failure === 'start') throw new Error('opaque-secret-value');
    },
    cleanupBootstrap: async (_id: string, txId: string) => {
      events.push(`cleanup:${txId}`);
      if ((options.residuals?.length ?? 0) === 0) containerPresent = false;
      return { residuals: options.residuals ?? [] };
    },
    list: async () => containerPresent
      ? [{ id: 'line-new', state: 'running', running: true }]
      : [],
  } as unknown as DockerClient;
  const adminRuntime: InstanceAdminRuntime = {
    target: () => ({
      upstream: `http://127.0.0.1:${address.port}`,
      adminRoot: '/red/line-new/',
      username: 'admin',
      password: 'admin-password',
    }),
    waitReady: async () => {
      events.push('readiness');
      if (options.failure === 'readiness') throw new Error('opaque-secret-value');
    },
  };
  const barrier: PlatformNodeOperationBarrier = {
    reach: async (event) => {
      assert.ok(repo.nodeMigration(event.instanceId));
      events.push(`barrier:${event.txId}:${event.phase}:${event.boundary}`);
    },
  };
  const platformPackages = {
    verifyForInstall: () => {
      events.push('trust');
      if (options.failure === 'trust') throw new Error('opaque-secret-value');
      return { meta: { integrity: PLATFORM_NODE_PACKAGE.integrity } };
    },
  };
  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const service = new InstanceService({
    db,
    repo,
    docker,
    gate,
    adminRuntime,
    instanceDataRoot,
    platformPackages: platformPackages as never,
    barrier,
    basePath: '',
    portRange: { min: 30_000, max: 30_100 },
    allowedImageTags: ['5.0.4-24-minimal'],
    probeHostPorts: false,
    readHostStats: async () => ({
      cpuCount: 4, loadPercent: 1, memTotalMb: 4096, memUsedMb: 512,
      memPercent: 12.5, memReliable: true, diskTotalGb: 100, diskUsedGb: 10,
      diskPercent: 10, uptimeSec: 100,
    }),
    palettePolicy: () => ({
      mode: 'allowlist', allowInstall: true, allowList: [], denyList: ['*'], catalogueUrls: [],
    }),
  });
  const initialLedgerCounts = {
    devices: (db.prepare('SELECT COUNT(*) AS n FROM field_device').get() as { n: number }).n,
    tags: (db.prepare('SELECT COUNT(*) AS n FROM field_tag').get() as { n: number }).n,
  };
  return {
    base, db, repo, service, docker, events, flowPath, initialFlowHash, seedPath, initialLedgerCounts,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function assertNoSyntheticWrites(f: Awaited<ReturnType<typeof bootstrapFixture>>): void {
  assert.equal(sha256(f.flowPath), f.initialFlowHash);
  assert.deepEqual({
    devices: (f.db.prepare('SELECT COUNT(*) AS n FROM field_device').get() as { n: number }).n,
    tags: (f.db.prepare('SELECT COUNT(*) AS n FROM field_tag').get() as { n: number }).n,
  }, f.initialLedgerCounts);
  assert.equal(readFileSync(f.seedPath, 'utf8'), 'global-seed-must-survive');
}

test('new instance returns only after npm install Admin health and host files are committed', async () => {
  const f = await bootstrapFixture();
  try {
    const created = await f.service.create(newInstance);
    assert.equal(created.id, 'line-new');
    assert.deepEqual(f.repo.nodeRuntime('line-new'), {
      mode: 'npm', platformVersion: '0.0.1', migrationState: 'committed', migrationError: 'none',
    });
    assert.equal(f.repo.nodeMigration('line-new')?.phase, 'committed');
    const txId = f.repo.nodeMigration('line-new')?.txId;
    assert.ok(txId);
    assert.deepEqual(f.events, [
      'trust',
      'resources-absent',
      `barrier:${txId}:preparing:after-phase-persist`,
      `data:${txId}`,
      `create:${txId}`,
      `barrier:${txId}:preparing:after-container-create`,
      'start',
      'readiness',
      'install',
    ]);
    const audit = f.db.prepare(
      "SELECT result FROM audit WHERE action = 'commit-node-migration' AND target = 'line-new'",
    ).get() as { result: string } | undefined;
    assert.equal(audit?.result, 'ok');
    assertNoSyntheticWrites(f);
  } finally {
    await f.close();
  }
});

for (const failure of [
  'trust', 'data', 'create', 'start', 'readiness', 'install', 'node-set', 'on-disk',
] as const) {
  test(`bootstrap ${failure} failure compensates before deleting row and token`, async () => {
    const f = await bootstrapFixture({ failure });
    try {
      await assert.rejects(() => f.service.create(newInstance));
      assert.equal(f.repo.get('line-new'), undefined);
      assert.equal(f.repo.ingestToken('line-new'), undefined);
      if (failure === 'trust') assert.ok(!f.events.some((event) => event.startsWith('cleanup:')));
      else {
        const cleanup = f.events.find((event) => event.startsWith('cleanup:'));
        const preparing = f.events.find((event) => event.startsWith('barrier:'));
        const txId = preparing?.split(':')[1];
        assert.ok(txId);
        assert.equal(cleanup, `cleanup:${txId}`);
      }
      const audit = f.db.prepare(
        "SELECT detail FROM audit WHERE action = 'create-instance' AND target = 'line-new' AND result = 'fail'",
      ).get() as { detail: string } | undefined;
      assert.ok(audit);
      assert.doesNotMatch(audit.detail, /opaque-secret-value|admin-password|test-token/);
      assertNoSyntheticWrites(f);
    } finally {
      await f.close();
    }
  });
}

test('bootstrap failure never returns HTTP 201 from the public create route', async () => {
  const f = await bootstrapFixture({ failure: 'start' });
  const app = Fastify({ logger: false });
  registerInstances(app, {
    config: { basePath: '' },
    service: f.service,
    guard: () => ({ username: 'admin', role: 'admin' }),
    users: { grantFor: () => undefined },
    fail: (reply, error) => reply.code(400).send({ error: (error as Error).message }),
  } as unknown as HttpContext);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { ...newInstance, actor: undefined },
    });
    assert.equal(response.statusCode, 400);
    assert.notEqual(response.statusCode, 201);
    assert.equal(f.repo.get('line-new'), undefined);
  } finally {
    await app.close();
    await f.close();
  }
});

for (const residual of ['container', 'network', 'data'] as const) {
  test(`bootstrap compensation retains traceable manual_required for ${residual} residual`, async () => {
    const f = await bootstrapFixture({ failure: 'start', residuals: [residual] });
    try {
      await assert.rejects(
        () => f.service.create(newInstance),
        (error: unknown) => {
          assert.ok(error instanceof BootstrapCompensationError);
          assert.deepEqual(error.residuals, [residual]);
          assert.doesNotMatch(error.message, /opaque-secret-value|admin-password|test-token/);
          return true;
        },
      );
      assert.ok(f.repo.get('line-new'));
      assert.deepEqual(f.repo.nodeRuntime('line-new'), {
        mode: 'npm', platformVersion: '',
        migrationState: 'manual_required', migrationError: 'compensation',
      });
      assert.equal(f.repo.nodeMigration('line-new')?.phase, 'manual_required');
      const audit = f.db.prepare(
        "SELECT detail FROM audit WHERE action = 'bootstrap-compensation' AND target = 'line-new'",
      ).get() as { detail: string };
      assert.deepEqual(JSON.parse(audit.detail), { code: 'compensation', residuals: [residual] });
      assert.doesNotMatch(audit.detail, /opaque-secret-value|admin-password|test-token/);
      assertNoSyntheticWrites(f);
    } finally {
      await f.close();
    }
  });
}

test('late exact-label Docker residuals retain the bootstrap row as manual_required', async () => {
  const f = await bootstrapFixture({
    failure: 'start',
    residuals: ['container', 'network'],
  });
  try {
    await assert.rejects(
      () => f.service.create(newInstance),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapCompensationError);
        assert.deepEqual(error.residuals, ['container', 'network']);
        return true;
      },
    );
    assert.ok(f.repo.get('line-new'));
    assert.deepEqual(f.repo.nodeRuntime('line-new'), {
      mode: 'npm', platformVersion: '',
      migrationState: 'manual_required', migrationError: 'compensation',
    });
  } finally {
    await f.close();
  }
});

function seedInterruptedBootstrap(f: Awaited<ReturnType<typeof bootstrapFixture>>, id: string): void {
  f.repo.createWithNodeMigration(
    {
      ...record(id),
      adminRoot: `/red/${id}/`,
      nodeRuntimeMode: 'npm',
    },
    [],
    [{ username: 'admin', password: 'recovery-password', permissions: '*' }],
    {
      instanceId: id,
      txId: `tx-recover-${id}`,
      operationKind: 'bootstrap',
      phase: 'preparing',
      originalRunning: false,
      stagedBefore: false,
      modeBefore: 'npm',
      imageIdBefore: 'nodered/node-red:5.0.4-24-minimal',
      targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
      checkpointDir: '',
      snapshot: { version: 1, kind: 'bootstrap' },
      actor: 'admin',
    },
  );
  f.repo.setIngestToken(id, 'recovery-ingest-token');
}

test('startup recovery selects interrupted bootstrap journals and awaits verified cleanup', async () => {
  const f = await bootstrapFixture();
  try {
    seedInterruptedBootstrap(f, 'line-recover');
    const recovered = await f.service.recoverInterruptedBootstraps();
    assert.deepEqual(recovered, [{ instanceId: 'line-recover', residuals: [] }]);
    assert.equal(f.repo.get('line-recover'), undefined);
    assert.equal(f.repo.ingestToken('line-recover'), undefined);
    assert.ok(f.events.some((event) => event === 'cleanup:tx-recover-line-recover'));
  } finally {
    await f.close();
  }
});

test('startup recovery preserves manual_required when verified cleanup reports residuals', async () => {
  const f = await bootstrapFixture({ residuals: ['network'] });
  try {
    seedInterruptedBootstrap(f, 'line-recover');
    const recovered = await f.service.recoverInterruptedBootstraps();
    assert.deepEqual(recovered, [{ instanceId: 'line-recover', residuals: ['network'] }]);
    assert.deepEqual(f.repo.nodeRuntime('line-recover'), {
      mode: 'npm', platformVersion: '',
      migrationState: 'manual_required', migrationError: 'compensation',
    });
    assert.equal(f.repo.ingestToken('line-recover'), 'recovery-ingest-token');
  } finally {
    await f.close();
  }
});

test('startup recovery leaves a projection-mismatch manual bootstrap untouched', async () => {
  const f = await bootstrapFixture();
  try {
    seedInterruptedBootstrap(f, 'line-recover');
    f.db.prepare(
      "UPDATE instance SET node_migration_state = 'verifying', node_migration_error = 'verification' WHERE id = ?",
    ).run('line-recover');
    // Startup constructor reconciliation makes both authoritative rows manual_required.
    new InstanceRepo(f.db, deriveKey('bootstrap-service-test', 'instance'));
    const before = f.repo.nodeMigration('line-recover');
    const cleanupBefore = f.events.filter((event) => event.startsWith('cleanup:')).length;

    assert.deepEqual(await f.service.recoverInterruptedBootstraps(), []);
    assert.deepEqual(f.repo.nodeMigration('line-recover'), before);
    assert.ok(f.repo.get('line-recover'));
    assert.equal(
      f.events.filter((event) => event.startsWith('cleanup:')).length,
      cleanupBefore,
    );
  } finally {
    await f.close();
  }
});

test('startup recovery leaves rolled_back_dirty bootstrap evidence untouched', async () => {
  const f = await bootstrapFixture();
  try {
    seedInterruptedBootstrap(f, 'line-recover');
    f.repo.updateNodeMigration('line-recover', 'rolled_back_dirty', 'rollback');
    const before = f.repo.nodeMigration('line-recover');
    const cleanupBefore = f.events.filter((event) => event.startsWith('cleanup:')).length;

    assert.deepEqual(await f.service.recoverInterruptedBootstraps(), []);
    assert.deepEqual(f.repo.nodeMigration('line-recover'), before);
    assert.ok(f.repo.get('line-recover'));
    assert.equal(
      f.events.filter((event) => event.startsWith('cleanup:')).length,
      cleanupBefore,
    );
  } finally {
    await f.close();
  }
});

test('startup recovery leaves pending_start_verification bootstrap evidence untouched', async () => {
  const f = await bootstrapFixture();
  try {
    seedInterruptedBootstrap(f, 'line-recover');
    f.repo.updateNodeMigration('line-recover', 'pending_start_verification');
    const before = f.repo.nodeMigration('line-recover');

    assert.deepEqual(await f.service.recoverInterruptedBootstraps(), []);
    assert.deepEqual(f.repo.nodeMigration('line-recover'), before);
    assert.ok(f.repo.get('line-recover'));
  } finally {
    await f.close();
  }
});

test('successful bootstrap relies on the atomic commit audit and is not undone by a later create audit', async () => {
  const f = await bootstrapFixture();
  try {
    f.db.exec(`CREATE TRIGGER reject_nonatomic_create_success BEFORE INSERT ON audit
      WHEN NEW.action = 'create-instance' AND NEW.result = 'ok'
      BEGIN SELECT RAISE(ABORT, 'non-atomic create success rejected'); END;`);
    await assert.doesNotReject(() => f.service.create(newInstance));
    assert.equal(f.repo.nodeRuntime('line-new')?.migrationState, 'committed');
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'commit-node-migration'").get() as { n: number }).n,
      1,
    );
  } finally {
    await f.close();
  }
});

test('a final instance-view read failure is compensated before bootstrap commit', async () => {
  const f = await bootstrapFixture();
  try {
    (f.docker as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error('opaque-secret-value');
    };
    await assert.rejects(() => f.service.create(newInstance), /已完成补偿清理/);
    assert.equal(f.repo.get('line-new'), undefined);
    const audit = f.db.prepare(
      "SELECT detail FROM audit WHERE action = 'create-instance' AND result = 'fail'",
    ).get() as { detail: string };
    assert.doesNotMatch(audit.detail, /opaque-secret-value/);
  } finally {
    await f.close();
  }
});

test('clean compensation keeps the row when its trace audit cannot commit', async () => {
  const f = await bootstrapFixture({ failure: 'data' });
  try {
    f.db.exec(`CREATE TRIGGER reject_compensated_create_audit BEFORE INSERT ON audit
      WHEN NEW.action = 'create-instance' AND NEW.result = 'fail'
      BEGIN SELECT RAISE(ABORT, 'compensated create audit rejected'); END;`);
    await assert.rejects(
      () => f.service.create(newInstance),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapCompensationError);
        assert.deepEqual(error.residuals, []);
        assert.doesNotMatch(error.message, /compensated create audit rejected|opaque-secret-value/);
        return true;
      },
    );
    assert.ok(f.repo.get('line-new'));
    assert.deepEqual(f.repo.nodeRuntime('line-new'), {
      mode: 'npm', platformVersion: '',
      migrationState: 'manual_required', migrationError: 'compensation',
    });
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'create-instance' AND result = 'fail'").get() as { n: number }).n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('residual compensation commits manual_required and its trace audit atomically', async () => {
  const f = await bootstrapFixture({ failure: 'start', residuals: ['network'] });
  try {
    f.db.exec(`CREATE TRIGGER reject_residual_audit BEFORE INSERT ON audit
      WHEN NEW.action = 'bootstrap-compensation'
      BEGIN SELECT RAISE(ABORT, 'residual audit rejected'); END;`);
    await assert.rejects(
      () => f.service.create(newInstance),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapCompensationError);
        assert.deepEqual(error.residuals, ['network']);
        assert.doesNotMatch(error.message, /residual audit rejected|opaque-secret-value/);
        return true;
      },
    );
    assert.deepEqual(f.repo.nodeRuntime('line-new'), {
      mode: 'npm', platformVersion: '',
      migrationState: 'manual_required', migrationError: 'compensation',
    });
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'bootstrap-compensation'").get() as { n: number }).n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('audit-finalization failure reaches HTTP only as a controlled redacted compensation error', async () => {
  const f = await bootstrapFixture({ failure: 'data' });
  const app = Fastify({ logger: false });
  f.db.exec(`CREATE TRIGGER reject_http_compensation_audit BEFORE INSERT ON audit
    WHEN NEW.action = 'create-instance' AND NEW.result = 'fail'
    BEGIN SELECT RAISE(ABORT, 'opaque-db-finalization-secret'); END;`);
  registerInstances(app, {
    config: { basePath: '' },
    service: f.service,
    guard: () => ({ username: 'admin', role: 'admin' }),
    users: { grantFor: () => undefined },
    fail: (reply, error) => reply.code(400).send({ error: (error as Error).message }),
  } as unknown as HttpContext);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { ...newInstance, actor: undefined },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /补偿收尾未完成/);
    assert.doesNotMatch(response.body, /opaque-db-finalization-secret|opaque-secret-value/);
    assert.deepEqual(f.repo.nodeRuntime('line-new'), {
      mode: 'npm', platformVersion: '',
      migrationState: 'manual_required', migrationError: 'compensation',
    });
  } finally {
    await app.close();
    await f.close();
  }
});
