import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import {
  InstanceRepo,
  type InstanceRecord,
  type NodeMigrationState,
} from '../instance/repo.ts';
import {
  InstanceBusyError,
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
  type InstanceOperationLease,
} from '../instance/operation-gate.ts';
import { ProxySessionRegistry } from '../instance/proxy-session-registry.ts';
import type { InstanceAdminRuntime } from '../instance/admin-runtime.ts';
import type { AdminTarget, InstalledModule } from '../flows/admin-client.ts';
import { renderSettings } from '../instance/settings-template.ts';
import type { PlatformNodeOperationBarrier } from './platform-operation-barrier.ts';
import {
  LEGACY_PLATFORM_FILES,
  LEGACY_RUNTIME_EXCLUDES,
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from './platform-contract.ts';
import { MigrationCheckpointStore } from './migration-checkpoint.ts';
import {
  PlatformMigrationError,
  PlatformMigrationService,
  type MigrationCheckpointPort,
  type MigrationSettingsRenderer,
  type PlatformMigrationAdminActions,
  type PlatformMigrationContainerInspection,
  type PlatformMigrationDocker,
  type PlatformPackageInstallVerifier,
} from './platform-migration.ts';

const roots: string[] = [];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ManualMigrationTime {
  nowMs = 1_000;
  readonly sleeps: number[] = [];
  private readonly heartbeatTasks = new Set<() => void>();
  private readonly sleepers: Array<{ wakeAt: number; resolve: () => void }> = [];

  now = (): number => this.nowMs;

  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    return new Promise((resolve) => {
      this.sleepers.push({ wakeAt: this.nowMs + ms, resolve });
    });
  };

  startHeartbeat = (_intervalMs: number, task: () => void): (() => void) => {
    this.heartbeatTasks.add(task);
    return () => this.heartbeatTasks.delete(task);
  };

  get pendingSleeps(): number {
    return this.sleepers.length;
  }

  pulse(): void {
    for (const task of [...this.heartbeatTasks]) task();
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (let index = this.sleepers.length - 1; index >= 0; index -= 1) {
      const sleeper = this.sleepers[index]!;
      if (sleeper.wakeAt > this.nowMs) continue;
      this.sleepers.splice(index, 1);
      sleeper.resolve();
    }
  }
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const record = (id = 'line-a'): InstanceRecord => ({
  id,
  name: id,
  imageTag: '5.0.4-24-minimal',
  memLimit: 512,
  cpuLimit: 0.5,
  adminRoot: `/red/${id}/`,
  credSecret: 'credential-secret',
  notes: '',
  nodeRuntimeMode: 'legacy',
});

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

type TestArtifactFact =
  | { key: string; exists: false }
  | { key: string; exists: true; kind: 'file' | 'directory'; mode: number; sha256: string };

function testArtifactFact(root: string, key: string): TestArtifactFact {
  const absolute = join(root, key);
  if (!existsSync(absolute)) return { key, exists: false };
  const stat = lstatSync(absolute);
  assert.equal(stat.isSymbolicLink(), false, key);
  const mode = stat.mode & 0o777;
  if (stat.isFile()) {
    return { key, exists: true, kind: 'file', mode, sha256: sha256(readFileSync(absolute)) };
  }
  assert.equal(stat.isDirectory(), true, key);
  const entries: Array<{
    path: string;
    kind: 'file' | 'directory';
    mode: number;
    sha256?: string;
  }> = [];
  const walk = (directory: string, prefix: string) => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = prefix ? join(prefix, child.name) : child.name;
      const childAbsolute = join(directory, child.name);
      const childStat = lstatSync(childAbsolute);
      assert.equal(childStat.isSymbolicLink(), false, path);
      if (childStat.isDirectory()) {
        entries.push({ path, kind: 'directory', mode: childStat.mode & 0o777 });
        walk(childAbsolute, path);
      } else {
        assert.equal(childStat.isFile(), true, path);
        entries.push({
          path,
          kind: 'file',
          mode: childStat.mode & 0o777,
          sha256: sha256(readFileSync(childAbsolute)),
        });
      }
    }
  };
  walk(absolute, '');
  return { key, exists: true, kind: 'directory', mode, sha256: sha256(JSON.stringify(entries)) };
}

function writeTestManifest(path: string, fact: TestArtifactFact): void {
  writeFileSync(path, `${JSON.stringify(fact)}\n`, { mode: 0o600 });
}

function txSidecars(root: string, txId: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.includes(`.tle-${txId}.`)) found.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found.sort();
}

function stoppedAuthorityPath(
  f: ReturnType<typeof migrationFixture>,
  txId = 'tx-01',
): string {
  return join(f.root, '.thinglinks-stopped-evidence', 'line-a', txId);
}

function writeForgedDesiredSidecar(
  instanceRoot: string,
  txId: string,
  key: string,
): void {
  const target = join(instanceRoot, key);
  writeTestManifest(
    join(dirname(target), `.${basename(target)}.tle-${txId}.manifest`),
    testArtifactFact(instanceRoot, key),
  );
}

function nodeSet(
  module: string,
  type: string,
  version: string,
  err = '',
) {
  return {
    id: `${module}/${type}`,
    name: type,
    module,
    version,
    types: [type],
    enabled: err === '',
    err,
    local: module !== 'node-red',
  };
}

function rawPlatformInventory(): InstalledModule {
  const nodeSets = PLATFORM_NODE_TYPES.map((type) => nodeSet('node-red', type, '5.0.4'));
  return {
    module: 'node-red',
    version: '5.0.4',
    observedVersions: ['5.0.4'],
    local: false,
    types: [...PLATFORM_NODE_TYPES],
    enabled: true,
    errors: [],
    nodeSets,
    observedFiles: [],
    source: 'raw',
    health: 'healthy',
  };
}

function builtinInventory(): InstalledModule {
  return {
    module: 'node-red',
    version: '5.0.4',
    observedVersions: ['5.0.4'],
    local: false,
    types: ['inject'],
    enabled: true,
    errors: [],
    nodeSets: [nodeSet('node-red', 'inject', '5.0.4')],
    observedFiles: [],
    source: 'builtin',
    health: 'healthy',
  };
}

function healthyPlatformInventory(): InstalledModule {
  const module = PLATFORM_NODE_PACKAGE.name;
  const nodeSets = PLATFORM_NODE_TYPES.map((type) => (
    nodeSet(module, type, PLATFORM_NODE_PACKAGE.version)
  ));
  return {
    module,
    version: PLATFORM_NODE_PACKAGE.version,
    observedVersions: [PLATFORM_NODE_PACKAGE.version],
    local: true,
    types: [...PLATFORM_NODE_TYPES],
    enabled: true,
    errors: [],
    nodeSets,
    observedFiles: [],
    source: 'npm',
    health: 'healthy',
  };
}

function stagedPlatformInventory(version = PLATFORM_NODE_PACKAGE.version): InstalledModule {
  const module = PLATFORM_NODE_PACKAGE.name;
  const nodeSets = PLATFORM_NODE_TYPES.map((type) => (
    nodeSet(module, type, version, 'type_already_registered')
  ));
  return {
    module,
    version,
    observedVersions: [version],
    local: true,
    types: [...PLATFORM_NODE_TYPES],
    enabled: false,
    errors: nodeSets.map((set) => set.err),
    nodeSets,
    observedFiles: [],
    source: 'npm',
    health: 'failed',
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function writeInstalledPackage(instanceRoot: string): void {
  const edgeRelative = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
  const commonRelative = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
  writeJson(join(instanceRoot, 'package.json'), {
    name: 'line-a-runtime',
    dependencies: { [PLATFORM_NODE_PACKAGE.name]: PLATFORM_NODE_PACKAGE.version },
  });
  writeJson(join(instanceRoot, 'package-lock.json'), {
    packages: {
      '': { dependencies: { [PLATFORM_NODE_PACKAGE.name]: PLATFORM_NODE_PACKAGE.version } },
      [edgeRelative]: {
        version: PLATFORM_NODE_PACKAGE.version,
        integrity: PLATFORM_NODE_PACKAGE.integrity,
        dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
      },
      [commonRelative]: {
        version: PLATFORM_COMMON_PACKAGE.version,
        integrity: PLATFORM_COMMON_PACKAGE.integrity,
      },
    },
  });
  writeJson(join(instanceRoot, edgeRelative, 'package.json'), {
    name: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
    'node-red': { nodes: Object.fromEntries(
      PLATFORM_NODE_TYPES.map((type) => [type, `${type}.js`]),
    ) },
  });
  writeJson(join(instanceRoot, commonRelative, 'package.json'), {
    name: PLATFORM_COMMON_PACKAGE.name,
    version: PLATFORM_COMMON_PACKAGE.version,
  });
}

function removeInstalledPackage(instanceRoot: string): void {
  rmSync(join(instanceRoot, 'node_modules', '@mqttsnet'), { recursive: true, force: true });
  writeJson(join(instanceRoot, 'package.json'), { name: 'line-a-runtime', dependencies: {} });
  writeJson(join(instanceRoot, 'package-lock.json'), { packages: { '': { dependencies: {} } } });
}

interface RuntimeState {
  cutover: boolean;
  staged: boolean;
  probeRoot?: string;
  probeCutover?: boolean;
}

class FakeDocker implements PlatformMigrationDocker {
  readonly runtimeCalls: string[] = [];
  readonly settingsWrites: Array<{ nodesExcludes: string[] }> = [];
  inspection: PlatformMigrationContainerInspection;
  expected = {
    managerUrl: 'http://tle-mgr:19100/nodered',
    npmRegistry: 'http://tle-mgr:19100/nodered/npm/',
  };
  failAt = '';
  inspectCalls = 0;
  afterRestart: (() => void) | undefined;
  afterStart: (() => void) | undefined;
  afterProbeRestart: ((probeRoot: string) => void) | undefined;
  private readonly instanceRoot: string;
  private readonly state: RuntimeState;

  constructor(
    instanceRoot: string,
    state: RuntimeState,
    token: string,
  ) {
    this.instanceRoot = instanceRoot;
    this.state = state;
    this.inspection = {
      running: true,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      environment: [
        'TLE_INSTANCE_ID=line-a',
        'TLE_MANAGER_URL=http://tle-mgr:19100/nodered',
        `TLE_INGEST_TOKEN=${token}`,
        'NPM_CONFIG_REGISTRY=http://tle-mgr:19100/nodered/npm/',
      ],
    };
  }

  expectedMigrationEnvironment() { return { ...this.expected }; }

  async inspectMigrationRuntime(): Promise<PlatformMigrationContainerInspection> {
    this.inspectCalls += 1;
    if (this.failAt === 'inspect') throw new Error('token=external-secret inspect failed');
    return { ...this.inspection, environment: [...this.inspection.environment] };
  }

  async writeSettings(_instanceId: string, settings: string): Promise<void> {
    this.runtimeCalls.push('write-settings');
    if (this.failAt === 'settings') throw new Error('password=external-secret');
    writeFileSync(join(this.instanceRoot, 'settings.js'), settings, { mode: 0o600 });
    const match = settings.match(/nodesExcludes:\s*(\[[^\n]+\])/);
    this.settingsWrites.push({ nodesExcludes: match ? JSON.parse(match[1]!) as string[] : [] });
  }

  async restart(): Promise<void> {
    this.runtimeCalls.push('restart');
    if (this.failAt === 'restart') throw new Error('registryAuth=external-secret');
    this.state.cutover = true;
    this.afterRestart?.();
  }

  async stop(): Promise<void> {
    this.runtimeCalls.push('stop');
    if (this.failAt === 'stop') throw new Error('stop external failure');
    this.inspection = { ...this.inspection, running: false };
    this.state.cutover = false;
  }

  async start(): Promise<void> {
    this.runtimeCalls.push('start');
    if (this.failAt === 'start') throw new Error('start external failure');
    this.inspection = { ...this.inspection, running: true };
    const settings = readFileSync(join(this.instanceRoot, 'settings.js'), 'utf8');
    this.state.cutover = LEGACY_RUNTIME_EXCLUDES.every((file) => settings.includes(file));
    this.afterStart?.();
  }

  async createMigrationProbe(input: Parameters<PlatformMigrationDocker['createMigrationProbe']>[0]) {
    this.runtimeCalls.push('probe-create');
    const root = dirname(this.instanceRoot);
    const dataRoot = join(root, '.thinglinks-probes', input.spec.id, input.txId);
    const checkpoint = join(root, input.checkpointDir);
    mkdirSync(dataRoot, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(checkpoint, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; exists: boolean }>;
    };
    for (const fact of manifest.files) {
      if (fact.exists) cpSync(join(checkpoint, 'files', fact.path), join(dataRoot, fact.path));
    }
    writeFileSync(join(dataRoot, '.thinglinks-probe-owner'), input.txId);
    this.state.probeRoot = dataRoot;
    this.state.probeCutover = false;
    return {
      instanceId: input.spec.id,
      txId: input.txId,
      containerId: 'probe-container-id',
      networkId: 'probe-network-id',
      containerName: `tle-nr-migrate-${input.spec.id}-fake`,
      networkName: `tle-nr-migrate-${input.spec.id}-fake-net`,
      dataRoot,
      adminUpstream: `http://tle-nr-migrate-${input.spec.id}-fake:1880`,
    };
  }

  async writeMigrationProbeSettings(_handle: unknown, settings: string): Promise<void> {
    this.runtimeCalls.push('probe-write-settings');
    assert.ok(this.state.probeRoot);
    writeFileSync(join(this.state.probeRoot, 'settings.js'), settings, { mode: 0o600 });
  }

  async restartMigrationProbe(): Promise<void> {
    this.runtimeCalls.push('probe-restart');
    this.state.probeCutover = true;
    if (this.state.probeRoot) this.afterProbeRestart?.(this.state.probeRoot);
  }

  async cleanupMigrationProbe(): Promise<{ residuals: [] }> {
    this.runtimeCalls.push('probe-cleanup');
    if (this.state.probeRoot) rmSync(this.state.probeRoot, { recursive: true, force: true });
    this.state.probeRoot = undefined;
    return { residuals: [] };
  }

  async cleanupMigrationProbeByTx(): Promise<{ residuals: [] }> {
    this.runtimeCalls.push('probe-recovery-cleanup');
    if (this.state.probeRoot) rmSync(this.state.probeRoot, { recursive: true, force: true });
    this.state.probeRoot = undefined;
    return { residuals: [] };
  }
}

class FakeAdminRuntime implements InstanceAdminRuntime {
  waitCalls = 0;
  failReadyTimes = 0;

  target() {
    return {
      upstream: 'http://unused.invalid',
      adminRoot: '/red/line-a/',
      username: 'admin',
      password: 'not-persisted',
    };
  }

  async waitReady(): Promise<void> {
    this.waitCalls += 1;
    if (this.failReadyTimes > 0) {
      this.failReadyTimes -= 1;
      throw new Error('password=readiness-secret');
    }
  }
}

class FakeAdminActions implements PlatformMigrationAdminActions {
  installCalls = 0;
  uninstallCalls = 0;
  failAt = '';
  flowValue: unknown = [{ id: 'flow-a', type: 'inject' }];
  afterRestart = healthyPlatformInventory();
  beforeModules: InstalledModule[] = [rawPlatformInventory()];
  private readonly instanceRoot: string;
  private readonly state: RuntimeState;

  constructor(
    instanceRoot: string,
    state: RuntimeState,
  ) {
    this.instanceRoot = instanceRoot;
    this.state = state;
  }

  async installedModules(): Promise<InstalledModule[]> {
    if (this.failAt === 'inventory') throw new Error('token=inventory-secret');
    if (this.state.cutover) {
      return this.state.staged ? [builtinInventory(), this.afterRestart] : [builtinInventory()];
    }
    return [...this.beforeModules];
  }

  async stagePlatformModule(): Promise<InstalledModule> {
    this.installCalls += 1;
    if (this.failAt === 'install') throw new Error('password=install-secret');
    writeInstalledPackage(this.instanceRoot);
    this.state.staged = true;
    const staged = stagedPlatformInventory();
    this.beforeModules = [rawPlatformInventory(), staged];
    if (this.failAt === 'install-after-mutation') {
      throw new Error('password=install-after-mutation-secret');
    }
    return staged;
  }

  async uninstallPlatformModule(): Promise<void> {
    this.uninstallCalls += 1;
    if (this.failAt === 'uninstall') throw new Error('token=uninstall-secret');
    if (this.failAt === 'uninstall-partial') {
      rmSync(join(this.instanceRoot, 'node_modules', '@mqttsnet', 'thinglinks-edge-nodes'), {
        recursive: true,
        force: true,
      });
      writeJson(join(this.instanceRoot, 'package.json'), { name: 'line-a-runtime', dependencies: {} });
      writeJson(join(this.instanceRoot, 'package-lock.json'), { packages: { '': { dependencies: {} } } });
      this.beforeModules = [rawPlatformInventory()];
      return;
    }
    removeInstalledPackage(this.instanceRoot);
    this.state.staged = false;
    this.beforeModules = [rawPlatformInventory()];
  }

  async currentFlows(): Promise<unknown> {
    if (this.failAt === 'flows' && this.state.cutover) {
      throw new Error('credentials=flow-secret');
    }
    return this.flowValue;
  }

  async waitReadyAt(): Promise<void> {}

  async installedModulesAt(_target: AdminTarget): Promise<InstalledModule[]> {
    if (!this.state.probeRoot) throw new Error('probe root missing');
    return this.state.staged ? [builtinInventory(), healthyPlatformInventory()] : [builtinInventory()];
  }

  async stagePlatformModuleAt(_target: AdminTarget): Promise<InstalledModule> {
    this.installCalls += 1;
    if (!this.state.probeRoot) throw new Error('probe root missing');
    writeInstalledPackage(this.state.probeRoot);
    this.state.staged = true;
    return healthyPlatformInventory();
  }

  async currentFlowsAt(_target: AdminTarget): Promise<unknown> {
    if (!this.state.probeRoot) throw new Error('probe root missing');
    const path = join(this.state.probeRoot, 'flows.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }
}

class FakePackageVerifier implements PlatformPackageInstallVerifier {
  calls = 0;
  fail = false;

  verifyForInstall() {
    this.calls += 1;
    if (this.fail) throw new Error('registryAuth=package-secret');
    return {
      buffer: Buffer.from('verified-edge-package'),
      meta: {
        name: PLATFORM_NODE_PACKAGE.name,
        version: PLATFORM_NODE_PACKAGE.version,
        description: '',
        keywords: ['node-red'],
        types: [...PLATFORM_NODE_TYPES],
        isNodeRedNode: true,
        hasNodeRedMetadata: true,
        dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
        optionalDependencies: {},
        peerDependencies: {},
        peerDependenciesMeta: {},
        engines: {},
        size: 1,
        shasum: 'a'.repeat(40),
        integrity: PLATFORM_NODE_PACKAGE.integrity,
        updatedAt: new Date(0).toISOString(),
      },
    };
  }
}

class FakeSettings implements MigrationSettingsRenderer {
  private readonly gate: InstanceOperationGate;

  constructor(gate: InstanceOperationGate) {
    this.gate = gate;
  }

  renderNodeSettingsUnderLease(
    instanceId: string,
    lease: InstanceOperationLease,
    runtimeMode: 'legacy' | 'npm',
  ): string {
    this.gate.assertLease(lease, instanceId, ['platform-migration']);
    return renderSettings({
      instanceId,
      nodeRuntimeMode: runtimeMode,
      adminRoot: `/red/${instanceId}/`,
      credentialSecret: 'render-only-secret',
      credentials: [{
        username: 'admin',
        passwordHash: '$2b$08$pe27LO/EC6WoXvWkiUEIHej.gnWqZAOOMaP11vLZdI5.0RmC9RZfW',
        permissions: '*',
      }],
      palette: {
        allowInstall: true,
        allowList: [`${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`],
        denyList: ['*'],
        catalogues: ['/npm/-/catalogue.json'],
      },
    });
  }
}

interface FixtureOptions {
  preexisting?: boolean;
  originalRunning?: boolean;
  barrierFailure?: {
    phase: NodeMigrationState;
    boundary: string;
    artifact?: Parameters<PlatformNodeOperationBarrier['reach']>[0]['artifact'];
  };
  cleanupFailure?: boolean;
  onBarrier?: ((event: Parameters<PlatformNodeOperationBarrier['reach']>[0]) => (
    void | Promise<void>
  )) | undefined;
  onProxyClose?: (() => void) | undefined;
  enableRepair?: boolean;
  repairFailure?: boolean;
  onBootstrapRecovery?: (() => Promise<void> | void) | undefined;
}

function migrationFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tle-platform-migration-'));
  roots.push(root);
  const instanceRoot = join(root, 'line-a');
  mkdirSync(join(instanceRoot, 'nodes'), { recursive: true, mode: 0o770 });
  for (const [path, hash] of Object.entries(LEGACY_PLATFORM_FILES)) {
    const bytes = readFileSync(join(REPO_ROOT, 'packages', 'thinglinks-nodes', path));
    assert.equal(sha256(bytes), hash);
    writeFileSync(join(instanceRoot, 'nodes', path), bytes, { mode: 0o600 });
  }
  writeFileSync(join(instanceRoot, 'settings.js'), 'module.exports={nodesExcludes:[]};\n', { mode: 0o600 });
  writeJson(join(instanceRoot, 'flows.json'), [{ id: 'flow-a', type: 'inject' }]);
  writeJson(join(instanceRoot, 'flows_cred.json'), { flow: { opaque: 'credential-bytes' } });
  writeJson(join(instanceRoot, 'package.json'), { name: 'line-a-runtime', dependencies: {} });
  writeJson(join(instanceRoot, 'package-lock.json'), { packages: { '': { dependencies: {} } } });
  writeJson(join(instanceRoot, '.config.nodes.json'), {});
  writeJson(join(instanceRoot, '.config.modules.json'), {});

  const db = openDb(join(root, 'manager.db'));
  const repo = new InstanceRepo(db, deriveKey('migration-test-master-key', 'instance'));
  repo.create(record(), [], [{ username: 'admin', password: 'db-password', permissions: '*' }]);
  const token = 'db-ingest-token-value';
  repo.setIngestToken('line-a', token);
  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const state: RuntimeState = { cutover: false, staged: options.preexisting === true };
  const docker = new FakeDocker(instanceRoot, state, token);
  docker.inspection = { ...docker.inspection, running: options.originalRunning !== false };
  const adminRuntime = new FakeAdminRuntime();
  const admin = new FakeAdminActions(instanceRoot, state);
  if (options.preexisting) {
    writeInstalledPackage(instanceRoot);
    admin.beforeModules = [rawPlatformInventory(), stagedPlatformInventory()];
  }
  const packages = new FakePackageVerifier();
  const time = new ManualMigrationTime();
  const proxySessions = new ProxySessionRegistry();
  const events: string[] = [];
  const barrierEvents: Parameters<PlatformNodeOperationBarrier['reach']>[0][] = [];
  const controls: {
    barrierFailure: FixtureOptions['barrierFailure'];
    cleanupFailure: boolean;
  } = {
    barrierFailure: options.barrierFailure,
    cleanupFailure: options.cleanupFailure === true,
  };
  let unregister = () => undefined;
  unregister = proxySessions.register('line-a', {
    close(code) {
      events.push(`proxy-close:${code}`);
      options.onProxyClose?.();
      unregister();
    },
  });
  const realCheckpoint = new MigrationCheckpointStore(root);
  const checkpoint: MigrationCheckpointPort = {
    create: async (instanceId, txId) => {
      events.push(`checkpoint:create:${repo.nodeMigration(instanceId)?.phase ?? 'none'}`);
      return realCheckpoint.create(instanceId, txId);
    },
    cleanupPartial: (...args) => {
      events.push('checkpoint:cleanup-partial');
      return realCheckpoint.cleanupPartial(...args);
    },
    readyExists: (...args) => realCheckpoint.readyExists(...args),
    verify: (...args) => realCheckpoint.verify(...args),
    restore: (...args) => {
      events.push('checkpoint:restore');
      return realCheckpoint.restore(...args);
    },
    verifyLive: (...args) => realCheckpoint.verifyLive(...args),
    cleanupTerminal: (...args) => {
      if (controls.cleanupFailure) throw new Error('password=cleanup-secret');
      return realCheckpoint.cleanupTerminal(...args);
    },
  };
  const barrier: PlatformNodeOperationBarrier = {
    async reach(event) {
      assert.equal(repo.nodeMigration(event.instanceId)?.phase, event.phase);
      barrierEvents.push({ ...event });
      events.push(`barrier:${event.phase}:${event.boundary}`);
      await options.onBarrier?.({ phase: event.phase, boundary: event.boundary });
      if (
        controls.barrierFailure?.phase === event.phase
        && controls.barrierFailure.boundary === event.boundary
        && (
          controls.barrierFailure.artifact === undefined
          || controls.barrierFailure.artifact === event.artifact
        )
      ) throw new Error('token=barrier-secret');
    },
  };
  const createService = (
    selectedRepo: InstanceRepo,
    selectedGate: InstanceOperationGate,
    txId: string,
    executionOwner = `owner-${txId}-0000000000000000`,
  ) => new PlatformMigrationService({
    repo: selectedRepo,
    gate: selectedGate,
    proxySessions,
    docker,
    adminRuntime,
    admin,
    platformPackages: packages,
    checkpoint,
    settings: new FakeSettings(selectedGate),
    ...(options.enableRepair ? {
      repair: {
        recreateSameImageUnderLease: async (
          instanceId: string,
          lease: InstanceOperationLease,
        ) => {
          selectedGate.assertLease(lease, instanceId, ['platform-migration']);
          events.push('same-image-rebuild');
          docker.runtimeCalls.push('same-image-rebuild');
          if (options.repairFailure) throw new Error('TLE_INGEST_TOKEN=must-not-escape');
          docker.inspection = {
            ...docker.inspection,
            environment: [
              `TLE_INSTANCE_ID=${instanceId}`,
              `TLE_MANAGER_URL=${docker.expected.managerUrl}`,
              `TLE_INGEST_TOKEN=${token}`,
              `NPM_CONFIG_REGISTRY=${docker.expected.npmRegistry}`,
            ],
          };
        },
      },
    } : {}),
    ...(options.onBootstrapRecovery ? {
      bootstrapRecovery: {
        recoverInterruptedBootstraps: async () => {
          events.push('bootstrap-recovery');
          await options.onBootstrapRecovery?.();
        },
      },
    } : {}),
    barrier,
    instanceDataRoot: root,
    txId: () => txId,
    executionRuntime: {
      now: time.now,
      sleep: time.sleep,
      startHeartbeat: time.startHeartbeat,
      executionOwner: () => executionOwner,
      leaseDurationMs: 1_000,
    },
  });
  const service = createService(repo, gate, 'tx-01');
  return {
    root,
    instanceRoot,
    db,
    repo,
    gate,
    state,
    docker,
    adminRuntime,
    admin,
    packages,
    time,
    checkpoint: realCheckpoint,
    proxySessions,
    events,
    barrierEvents,
    controls,
    checkpointPort: checkpoint,
    createService,
    service,
  };
}

async function interruptedMigration(
  f: ReturnType<typeof migrationFixture>,
  txId: string,
  phase: Exclude<NodeMigrationState, 'idle' | 'committed' | 'rolled_back' | 'rolled_back_dirty' | 'manual_required'>,
  execution?: { owner: string; expiresAt: number },
  originalRunning = true,
): Promise<void> {
  f.repo.beginNodeMigration({
    instanceId: 'line-a',
    txId,
    operationKind: 'migration',
    phase: 'preparing',
    originalRunning,
    stagedBefore: false,
    modeBefore: 'legacy',
    imageIdBefore: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: `.thinglinks-migration/line-a/${txId}`,
    snapshot: {
      version: 1,
      kind: 'migration',
      settings: { exists: true, sha256: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))) },
      flows: { exists: true, sha256: sha256(readFileSync(join(f.instanceRoot, 'flows.json'))) },
      credentials: { exists: true, sha256: sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json'))) },
      packageManifest: { exists: true, sha256: sha256(readFileSync(join(f.instanceRoot, 'package.json'))) },
      lock: { exists: true, sha256: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))) },
      legacyManifestSha256: 'a'.repeat(64),
      nodeInventorySha256: 'b'.repeat(64),
    },
    actor: 'admin',
    ...(execution ? {
      executionOwner: execution.owner,
      executionLeaseExpiresAt: execution.expiresAt,
    } : {}),
  });
  f.docker.inspection = { ...f.docker.inspection, running: originalRunning };
  if (phase !== 'preparing') {
    await f.checkpoint.create('line-a', txId);
    f.repo.updateNodeMigration('line-a', phase);
  }
}

function reopenMigrationFixture(
  f: ReturnType<typeof migrationFixture>,
  bootstrapRecovery?: () => Promise<unknown>,
) {
  f.db.close();
  const db = openDb(join(f.root, 'manager.db'));
  const repo = new InstanceRepo(db, deriveKey('migration-test-master-key', 'instance'));
  const gate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const barrier: PlatformNodeOperationBarrier = {
    async reach(event) {
      assert.equal(repo.nodeMigration(event.instanceId)?.phase, event.phase);
      f.barrierEvents.push({ ...event });
      f.events.push(`reopened-barrier:${event.phase}:${event.boundary}`);
    },
  };
  const service = new PlatformMigrationService({
    repo,
    gate,
    proxySessions: f.proxySessions,
    docker: f.docker,
    adminRuntime: f.adminRuntime,
    admin: f.admin,
    platformPackages: f.packages,
    checkpoint: f.checkpointPort,
    settings: new FakeSettings(gate),
    barrier,
    instanceDataRoot: f.root,
    txId: () => 'tx-reopened-unused',
    ...(bootstrapRecovery ? {
      bootstrapRecovery: { recoverInterruptedBootstraps: bootstrapRecovery },
    } : {}),
    executionRuntime: {
      now: f.time.now,
      sleep: f.time.sleep,
      startHeartbeat: f.time.startHeartbeat,
      executionOwner: () => 'owner-reopened-recovery-0001',
      leaseDurationMs: 1_000,
    },
  });
  return { db, repo, gate, service };
}

function installPhaseRealisticRunningEffects(
  f: ReturnType<typeof migrationFixture>,
  phase: NodeMigrationState,
): void {
  if (!['staged', 'cutover', 'verifying', 'rolling_back'].includes(phase)) return;
  writeInstalledPackage(f.instanceRoot);
  f.state.staged = true;
  f.admin.beforeModules = [rawPlatformInventory(), stagedPlatformInventory()];
  if (['cutover', 'verifying', 'rolling_back'].includes(phase)) {
    writeFileSync(
      join(f.instanceRoot, 'settings.js'),
      `module.exports={nodesExcludes:${JSON.stringify(LEGACY_RUNTIME_EXCLUDES)}};\n`,
      { mode: 0o600 },
    );
    f.state.cutover = true;
  }
}

function writePriorCommonModule(f: ReturnType<typeof migrationFixture>): void {
  const commonKey = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
  const common = join(f.instanceRoot, commonKey);
  mkdirSync(join(common, 'lib'), { recursive: true, mode: 0o750 });
  chmodSync(common, 0o750);
  writeFileSync(join(common, 'package.json'), '{"name":"prior-common"}\n', { mode: 0o640 });
  writeFileSync(join(common, 'lib', 'prior.js'), 'module.exports = 0;\n', { mode: 0o600 });
}

function installPhaseRealisticStoppedEffects(
  f: ReturnType<typeof migrationFixture>,
  txId: string,
  phase: NodeMigrationState,
): void {
  if (!['cutover', 'verifying', 'rolling_back'].includes(phase)) return;
  const priorFacts = new Map(
    [
      'settings.js', 'package.json', 'package-lock.json',
      '.config.nodes.json', '.config.nodes.json.backup',
      '.config.modules.json', '.config.modules.json.backup',
      join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/')),
      join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/')),
    ].map((key) => [key, testArtifactFact(f.instanceRoot, key)]),
  );
  const sidecar = (target: string, suffix: string) => (
    join(dirname(target), `.${basename(target)}.tle-${txId}.${suffix}`)
  );
  const replaceFile = (key: string, desired: string, mode: number) => {
    const target = join(f.instanceRoot, key);
    const prior = testArtifactFact(f.instanceRoot, key);
    assert.equal(prior.exists, true, key);
    renameSync(target, sidecar(target, 'backup'));
    writeTestManifest(sidecar(target, 'backup-manifest'), prior);
    writeFileSync(target, desired, { mode });
    writeTestManifest(sidecar(target, 'manifest'), testArtifactFact(f.instanceRoot, key));
  };
  replaceFile(
    'settings.js',
    `module.exports={nodesExcludes:${JSON.stringify(LEGACY_RUNTIME_EXCLUDES)}};\n`,
    0o640,
  );
  replaceFile('package.json', '{"name":"line-a-runtime","dependencies":{"probe":"1.0.0"}}\n', 0o640);
  replaceFile('package-lock.json', '{"packages":{"":{"dependencies":{"probe":"1.0.0"}}}}\n', 0o600);

  const edgeKey = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
  const edgeTarget = join(f.instanceRoot, edgeKey);
  assert.equal(existsSync(edgeTarget), false);
  mkdirSync(join(edgeTarget, 'lib'), { recursive: true, mode: 0o750 });
  chmodSync(edgeTarget, 0o750);
  writeFileSync(join(edgeTarget, 'package.json'), '{"name":"created-edge"}\n', { mode: 0o640 });
  writeFileSync(join(edgeTarget, 'lib', 'created.js'), 'module.exports = 1;\n', { mode: 0o600 });
  writeTestManifest(sidecar(edgeTarget, 'manifest'), testArtifactFact(f.instanceRoot, edgeKey));

  const commonKey = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
  const commonTarget = join(f.instanceRoot, commonKey);
  const commonPrior = testArtifactFact(f.instanceRoot, commonKey);
  assert.equal(commonPrior.exists, true);
  renameSync(commonTarget, sidecar(commonTarget, 'backup'));
  writeTestManifest(sidecar(commonTarget, 'backup-manifest'), commonPrior);
  mkdirSync(commonTarget, { recursive: true, mode: 0o700 });
  chmodSync(commonTarget, 0o700);
  writeFileSync(join(commonTarget, 'package.json'), '{"name":"replacement-common"}\n', { mode: 0o600 });
  writeTestManifest(sidecar(commonTarget, 'manifest'), testArtifactFact(f.instanceRoot, commonKey));

  for (const key of [
    '.config.nodes.json', '.config.nodes.json.backup',
    '.config.modules.json', '.config.modules.json.backup',
  ]) {
    const target = join(f.instanceRoot, key);
    const desired = testArtifactFact(f.instanceRoot, key);
    writeTestManifest(sidecar(target, 'manifest'), desired);
    if (desired.exists) cpSync(target, sidecar(target, 'partial'));
  }
  const authorityRoot = join(
    f.root, '.thinglinks-stopped-evidence', 'line-a', txId,
  );
  mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
  chmodSync(join(f.root, '.thinglinks-stopped-evidence'), 0o700);
  chmodSync(join(f.root, '.thinglinks-stopped-evidence', 'line-a'), 0o700);
  chmodSync(authorityRoot, 0o700);
  writeFileSync(join(authorityRoot, 'manifest.json'), `${JSON.stringify({
    version: 1,
    instanceId: 'line-a',
    txId,
    targetIntegrity: f.repo.nodeMigration('line-a')!.targetIntegrity,
    artifacts: [...priorFacts.entries()].map(([key, prior]) => ({
      key,
      desired: testArtifactFact(f.instanceRoot, key),
      prior,
    })),
  })}\n`, { mode: 0o600 });
}

function claimReplacementExecution(
  f: ReturnType<typeof migrationFixture>,
  owner: string,
  phase: 'preparing' | 'checkpointed' | 'staged' | 'cutover' | 'verifying' | 'rolling_back',
): void {
  const journal = f.repo.nodeMigration('line-a');
  assert.ok(journal);
  f.time.advance(1_000);
  const claimed = f.repo.claimNodeMigrationExecution(
    'line-a', journal.txId, owner, [phase], f.time.now(), 1_000,
  );
  assert.equal(claimed?.executionOwner, owner);
}

test('preflight rejects modified, missing, and extra legacy files with no Docker runtime side effects', async () => {
  const cases = [
    { name: 'modified', mutate: (f: ReturnType<typeof migrationFixture>) => {
      writeFileSync(join(f.instanceRoot, 'nodes', 'tl-device.js'), 'modified');
    } },
    { name: 'missing', mutate: (f: ReturnType<typeof migrationFixture>) => {
      rmSync(join(f.instanceRoot, 'nodes', 'tl-tag.html'));
    } },
    { name: 'extra', mutate: (f: ReturnType<typeof migrationFixture>) => {
      writeFileSync(join(f.instanceRoot, 'nodes', 'user-node.js'), 'user code');
    } },
  ];
  for (const item of cases) {
    const f = migrationFixture();
    item.mutate(f);
    await assert.rejects(
      () => f.service.migrate('line-a', 'admin'),
      (error: unknown) => (
        error instanceof PlatformMigrationError
        && error.code === 'preflight'
        && /legacy|tl-|raw|hash/i.test(error.message)
      ),
      item.name,
    );
    assert.deepEqual(f.docker.runtimeCalls, []);
    assert.equal(f.admin.installCalls, 0);
    assert.equal(f.repo.nodeRuntime('line-a')?.mode, 'legacy');
    assert.equal(f.repo.nodeMigration('line-a'), undefined);
    assert.equal(f.proxySessions.count('line-a'), 1, item.name);
  }
});

test('revalidates mutable preflight facts after drain and rejects the between-pass change before a journal', async () => {
  const f = migrationFixture({
    onProxyClose: () => {
      writeFileSync(join(f.instanceRoot, 'nodes', 'tl-device.js'), 'changed-after-readonly-preflight');
    },
  });

  await assert.rejects(
    () => f.service.migrate('line-a', 'admin'),
    (error: unknown) => error instanceof PlatformMigrationError && error.code === 'preflight',
  );

  assert.equal(f.docker.inspectCalls, 2);
  assert.equal(f.repo.nodeMigration('line-a'), undefined);
  assert.equal(f.admin.installCalls, 0);
  assert.deepEqual(f.docker.runtimeCalls, []);
});

test('rejects mutable image tags during read-only preflight without draining editors', async () => {
  const f = migrationFixture();
  f.docker.inspection = { ...f.docker.inspection, imageId: 'node-red:5.0.4' };

  await assert.rejects(
    () => f.service.migrate('line-a', 'admin'),
    (error: unknown) => error instanceof PlatformMigrationError && error.code === 'preflight',
  );

  assert.equal(f.proxySessions.count('line-a'), 1);
  assert.equal(f.docker.inspectCalls, 1);
  assert.equal(f.repo.nodeMigration('line-a'), undefined);
});

test('environment identity, token digest, third-party ownership, and staged identity fail closed', async () => {
  const cases: Array<{
    name: string;
    mutate: (f: ReturnType<typeof migrationFixture>) => void;
  }> = [
    { name: 'manager URL', mutate: (f) => {
      f.docker.inspection.environment = f.docker.inspection.environment
        .filter((entry) => !entry.startsWith('TLE_MANAGER_URL='));
    } },
    { name: 'registry', mutate: (f) => {
      f.docker.inspection.environment = f.docker.inspection.environment
        .map((entry) => entry.startsWith('NPM_CONFIG_REGISTRY=')
          ? 'NPM_CONFIG_REGISTRY=http://wrong.invalid/npm/' : entry);
    } },
    { name: 'instance id', mutate: (f) => {
      f.docker.inspection.environment = f.docker.inspection.environment
        .map((entry) => entry.startsWith('TLE_INSTANCE_ID=') ? 'TLE_INSTANCE_ID=line-b' : entry);
    } },
    { name: 'token', mutate: (f) => {
      f.docker.inspection.environment = f.docker.inspection.environment
        .map((entry) => entry.startsWith('TLE_INGEST_TOKEN=') ? 'TLE_INGEST_TOKEN=wrong-token' : entry);
    } },
    { name: 'third-party owner', mutate: (f) => {
      f.admin.beforeModules.push({
        ...healthyPlatformInventory(),
        module: 'third-party-node',
        version: '1.0.0',
        observedVersions: ['1.0.0'],
        nodeSets: [nodeSet('third-party-node', 'tl-device', '1.0.0')],
        types: ['tl-device'],
      });
    } },
    { name: 'wrong staged version', mutate: (f) => {
      f.admin.beforeModules.push(stagedPlatformInventory('0.0.2'));
    } },
    { name: 'unhealthy raw owner', mutate: (f) => {
      const raw = rawPlatformInventory();
      raw.nodeSets[0] = { ...raw.nodeSets[0]!, enabled: false, err: 'load_failed' };
      raw.enabled = false;
      raw.errors = ['load_failed'];
      raw.health = 'failed';
      f.admin.beforeModules = [raw];
    } },
  ];
  for (const item of cases) {
    const f = migrationFixture();
    item.mutate(f);
    await assert.rejects(
      () => f.service.migrate('line-a', 'admin'),
      (error: unknown) => error instanceof PlatformMigrationError && error.code === 'preflight',
      item.name,
    );
    assert.deepEqual(f.docker.runtimeCalls, [], item.name);
    assert.equal(f.admin.installCalls, 0, item.name);
    assert.equal(f.repo.nodeMigration('line-a'), undefined, item.name);
  }
});

test('every missing or wrong managed environment identity repairs once before migration side effects', async () => {
  const mutations: Array<[string, (environment: string[]) => string[]]> = [
    ['manager missing', (env) => env.filter((entry) => !entry.startsWith('TLE_MANAGER_URL='))],
    ['manager wrong', (env) => env.map((entry) => entry.startsWith('TLE_MANAGER_URL=')
      ? 'TLE_MANAGER_URL=http://wrong.invalid/' : entry)],
    ['registry missing', (env) => env.filter((entry) => !entry.startsWith('NPM_CONFIG_REGISTRY='))],
    ['registry wrong', (env) => env.map((entry) => entry.startsWith('NPM_CONFIG_REGISTRY=')
      ? 'NPM_CONFIG_REGISTRY=http://wrong.invalid/npm/' : entry)],
    ['instance missing', (env) => env.filter((entry) => !entry.startsWith('TLE_INSTANCE_ID='))],
    ['instance wrong', (env) => env.map((entry) => entry.startsWith('TLE_INSTANCE_ID=')
      ? 'TLE_INSTANCE_ID=line-b' : entry)],
    ['token missing', (env) => env.filter((entry) => !entry.startsWith('TLE_INGEST_TOKEN='))],
    ['token wrong', (env) => env.map((entry) => entry.startsWith('TLE_INGEST_TOKEN=')
      ? 'TLE_INGEST_TOKEN=raw-wrong-token' : entry)],
  ];
  for (const originalRunning of [true, false]) {
    for (const [name, mutate] of mutations) {
      const f = migrationFixture({ originalRunning, enableRepair: true });
      f.docker.inspection.environment = mutate(f.docker.inspection.environment);

      const result = await f.service.migrate('line-a', 'admin');

      assert.equal(
        result.phase,
        originalRunning ? 'committed' : 'pending_start_verification',
        `${name}/${originalRunning ? 'running' : 'stopped'}`,
      );
      assert.equal(f.events.filter((event) => event === 'same-image-rebuild').length, 1);
      assert.ok(f.events.indexOf('same-image-rebuild') < f.events.indexOf('proxy-close:1012'));
      assert.doesNotMatch(
        JSON.stringify(f.db.prepare('SELECT * FROM instance_node_migration').all()),
        /raw-wrong-token|db-ingest-token-value|TLE_INGEST_TOKEN/,
      );
    }
  }
});

test('failed environment repair performs no migration side effect and preserves running or stopped state', async () => {
  for (const originalRunning of [true, false]) {
    const f = migrationFixture({ originalRunning, enableRepair: true, repairFailure: true });
    f.docker.inspection.environment = ['TLE_INSTANCE_ID=wrong-instance'];
    await assert.rejects(
      () => f.service.migrate('line-a', 'admin'),
      (error: unknown) => error instanceof PlatformMigrationError
        && error.code === 'preflight'
        && !/must-not-escape|TLE_INGEST_TOKEN/.test(error.message),
    );
    assert.equal(f.repo.nodeMigration('line-a'), undefined);
    assert.equal(f.proxySessions.count('line-a'), 1);
    assert.equal(f.docker.inspection.running, originalRunning);
    assert.equal(f.admin.installCalls, 0);
  }
});

test('lease and proxy drain precede durable checkpoint and checkpointed barrier precedes install', async () => {
  const f = migrationFixture({
    barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' },
  });
  const result = await f.service.migrate('line-a', 'admin');
  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.proxySessions.count('line-a'), 0);
  assert.equal(f.admin.installCalls, 0);
  assert.ok(f.packages.calls >= 1);
  assert.ok(f.events.indexOf('proxy-close:1012') < f.events.indexOf('barrier:preparing:after-phase-persist'));
  assert.ok(f.events.indexOf('barrier:preparing:after-phase-persist') < f.events.indexOf('checkpoint:create:preparing'));
  assert.ok(f.events.indexOf('checkpoint:create:preparing') < f.events.indexOf('barrier:checkpointed:after-phase-persist'));
});

test('a source change after revalidation but before checkpoint publish is rejected from its ready manifest', async () => {
  const f = migrationFixture({
    onBarrier: (event) => {
      if (event.phase === 'preparing' && event.boundary === 'after-phase-persist') {
        writeFileSync(join(f.instanceRoot, 'settings.js'), 'changed-after-revalidation');
      }
    },
  });

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.admin.installCalls, 0);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  assert.equal(existsSync(stoppedAuthorityPath(f)), false);
});

test('fresh staging is journaled before the POST barrier and an interrupted-before-POST rollback is clean', async () => {
  const f = migrationFixture({
    barrierFailure: { phase: 'staged', boundary: 'after-phase-persist' },
  });

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.admin.installCalls, 0);
  assert.equal(f.admin.uninstallCalls, 0);
  assert.equal(f.repo.nodeMigration('line-a')?.stagedBefore, false);
});

test('preflight and journal projections never persist inspected secrets or external error text', async () => {
  const f = migrationFixture({
    barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' },
  });
  await f.service.migrate('line-a', 'admin');
  const journal = f.db.prepare(
    'SELECT snapshot_json, error FROM instance_node_migration WHERE instance_id = ?',
  ).get('line-a') as { snapshot_json: string; error: string };
  const projection = f.db.prepare(
    'SELECT node_migration_error FROM instance WHERE id = ?',
  ).get('line-a') as { node_migration_error: string };
  const audits = f.db.prepare('SELECT detail FROM audit WHERE target = ?').all('line-a') as Array<{ detail: string }>;
  const persisted = JSON.stringify({ journal, projection, audits });
  assert.doesNotMatch(
    persisted,
    /db-ingest-token-value|db-password|render-only-secret|barrier-secret|registryAuth|credential-bytes/,
  );
  assert.match(journal.snapshot_json, /legacyManifestSha256/);
  assert.match(journal.snapshot_json, /nodeInventorySha256/);
});

test('fixture uses exactly the canonical seven raw paths', () => {
  const f = migrationFixture();
  assert.deepEqual(
    readdirSync(join(f.instanceRoot, 'nodes')).sort(),
    Object.keys(LEGACY_PLATFORM_FILES).sort(),
  );
});

test('running migration checkpoints, stages once, cuts over, verifies, and commits atomically', async () => {
  const f = migrationFixture({ originalRunning: true });
  const flowBefore = sha256(readFileSync(join(f.instanceRoot, 'flows.json')));
  const credentialsBefore = sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json')));

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'committed');
  assert.equal(result.runtimeMode, 'npm');
  assert.equal(result.platformVersion, PLATFORM_NODE_PACKAGE.version);
  assert.doesNotMatch(JSON.stringify(result), /execution|owner-tx-01/i);
  assert.equal(f.repo.nodeRuntime('line-a')?.mode, 'npm');
  assert.equal(f.repo.nodeRuntime('line-a')?.platformVersion, PLATFORM_NODE_PACKAGE.version);
  assert.equal(f.admin.installCalls, 1);
  assert.equal(f.packages.calls, 3);
  assert.deepEqual(f.docker.runtimeCalls, ['write-settings', 'restart']);
  assert.deepEqual(
    f.docker.settingsWrites.at(-1)?.nodesExcludes.filter((path) => path.startsWith('tl-')),
    [...LEGACY_RUNTIME_EXCLUDES],
  );
  assert.equal(sha256(readFileSync(join(f.instanceRoot, 'flows.json'))), flowBefore);
  assert.equal(sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json'))), credentialsBefore);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'commit-node-migration' AND target = ? AND result = 'ok'",
    ).get('line-a') as { n: number }).n,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(f.db.prepare('SELECT detail FROM audit WHERE target = ?').all('line-a')),
    /owner-tx-01/i,
  );
  assert.deepEqual(
    f.events
      .filter((event) => event.startsWith('barrier:') && event.endsWith(':after-phase-persist'))
      .map((event) => event.split(':')[1]),
    ['preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'committed'],
  );
  assert.deepEqual(
    f.repo.nodeMigrations().map((journal) => [journal.instanceId, journal.phase]),
    [['line-a', 'committed']],
  );
});

test('stopped migration verifies an isolated probe, applies allowlisted state, and parks ownerless', async () => {
  const f = migrationFixture({ originalRunning: false });
  const flowBefore = sha256(readFileSync(join(f.instanceRoot, 'flows.json')));

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'pending_start_verification', JSON.stringify({ result, events: f.events, runtime: f.docker.runtimeCalls }));
  assert.equal(result.runtimeMode, 'legacy');
  assert.equal(f.repo.nodeMigration('line-a')?.executionOwner, '');
  assert.equal(f.repo.nodeMigration('line-a')?.executionLeaseExpiresAt, 0);
  assert.equal(f.docker.inspection.running, false);
  assert.equal(sha256(readFileSync(join(f.instanceRoot, 'flows.json'))), flowBefore);
  assert.deepEqual(f.docker.runtimeCalls, [
    'probe-create', 'probe-write-settings', 'probe-restart', 'probe-cleanup',
  ]);
  assert.equal(existsSync(join(f.instanceRoot, 'node_modules', '@mqttsnet', 'thinglinks-edge-nodes')), true);
  assert.equal(existsSync(join(f.root, '.thinglinks-probes', 'line-a', 'tx-01')), false);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(existsSync(stoppedAuthorityPath(f)), true);
});

test('explicit pending start claims once, starts once, verifies, commits, and removes rollback evidence', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const startsBefore = f.docker.runtimeCalls.filter((call) => call === 'start').length;

  const completed = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(completed.phase, 'committed');
  assert.equal(f.repo.nodeRuntime('line-a')?.mode, 'npm');
  assert.equal(
    f.docker.runtimeCalls.filter((call) => call === 'start').length,
    startsBefore + 1,
  );
  assert.equal(f.repo.nodeMigration('line-a')?.executionOwner, '');
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  assert.equal(existsSync(stoppedAuthorityPath(f)), false);
  assert.equal(
    readdirSync(f.instanceRoot).some((name) => name.includes('.tle-tx-01.')),
    false,
  );
});

test('C35 crash immediately after atomic pending claim is recoverable before production start', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  f.controls.barrierFailure = {
    phase: 'verifying',
    boundary: 'after-phase-persist',
  };
  const startsBefore = f.docker.runtimeCalls.filter((call) => call === 'start').length;

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'start').length, startsBefore);
  assert.equal(f.docker.inspection.running, false);
});

test('C35 fresh service waits for claimed verifying owner expiry then recovers without a start', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const journal = f.repo.nodeMigration('line-a')!;
  const claimed = f.repo.claimPendingStartVerifyingExact(
    'line-a', journal.txId, 'owner-crashed-pending-start-0001',
    f.time.now(), 1_000,
  );
  assert.equal(claimed?.phase, 'verifying');
  const effectsBefore = [...f.docker.runtimeCalls];
  const reopened = reopenMigrationFixture(f);

  const recovery = reopened.service.recoverInterrupted();
  assert.equal(f.time.pendingSleeps, 1);
  f.time.advance(1_000);
  const result = await recovery;

  assert.deepEqual(result.map((entry) => entry.phase), ['rolled_back']);
  assert.equal(f.docker.inspection.running, false);
  assert.equal(
    f.docker.runtimeCalls.filter((effect) => effect === 'start').length,
    effectsBefore.filter((effect) => effect === 'start').length,
  );
  reopened.db.close();
});

test('pending start verification failure restores the immutable checkpoint and leaves production stopped', async () => {
  const f = migrationFixture({ originalRunning: false });
  const settingsBefore = sha256(readFileSync(join(f.instanceRoot, 'settings.js')));
  const packageBefore = sha256(readFileSync(join(f.instanceRoot, 'package.json')));
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const unhealthy = healthyPlatformInventory();
  unhealthy.enabled = false;
  unhealthy.health = 'failed';
  unhealthy.errors = ['load_failed'];
  unhealthy.nodeSets[0] = {
    ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed',
  };
  f.admin.afterRestart = unhealthy;

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.docker.inspection.running, false);
  assert.equal(sha256(readFileSync(join(f.instanceRoot, 'settings.js'))), settingsBefore);
  assert.equal(sha256(readFileSync(join(f.instanceRoot, 'package.json'))), packageBefore);
  assert.equal(f.repo.nodeRuntime('line-a')?.mode, 'legacy');
});

test('C37 stopped evidence ownership is verified before the pending-start commit', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  let observedPhase = '';
  (f.service as unknown as {
    verifyStoppedEvidenceOwned(instanceId: string, txId: string): Promise<void>;
  }).verifyStoppedEvidenceOwned = async () => {
    observedPhase = f.repo.nodeMigration('line-a')?.phase ?? '';
    throw new Error('owned evidence verification failed');
  };

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(observedPhase, 'verifying');
  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.docker.inspection.running, false);
});

test('C37 committed recovery retries stopped evidence cleanup before checkpoint cleanup', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const originalCleanup = (f.service as unknown as {
    cleanupStoppedEvidence(instanceId: string, txId: string): Promise<void>;
  }).cleanupStoppedEvidence.bind(f.service);
  let failures = 1;
  (f.service as unknown as {
    cleanupStoppedEvidence(instanceId: string, txId: string): Promise<void>;
  }).cleanupStoppedEvidence = async (instanceId, txId) => {
    if (failures-- > 0) {
      rmSync(join(f.instanceRoot, `.settings.js.tle-${txId}.backup`));
      throw new Error('credential sidecar cleanup failed after partial progress');
    }
    await originalCleanup(instanceId, txId);
  };

  const committed = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));
  assert.equal(committed.phase, 'committed');
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(existsSync(stoppedAuthorityPath(f)), true);
  assert.ok(readdirSync(f.instanceRoot).some((entry) => entry.includes('.tle-tx-01.')));
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'stopped_evidence_cleanup_pending'",
    ).get() as { n: number }).n,
    1,
  );

  const freshGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(f.repo));
  const freshService = f.createService(f.repo, freshGate, 'tx-fresh-recovery');
  await freshService.recoverInterrupted();
  assert.equal(readdirSync(f.instanceRoot).some((entry) => entry.includes('.tle-tx-01.')), false);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  assert.equal(existsSync(stoppedAuthorityPath(f)), false);
});

test('C37 tampered stopped backup blocks commit and retains evidence for manual recovery', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const backup = join(f.instanceRoot, '.settings.js.tle-tx-01.backup');
  writeFileSync(backup, 'foreign-backup', { mode: 0o600 });

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'manual_required');
  assert.equal(f.docker.inspection.running, false);
  assert.equal(readFileSync(backup, 'utf8'), 'foreign-backup');
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(existsSync(stoppedAuthorityPath(f)), true);
});

test('C44 rollback terminal audit failure retains stopped authority, sidecars, and checkpoint', async () => {
  const f = migrationFixture({ originalRunning: false });
  const settingsBefore = sha256(readFileSync(join(f.instanceRoot, 'settings.js')));
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const unhealthy = healthyPlatformInventory();
  unhealthy.enabled = false;
  unhealthy.health = 'failed';
  unhealthy.errors = ['load_failed'];
  unhealthy.nodeSets[0] = {
    ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed',
  };
  f.admin.afterRestart = unhealthy;
  f.db.exec(`CREATE TRIGGER reject_c44_rollback_terminal_audit
    BEFORE INSERT ON audit
    WHEN NEW.action = 'rollback-node-migration'
    BEGIN SELECT RAISE(ABORT, 'C44 rollback terminal audit rejected'); END;`);

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'manual_required');
  assert.notEqual(result.phase, 'rolled_back_dirty');
  assert.equal(result.runtimeMode, 'legacy');
  assert.equal(f.docker.inspection.running, false);
  assert.equal(sha256(readFileSync(join(f.instanceRoot, 'settings.js'))), settingsBefore);
  assert.equal(existsSync(join(stoppedAuthorityPath(f), 'manifest.json')), true);
  assert.ok(txSidecars(f.instanceRoot, 'tx-01').length > 0);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'stopped_rollback_cleanup_pending'",
    ).get() as { n: number }).n,
    0,
  );
});

test('C44 authority cleanup failure after manifest unlink stays rolled_back and fresh recovery finishes', async () => {
  const f = migrationFixture({
    originalRunning: false,
    onBarrier: (event) => {
      if (event.phase === 'rolled_back' && event.boundary === 'after-phase-persist') {
        writeFileSync(join(stoppedAuthorityPath(f), 'cleanup-blocker'), 'retry later\n', {
          mode: 0o600,
        });
      }
    },
  });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const unhealthy = healthyPlatformInventory();
  unhealthy.enabled = false;
  unhealthy.health = 'failed';
  unhealthy.errors = ['load_failed'];
  unhealthy.nodeSets[0] = {
    ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed',
  };
  f.admin.afterRestart = unhealthy;

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  const authorityRoot = stoppedAuthorityPath(f);
  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.repo.nodeMigration('line-a')?.error, 'none');
  assert.deepEqual(txSidecars(f.instanceRoot, 'tx-01'), []);
  assert.equal(existsSync(authorityRoot), true);
  assert.equal(existsSync(join(authorityRoot, 'manifest.json')), false);
  assert.equal(existsSync(join(authorityRoot, 'cleanup-blocker')), true);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.deepEqual(
    f.db.prepare(
      `SELECT action, detail, result FROM audit
       WHERE action = 'stopped_rollback_cleanup_pending'`,
    ).all(),
    [{
      action: 'stopped_rollback_cleanup_pending',
      detail: '{"code":"stopped_rollback_cleanup_pending"}',
      result: 'fail',
    }],
  );

  rmSync(join(authorityRoot, 'cleanup-blocker'));
  const reopened = reopenMigrationFixture(f);
  assert.deepEqual(
    (await reopened.service.recoverInterrupted()).map((entry) => entry.phase),
    ['rolled_back'],
  );
  await reopened.service.recoverInterrupted();
  assert.equal(existsSync(authorityRoot), false);
  assert.deepEqual(txSidecars(f.instanceRoot, 'tx-01'), []);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  reopened.db.close();
});

test('C44 stopped terminal cleanup gates authority and checkpoint behind sidecar success', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const cleanupPort = f.service as unknown as {
    cleanupStoppedEvidence(
      instanceId: string,
      txId: string,
      phase?: 'committed' | 'rolled_back',
    ): Promise<void>;
  };
  const cleanupStoppedEvidence = cleanupPort.cleanupStoppedEvidence.bind(f.service);
  let failSidecars = true;
  cleanupPort.cleanupStoppedEvidence = async (instanceId, txId, phase) => {
    assert.equal(f.repo.nodeMigration(instanceId)?.phase, 'rolled_back');
    assert.equal(phase, 'rolled_back');
    if (failSidecars) {
      failSidecars = false;
      throw new Error('token=sidecar-cleanup-secret');
    }
    await cleanupStoppedEvidence(instanceId, txId, phase);
  };
  const unhealthy = healthyPlatformInventory();
  unhealthy.enabled = false;
  unhealthy.health = 'failed';
  unhealthy.errors = ['load_failed'];
  unhealthy.nodeSets[0] = {
    ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed',
  };
  f.admin.afterRestart = unhealthy;

  const rolledBack = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  const authorityRoot = stoppedAuthorityPath(f);
  assert.equal(rolledBack.phase, 'rolled_back');
  assert.ok(txSidecars(f.instanceRoot, 'tx-01').length > 0);
  assert.equal(existsSync(join(authorityRoot, 'manifest.json')), true);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'checkpoint_cleanup_pending'",
    ).get() as { n: number }).n,
    0,
  );

  writeFileSync(join(authorityRoot, 'cleanup-blocker'), 'retry later\n', { mode: 0o600 });
  const freshGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(f.repo));
  const freshService = f.createService(f.repo, freshGate, 'tx-c44-fresh');
  await freshService.recoverInterrupted();
  assert.deepEqual(txSidecars(f.instanceRoot, 'tx-01'), []);
  assert.equal(existsSync(authorityRoot), true);
  assert.equal(existsSync(join(authorityRoot, 'manifest.json')), false);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'stopped_rollback_cleanup_pending'",
    ).get() as { n: number }).n,
    1,
  );

  rmSync(join(authorityRoot, 'cleanup-blocker'));
  f.controls.cleanupFailure = true;
  await freshService.recoverInterrupted();
  assert.deepEqual(txSidecars(f.instanceRoot, 'tx-01'), []);
  assert.equal(existsSync(authorityRoot), false);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'checkpoint_cleanup_pending'",
    ).get() as { n: number }).n,
    0,
  );
  assert.doesNotMatch(
    JSON.stringify(f.db.prepare(
      "SELECT detail FROM audit WHERE action = 'stopped_rollback_cleanup_pending'",
    ).all()),
    /sidecar-cleanup-secret|token=/i,
  );

  f.controls.cleanupFailure = false;
  await freshService.recoverInterrupted();
  await freshService.recoverInterrupted();
  assert.equal(f.repo.nodeMigration('line-a')?.phase, 'rolled_back');
  assert.deepEqual(txSidecars(f.instanceRoot, 'tx-01'), []);
  assert.equal(existsSync(authorityRoot), false);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'stopped_rollback_cleanup_pending'",
    ).get() as { n: number }).n,
    1,
  );
});

test('stopped live apply covers all four file/directory states without overwriting nonempty targets', async () => {
  const f = migrationFixture({ originalRunning: false, preexisting: true });
  writeFileSync(join(f.instanceRoot, '.config.modules.json.backup'), 'delete-on-cutover', { mode: 0o640 });
  f.docker.afterProbeRestart = (probeRoot) => {
    rmSync(join(probeRoot, '.config.modules.json.backup'));
    writeFileSync(join(probeRoot, '.config.nodes.json.backup'), 'create-on-cutover', { mode: 0o600 });
    writeFileSync(join(
      probeRoot, 'node_modules', '@mqttsnet', 'thinglinks-edge-nodes', 'probe-only.txt',
    ), 'directory-swap', { mode: 0o600 });
  };

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'pending_start_verification', JSON.stringify({ result, events: f.events, runtime: f.docker.runtimeCalls }));
  assert.equal(readFileSync(join(f.instanceRoot, '.config.nodes.json.backup'), 'utf8'), 'create-on-cutover');
  assert.equal(existsSync(join(f.instanceRoot, '.config.modules.json.backup')), false);
  assert.equal(readFileSync(join(
    f.instanceRoot, 'node_modules', '@mqttsnet', 'thinglinks-edge-nodes', 'probe-only.txt',
  ), 'utf8'), 'directory-swap');
  const liveEvents = f.barrierEvents.filter((event) => (
    event.boundary === 'after-live-backup' || event.boundary === 'after-live-rename'
  ));
  assert.ok(liveEvents.length >= 4);
  assert.ok(liveEvents.every((event) => event.artifact));
  assert.ok(liveEvents.every((event, index) => index === 0 || event.sequence > liveEvents[index - 1]!.sequence));
});

for (const artifact of ['edge-module', 'common-module'] as const) {
  for (const boundary of ['after-live-backup', 'after-live-rename'] as const) {
    test(`equal ${artifact} cleanup crash at ${boundary} never deletes the preexisting directory`, async () => {
      const f = migrationFixture({
        originalRunning: false,
        preexisting: true,
        barrierFailure: { phase: 'verifying', boundary, artifact },
      });
      const relative = artifact === 'edge-module'
        ? join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'))
        : join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
      const before = sha256(readFileSync(join(f.instanceRoot, relative, 'package.json')));

      assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
      const result = await f.gate.run('line-a', 'start-instance', (lease) => (
        f.service.completePendingStartUnderLease('line-a', lease, 'admin')
      ));

      assert.equal(result.phase, 'rolled_back');
      assert.equal(sha256(readFileSync(join(f.instanceRoot, relative, 'package.json'))), before);
      assert.equal(f.docker.inspection.running, false);
      assert.ok(f.barrierEvents.some((event) => (
        event.phase === 'verifying' && event.boundary === boundary && event.artifact === artifact
      )));
    });
  }
}

test('C41 equal Edge and common desired manifests and partials survive until explicit start', async () => {
  const f = migrationFixture({ originalRunning: false, preexisting: true });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  for (const packageName of [PLATFORM_NODE_PACKAGE.name, PLATFORM_COMMON_PACKAGE.name]) {
    const packageDir = join(f.instanceRoot, 'node_modules', ...packageName.split('/'));
    const parent = dirname(packageDir);
    const base = basename(packageDir);
    assert.equal(existsSync(join(parent, `.${base}.tle-tx-01.manifest`)), true, packageName);
    assert.equal(existsSync(join(parent, `.${base}.tle-tx-01.partial`)), true, packageName);
  }
});

for (const fault of ['missing', 'tampered'] as const) {
  for (const matrix of ['settings', 'creation', 'deletion', 'replacement', 'equal-common'] as const) {
    test(`C41 ${fault} desired manifest rejects ${matrix} before commit`, async () => {
      const f = migrationFixture({ originalRunning: false, preexisting: true });
      writeFileSync(
        join(f.instanceRoot, '.config.modules.json.backup'),
        'delete-on-cutover',
        { mode: 0o640 },
      );
      f.docker.afterProbeRestart = (probeRoot) => {
        rmSync(join(probeRoot, '.config.modules.json.backup'));
        writeFileSync(
          join(probeRoot, '.config.nodes.json.backup'),
          'create-on-cutover',
          { mode: 0o600 },
        );
        writeFileSync(join(
          probeRoot, 'node_modules', '@mqttsnet', 'thinglinks-edge-nodes', 'replacement.txt',
        ), 'replacement', { mode: 0o600 });
      };
      assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
      const manifests = {
        settings: join(f.instanceRoot, '.settings.js.tle-tx-01.manifest'),
        creation: join(f.instanceRoot, '..config.nodes.json.backup.tle-tx-01.manifest'),
        deletion: join(f.instanceRoot, '..config.modules.json.backup.tle-tx-01.manifest'),
        replacement: join(
          f.instanceRoot, 'node_modules', '@mqttsnet',
          '.thinglinks-edge-nodes.tle-tx-01.manifest',
        ),
        'equal-common': join(
          f.instanceRoot, 'node_modules', '@mqttsnet',
          '.thinglinks-node-red-common.tle-tx-01.manifest',
        ),
      } as const;
      const selected = manifests[matrix];
      if (fault === 'missing') rmSync(selected, { force: true });
      else writeFileSync(selected, `${JSON.stringify({
        key: matrix === 'settings' ? 'settings.js' : `tampered-${matrix}`,
        exists: true,
        kind: 'file',
        mode: 0o600,
        sha256: 'f'.repeat(64),
      })}\n`, { mode: 0o600 });

      const result = await f.gate.run('line-a', 'start-instance', (lease) => (
        f.service.completePendingStartUnderLease('line-a', lease, 'admin')
      ));

      assert.notEqual(result.phase, 'committed', `${fault}/${matrix}`);
      assert.equal(f.docker.inspection.running, false, `${fault}/${matrix}`);
      assert.equal(
        (f.db.prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE action = 'commit-node-migration' AND target = 'line-a'",
        ).get() as { n: number }).n,
        0,
        `${fault}/${matrix}`,
      );
    });
  }
}

test('C41 post-start settings and node-config drift is rejected before backup deletion', async () => {
  const f = migrationFixture({ originalRunning: false });
  const settingsBefore = sha256(readFileSync(join(f.instanceRoot, 'settings.js')));
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const backup = join(f.instanceRoot, '.settings.js.tle-tx-01.backup');
  f.docker.afterStart = () => {
    writeFileSync(join(f.instanceRoot, 'settings.js'), 'flow-mutated-settings', { mode: 0o600 });
    writeFileSync(join(f.instanceRoot, '.config.nodes.json'), '{"flow":"mutated"}\n', { mode: 0o600 });
  };

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'manual_required');
  assert.equal(f.docker.inspection.running, false);
  assert.equal(sha256(readFileSync(backup)), settingsBefore);
  assert.equal(existsSync(join(f.instanceRoot, '.settings.js.tle-tx-01.backup-manifest')), true);
});

test('C41 first post-commit cleanup never uses permissive retry rules for a missing desired manifest', async () => {
  const f = migrationFixture({
    originalRunning: false,
    onBarrier: (event) => {
      if (event.phase === 'committed' && event.boundary === 'after-phase-persist') {
        rmSync(join(f.instanceRoot, '.settings.js.tle-tx-01.manifest'));
      }
    },
  });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'committed');
  assert.equal(existsSync(join(f.instanceRoot, '.settings.js.tle-tx-01.backup')), true);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'stopped_evidence_cleanup_pending'",
    ).get() as { n: number }).n,
    1,
  );

  const reopened = reopenMigrationFixture(f);
  await reopened.service.recoverInterrupted();
  assert.equal(existsSync(join(f.instanceRoot, '.settings.js.tle-tx-01.backup')), true);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  reopened.db.close();
});

test('C42 forged settings and config plus matching in-bind desired facts cannot commit', async () => {
  const f = migrationFixture({ originalRunning: false });
  f.docker.afterProbeRestart = (probeRoot) => {
    writeFileSync(join(probeRoot, '.config.nodes.json'), '{"probe":"desired"}\n', { mode: 0o600 });
  };
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const settingsBackup = join(f.instanceRoot, '.settings.js.tle-tx-01.backup');
  const configBackup = join(f.instanceRoot, '..config.nodes.json.tle-tx-01.backup');
  const settingsBefore = sha256(readFileSync(settingsBackup));
  const configBefore = sha256(readFileSync(configBackup));
  f.docker.afterStart = () => {
    writeFileSync(
      join(f.instanceRoot, 'settings.js'),
      'module.exports={flowOwned:true};\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(f.instanceRoot, '.config.nodes.json'),
      '{"flow":"forged"}\n', { mode: 0o600 },
    );
    writeForgedDesiredSidecar(f.instanceRoot, 'tx-01', 'settings.js');
    writeForgedDesiredSidecar(f.instanceRoot, 'tx-01', '.config.nodes.json');
  };

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'manual_required');
  assert.equal(f.docker.inspection.running, false);
  assert.equal(sha256(readFileSync(settingsBackup)), settingsBefore);
  assert.equal(sha256(readFileSync(configBackup)), configBefore);
  assert.equal(existsSync(stoppedAuthorityPath(f)), true);
});

test('C42 forged Edge and common trees plus matching in-bind desired facts cannot commit', async () => {
  const f = migrationFixture({ originalRunning: false, preexisting: true });
  const edgeKey = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
  const commonKey = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
  f.docker.afterProbeRestart = (probeRoot) => {
    writeFileSync(join(probeRoot, edgeKey, 'probe-desired.js'), 'probe edge\n', { mode: 0o600 });
    writeFileSync(join(probeRoot, commonKey, 'probe-desired.js'), 'probe common\n', { mode: 0o600 });
  };
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const edgeTarget = join(f.instanceRoot, edgeKey);
  const commonTarget = join(f.instanceRoot, commonKey);
  const edgeBackup = join(dirname(edgeTarget), '.thinglinks-edge-nodes.tle-tx-01.backup');
  const commonBackup = join(dirname(commonTarget), '.thinglinks-node-red-common.tle-tx-01.backup');
  const edgeBefore = testArtifactFact(dirname(edgeBackup), basename(edgeBackup));
  const commonBefore = testArtifactFact(dirname(commonBackup), basename(commonBackup));
  f.docker.afterStart = () => {
    writeFileSync(join(edgeTarget, 'flow-forged.js'), 'flow edge\n', { mode: 0o600 });
    writeFileSync(join(commonTarget, 'flow-forged.js'), 'flow common\n', { mode: 0o600 });
    writeForgedDesiredSidecar(f.instanceRoot, 'tx-01', edgeKey);
    writeForgedDesiredSidecar(f.instanceRoot, 'tx-01', commonKey);
  };

  const result = await f.gate.run('line-a', 'start-instance', (lease) => (
    f.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ));

  assert.equal(result.phase, 'manual_required');
  assert.equal(f.docker.inspection.running, false);
  assert.deepEqual(testArtifactFact(dirname(edgeBackup), basename(edgeBackup)), edgeBefore);
  assert.deepEqual(testArtifactFact(dirname(commonBackup), basename(commonBackup)), commonBefore);
  assert.equal(existsSync(stoppedAuthorityPath(f)), true);
});

test('C42 Manager-only authority is complete, tx-bound, and permission restricted', async () => {
  const f = migrationFixture({ originalRunning: false });

  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');

  const authorityRoot = stoppedAuthorityPath(f);
  const evidenceRoot = dirname(dirname(authorityRoot));
  const instanceEvidenceRoot = dirname(authorityRoot);
  const manifestPath = join(authorityRoot, 'manifest.json');
  assert.equal(lstatSync(evidenceRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(instanceEvidenceRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(authorityRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(manifestPath).isFile(), true);
  assert.equal(lstatSync(manifestPath).isSymbolicLink(), false);
  assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
  const authority = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: number;
    instanceId: string;
    txId: string;
    targetIntegrity: string;
    artifacts: Array<{ key: string; desired: TestArtifactFact; prior: TestArtifactFact }>;
  };
  assert.deepEqual(
    {
      version: authority.version,
      instanceId: authority.instanceId,
      txId: authority.txId,
      targetIntegrity: authority.targetIntegrity,
    },
    {
      version: 1,
      instanceId: 'line-a',
      txId: 'tx-01',
      targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    },
  );
  assert.deepEqual(authority.artifacts.map((artifact) => artifact.key), [
    'settings.js',
    'package.json',
    'package-lock.json',
    '.config.nodes.json',
    '.config.nodes.json.backup',
    '.config.modules.json',
    '.config.modules.json.backup',
    join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/')),
    join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/')),
  ]);
  for (const artifact of authority.artifacts) {
    assert.equal(artifact.desired.key, artifact.key);
    assert.equal(artifact.prior.key, artifact.key);
  }
});

test('C42 fresh startup marks tampered pending authority manual without destructive cleanup', async () => {
  const f = migrationFixture({ originalRunning: false });
  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const authorityRoot = stoppedAuthorityPath(f);
  const authority = join(authorityRoot, 'manifest.json');
  const backup = join(f.instanceRoot, '.settings.js.tle-tx-01.backup');
  const backupBefore = sha256(readFileSync(backup));
  const runtimeBeforeRecovery = [...f.docker.runtimeCalls];
  writeFileSync(authority, '{"tampered":true}\n', { mode: 0o600 });

  const reopened = reopenMigrationFixture(f);
  const recovered = await reopened.service.recoverInterrupted();

  assert.deepEqual(recovered.map((entry) => entry.phase), ['manual_required']);
  assert.equal(reopened.repo.nodeMigration('line-a')?.executionOwner, '');
  assert.equal(f.docker.inspection.running, false);
  assert.deepEqual(f.docker.runtimeCalls, runtimeBeforeRecovery);
  assert.equal(sha256(readFileSync(backup)), backupBefore);
  assert.equal(existsSync(authorityRoot), true);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  reopened.db.close();
});

for (const fault of [
  'missing',
  'tampered',
  'schema',
  'manifest-mode',
  'directory-mode',
  'manifest-symlink',
  'directory-symlink',
] as const) {
  test(`C42 ${fault} Manager-only authority blocks start and preserves rollback evidence`, async () => {
    const f = migrationFixture({ originalRunning: false });
    assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
    const authorityRoot = stoppedAuthorityPath(f);
    const authority = join(authorityRoot, 'manifest.json');
    assert.equal(existsSync(authority), true);
    if (fault === 'missing') rmSync(authorityRoot, { recursive: true, force: true });
    if (fault === 'tampered') writeFileSync(authority, '{"tampered":true}\n', { mode: 0o600 });
    if (fault === 'schema') {
      const value = JSON.parse(readFileSync(authority, 'utf8')) as Record<string, unknown>;
      value['unexpected'] = true;
      writeFileSync(authority, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    }
    if (fault === 'manifest-mode') chmodSync(authority, 0o644);
    if (fault === 'directory-mode') chmodSync(authorityRoot, 0o755);
    if (fault === 'manifest-symlink') {
      rmSync(authority);
      symlinkSync(join(f.instanceRoot, 'settings.js'), authority);
    }
    let outsideAuthority: string | undefined;
    if (fault === 'directory-symlink') {
      outsideAuthority = join(f.root, 'outside-authority');
      mkdirSync(outsideAuthority, { mode: 0o700 });
      rmSync(authorityRoot, { recursive: true, force: true });
      symlinkSync(outsideAuthority, authorityRoot);
    }
    const backup = join(f.instanceRoot, '.settings.js.tle-tx-01.backup');
    const before = sha256(readFileSync(backup));
    const runtimeBeforeStart = [...f.docker.runtimeCalls];

    const result = await f.gate.run('line-a', 'start-instance', (lease) => (
      f.service.completePendingStartUnderLease('line-a', lease, 'admin')
    ));

    assert.equal(result.phase, 'manual_required', fault);
    assert.equal(f.docker.inspection.running, false, fault);
    assert.deepEqual(f.docker.runtimeCalls, runtimeBeforeStart, fault);
    assert.equal(sha256(readFileSync(backup)), before, fault);
    assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true, fault);
    if (outsideAuthority) assert.deepEqual(readdirSync(outsideAuthority), [], fault);
  });
}

test('stopped export ignores settings/package/lock backup variants exactly', async () => {
  const f = migrationFixture({ originalRunning: false });
  const ignored = ['settings.js.backup', 'package.json.backup', 'package-lock.json.backup'] as const;
  for (const path of ignored) writeFileSync(join(f.instanceRoot, path), `live-${path}`, { mode: 0o600 });
  f.docker.afterProbeRestart = (probeRoot) => {
    for (const path of ignored) writeFileSync(join(probeRoot, path), `probe-${path}`, { mode: 0o600 });
  };

  assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');

  for (const path of ignored) {
    assert.equal(readFileSync(join(f.instanceRoot, path), 'utf8'), `live-${path}`);
    assert.equal(
      readdirSync(f.instanceRoot).some((entry) => entry.includes(`${path}.tle-tx-01`)),
      false,
    );
  }
});

for (const drift of ['hash', 'mode', 'existence', 'type', 'symlink', 'directory-hash'] as const) {
  test(`prepared stopped partial ${drift} drift is rejected before the first live mutation`, async () => {
    const f = migrationFixture({
      originalRunning: false,
      onBarrier: (event) => {
        if (event.phase !== 'cutover' || event.boundary !== 'after-phase-persist') return;
        const settingsPartial = join(f.instanceRoot, '.settings.js.tle-tx-01.partial');
        if (drift === 'hash') writeFileSync(settingsPartial, 'tampered-partial', { mode: 0o600 });
        if (drift === 'mode') chmodSync(settingsPartial, 0o644);
        if (drift === 'existence') rmSync(settingsPartial);
        if (drift === 'type') {
          rmSync(settingsPartial);
          mkdirSync(settingsPartial);
        }
        if (drift === 'symlink') {
          rmSync(settingsPartial);
          symlinkSync(join(f.instanceRoot, 'settings.js'), settingsPartial);
        }
        if (drift === 'directory-hash') {
          writeFileSync(join(
            f.instanceRoot,
            'node_modules',
            '@mqttsnet',
            '.thinglinks-edge-nodes.tle-tx-01.partial',
            'package.json',
          ), '{"tampered":true}\n', { mode: 0o600 });
        }
      },
    });
    const before = sha256(readFileSync(join(f.instanceRoot, 'settings.js')));

    const result = await f.service.migrate('line-a', 'admin');

    assert.equal(result.phase, 'manual_required', drift);
    assert.equal(sha256(readFileSync(join(f.instanceRoot, 'settings.js'))), before, drift);
    assert.equal(
      f.barrierEvents.some((event) => (
        event.boundary === 'after-live-backup' || event.boundary === 'after-live-rename'
      )),
      false,
      drift,
    );
  });
}

for (const boundary of ['after-live-backup', 'after-live-rename'] as const) {
  test(`stopped crash at ${boundary} restores checkpoint bytes and original stopped state`, async () => {
    const f = migrationFixture({
      originalRunning: false,
      barrierFailure: { phase: 'cutover', boundary },
    });
    const before = {
      settings: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))),
      package: sha256(readFileSync(join(f.instanceRoot, 'package.json'))),
      lock: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))),
    };

    const result = await f.service.migrate('line-a', 'admin');

    assert.equal(result.phase, 'rolled_back', JSON.stringify({ result, events: f.events, runtime: f.docker.runtimeCalls, files: readdirSync(f.instanceRoot) }));
    assert.equal(f.docker.inspection.running, false);
    assert.deepEqual({
      settings: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))),
      package: sha256(readFileSync(join(f.instanceRoot, 'package.json'))),
      lock: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))),
    }, before);
    assert.equal(existsSync(join(f.instanceRoot, 'node_modules', '@mqttsnet')), false);
  });
}

test('flow identity comes from flows.json: restored nonempty mismatches are manual and empty matches pass', async () => {
  for (const [name, adminFlows] of [
    ['empty', []],
    ['unrelated', [{ id: 'unrelated-flow', type: 'debug' }]],
  ] as const) {
    const changed = migrationFixture();
    changed.docker.afterRestart = () => {
      changed.admin.flowValue = adminFlows;
    };
    const result = await changed.service.migrate('line-a', 'admin');
    assert.equal(result.phase, 'manual_required', name);
    assert.equal(result.error, 'rollback', name);
  }

  const empty = migrationFixture();
  writeJson(join(empty.instanceRoot, 'flows.json'), []);
  empty.admin.flowValue = [];
  assert.equal((await empty.service.migrate('line-a', 'admin')).phase, 'committed');
});

test('post-start flow rewrites are reverified during rollback and require manual recovery', async () => {
  const f = migrationFixture();
  const unhealthy = healthyPlatformInventory();
  unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
  unhealthy.enabled = false;
  unhealthy.errors = ['load_failed'];
  unhealthy.health = 'failed';
  f.admin.afterRestart = unhealthy;
  f.docker.afterRestart = () => undefined;
  f.docker.afterStart = () => writeFileSync(
    join(f.instanceRoot, 'flows.json'),
    JSON.stringify([{ id: 'rewritten-after-rollback-start' }]),
  );

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'manual_required');
  assert.equal(result.error, 'rollback');
});

test('exact preexisting staged package skips install and still completes strict running verification', async () => {
  const f = migrationFixture({ preexisting: true });
  const result = await f.service.migrate('line-a', 'admin');
  assert.equal(result.phase, 'committed');
  assert.equal(f.admin.installCalls, 0);
  assert.equal(f.packages.calls, 2);
  assert.equal(f.repo.nodeMigration('line-a')?.stagedBefore, true);
  assert.equal(
    readFileSync(join(
      f.instanceRoot,
      'node_modules',
      ...PLATFORM_NODE_PACKAGE.name.split('/'),
      'package.json',
    ), 'utf8').includes(PLATFORM_NODE_PACKAGE.version),
    true,
  );
});

test('preexisting partial or integrity-mismatched package fails before cutover', async () => {
  {
    const f = migrationFixture({ preexisting: true });
    const lockPath = join(f.instanceRoot, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const edgeRelative = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
    lock.packages[edgeRelative]!['integrity'] = 'sha512-wrong';
    writeJson(lockPath, lock);
    await assert.rejects(
      () => f.service.migrate('line-a', 'admin'),
      (error: unknown) => error instanceof PlatformMigrationError && error.code === 'preflight',
    );
    assert.deepEqual(f.docker.runtimeCalls, []);
    assert.equal(f.admin.installCalls, 0);
  }
  {
    const f = migrationFixture();
    writeInstalledPackage(f.instanceRoot);
    await assert.rejects(
      () => f.service.migrate('line-a', 'admin'),
      (error: unknown) => error instanceof PlatformMigrationError && error.code === 'preflight',
    );
    assert.deepEqual(f.docker.runtimeCalls, []);
    assert.equal(f.admin.installCalls, 0);
  }
});

test('unexpected duplicate-type staging evidence still uninstalls the newly staged package before restore', async () => {
  const f = migrationFixture();
  f.admin.stagePlatformModule = async () => {
    f.admin.installCalls += 1;
    writeInstalledPackage(f.instanceRoot);
    f.state.staged = true;
    const invalid = stagedPlatformInventory();
    invalid.nodeSets[0] = { ...invalid.nodeSets[0]!, err: 'unexpected_duplicate_error' };
    invalid.errors = invalid.nodeSets.map((set) => set.err);
    f.admin.beforeModules = [rawPlatformInventory(), invalid];
    return invalid;
  };

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.admin.uninstallCalls, 1);
  assert.equal(
    existsSync(join(
      f.instanceRoot,
      'node_modules',
      ...PLATFORM_NODE_PACKAGE.name.split('/'),
      'package.json',
    )),
    false,
  );
});

test('an install that mutates then throws is durably owned and removed before rollback restore', async () => {
  const f = migrationFixture();
  f.admin.failAt = 'install-after-mutation';

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.admin.installCalls, 1);
  assert.equal(f.admin.uninstallCalls, 1);
  assert.equal(existsSync(join(
    f.instanceRoot,
    'node_modules',
    ...PLATFORM_NODE_PACKAGE.name.split('/'),
    'package.json',
  )), false);
});

test('partial uninstall residual is rolled_back_dirty before checkpoint restoration', async () => {
  const f = migrationFixture();
  f.admin.failAt = 'uninstall-partial';
  const unhealthy = healthyPlatformInventory();
  unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
  unhealthy.enabled = false;
  unhealthy.errors = ['load_failed'];
  unhealthy.health = 'failed';
  f.admin.afterRestart = unhealthy;

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolled_back_dirty');
  assert.equal(f.admin.uninstallCalls, 1);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
});

test('common-only root dependency, lock entry, or directory residual makes rollback dirty', async () => {
  const cases: Array<{
    name: string;
    leaveResidual: (instanceRoot: string) => void;
  }> = [
    {
      name: 'root dependency',
      leaveResidual: (instanceRoot) => writeJson(join(instanceRoot, 'package.json'), {
        name: 'line-a-runtime',
        dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
      }),
    },
    {
      name: 'lock entry',
      leaveResidual: (instanceRoot) => writeJson(join(instanceRoot, 'package-lock.json'), {
        packages: {
          '': { dependencies: {} },
          [join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'))]: {
            version: PLATFORM_COMMON_PACKAGE.version,
            integrity: PLATFORM_COMMON_PACKAGE.integrity,
          },
        },
      }),
    },
    {
      name: 'common directory',
      leaveResidual: (instanceRoot) => mkdirSync(join(
        instanceRoot,
        'node_modules',
        ...PLATFORM_COMMON_PACKAGE.name.split('/'),
      ), { recursive: true }),
    },
  ];

  for (const item of cases) {
    const f = migrationFixture();
    const unhealthy = healthyPlatformInventory();
    unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
    unhealthy.enabled = false;
    unhealthy.errors = ['load_failed'];
    unhealthy.health = 'failed';
    f.admin.afterRestart = unhealthy;
    f.admin.uninstallPlatformModule = async () => {
      f.admin.uninstallCalls += 1;
      removeInstalledPackage(f.instanceRoot);
      f.state.staged = false;
      f.admin.beforeModules = [rawPlatformInventory()];
      item.leaveResidual(f.instanceRoot);
    };

    const result = await f.service.migrate('line-a', 'admin');

    assert.equal(result.phase, 'rolled_back_dirty', item.name);
    assert.equal(f.admin.uninstallCalls, 1, item.name);
    assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true, item.name);
  }
});

test('every running failure boundary restores checkpoint bytes, legacy ownership, image, and running state', async () => {
  const cases: Array<{
    name: string;
    options?: FixtureOptions;
    inject?: (f: ReturnType<typeof migrationFixture>) => void;
  }> = [
    {
      name: 'after checkpoint',
      options: { barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' } },
    },
    {
      name: 'after stage',
      options: { barrierFailure: { phase: 'staged', boundary: 'after-phase-persist' } },
    },
    { name: 'settings write', inject: (f) => { f.docker.failAt = 'settings'; } },
    { name: 'restart', inject: (f) => { f.docker.failAt = 'restart'; } },
    { name: 'readiness', inject: (f) => { f.adminRuntime.failReadyTimes = 1; } },
    { name: 'ownership', inject: (f) => {
      f.admin.afterRestart = {
        ...healthyPlatformInventory(),
        module: 'third-party-node',
        version: '1.0.0',
        observedVersions: ['1.0.0'],
        types: [...PLATFORM_NODE_TYPES],
        nodeSets: PLATFORM_NODE_TYPES.map((type) => nodeSet('third-party-node', type, '1.0.0')),
      };
    } },
    { name: 'filesystem integrity', inject: (f) => {
      f.docker.afterRestart = () => writeFileSync(
        join(f.instanceRoot, 'package-lock.json'),
        '{"packages":{}}\n',
      );
    } },
    { name: 'runtime node-set health', inject: (f) => {
      const unhealthy = healthyPlatformInventory();
      unhealthy.nodeSets[0] = {
        ...unhealthy.nodeSets[0]!,
        enabled: false,
        err: 'load_failed',
      };
      unhealthy.enabled = false;
      unhealthy.errors = ['load_failed'];
      unhealthy.health = 'failed';
      f.admin.afterRestart = unhealthy;
    } },
    { name: 'existing flow health', inject: (f) => { f.admin.failAt = 'flows'; } },
  ];

  for (const item of cases) {
    const f = migrationFixture(item.options);
    item.inject?.(f);
    const settingsBefore = readFileSync(join(f.instanceRoot, 'settings.js'));
    const flowsBefore = readFileSync(join(f.instanceRoot, 'flows.json'));
    const credentialsBefore = readFileSync(join(f.instanceRoot, 'flows_cred.json'));

    const result = await f.service.migrate('line-a', 'admin');

    assert.equal(result.phase, 'rolled_back', item.name);
    assert.equal(result.runtimeMode, 'legacy', item.name);
    assert.equal(result.error, 'none', item.name);
    assert.deepEqual(readFileSync(join(f.instanceRoot, 'settings.js')), settingsBefore, item.name);
    assert.deepEqual(readFileSync(join(f.instanceRoot, 'flows.json')), flowsBefore, item.name);
    assert.deepEqual(
      readFileSync(join(f.instanceRoot, 'flows_cred.json')),
      credentialsBefore,
      item.name,
    );
    assert.equal(
      f.docker.inspection.imageId,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      item.name,
    );
    assert.equal(f.docker.inspection.running, true, item.name);
    assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false, item.name);
    assert.equal(
      (f.db.prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE action = 'rollback-node-migration' AND target = ?",
      ).get('line-a') as { n: number }).n,
      1,
      item.name,
    );
  }
});

test('rollback preserves an exact preexisting package and dirty cleanup never deletes it', async () => {
  const f = migrationFixture({ preexisting: true });
  const preservedPaths = [
    'package.json',
    'package-lock.json',
    join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'), 'package.json'),
    join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'), 'package.json'),
  ];
  const preserved = new Map(preservedPaths.map((path) => [
    path,
    readFileSync(join(f.instanceRoot, path)),
  ]));
  f.docker.failAt = 'settings';
  const result = await f.service.migrate('line-a', 'admin');
  assert.equal(result.phase, 'rolled_back');
  assert.equal(f.admin.uninstallCalls, 0);
  assert.equal(f.repo.nodeMigration('line-a')?.stagedBefore, true);
  for (const [path, bytes] of preserved) {
    assert.deepEqual(readFileSync(join(f.instanceRoot, path)), bytes, path);
  }
});

test('uninstall-only failure with restored raw service is rolled_back_dirty and retains checkpoint', async () => {
  const f = migrationFixture();
  const unhealthy = healthyPlatformInventory();
  unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
  unhealthy.enabled = false;
  unhealthy.errors = ['load_failed'];
  unhealthy.health = 'failed';
  f.admin.afterRestart = unhealthy;
  f.admin.failAt = 'uninstall';

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolled_back_dirty');
  assert.equal(result.runtimeMode, 'legacy');
  assert.equal(result.error, 'rollback');
  assert.equal(f.admin.uninstallCalls, 1);
  assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
  assert.equal(f.docker.inspection.running, true);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'rollback-node-migration' AND result = 'fail'",
    ).get() as { n: number }).n,
    1,
  );
});

test('missing or untrusted checkpoint and failed raw restart become manual_required with controlled audit', async () => {
  const cases: Array<{
    name: string;
    create: () => ReturnType<typeof migrationFixture>;
    inject: (f: ReturnType<typeof migrationFixture>) => void;
  }> = [
    {
      name: 'missing checkpoint',
      create: () => {
        const selected = migrationFixture({
          barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' },
          onBarrier: (event) => {
            if (event.phase === 'checkpointed') {
              rmSync(
                join(selected.root, '.thinglinks-migration', 'line-a', 'tx-01'),
                { recursive: true, force: true },
              );
            }
          },
        });
        return selected;
      },
      inject: () => undefined,
    },
    {
      name: 'raw restart failure',
      create: () => migrationFixture(),
      inject: (f) => {
        const unhealthy = healthyPlatformInventory();
        unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
        unhealthy.enabled = false;
        unhealthy.errors = ['load_failed'];
        unhealthy.health = 'failed';
        f.admin.afterRestart = unhealthy;
        f.docker.failAt = 'start';
      },
    },
  ];
  for (const item of cases) {
    const f = item.create();
    item.inject(f);
    const result = await f.service.migrate('line-a', 'admin');
    assert.equal(result.phase, 'manual_required', item.name);
    assert.equal(result.runtimeMode, 'legacy', item.name);
    assert.equal(result.error, 'rollback', item.name);
    assert.equal(
      (f.db.prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE action = 'manual-node-migration' AND target = ?",
      ).get('line-a') as { n: number }).n,
      1,
      item.name,
    );
  }
});

test('terminal cleanup failure records controlled audit and recoverInterrupted retries idempotently', async () => {
  for (const terminal of ['committed', 'rolled_back'] as const) {
    const f = migrationFixture({
      cleanupFailure: true,
      ...(terminal === 'rolled_back'
        ? { barrierFailure: { phase: 'checkpointed' as const, boundary: 'after-phase-persist' } }
        : {}),
    });
    const result = await f.service.migrate('line-a', 'admin');
    assert.equal(result.phase, terminal);
    assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), true);
    const audits = f.db.prepare(
      "SELECT detail FROM audit WHERE action = 'checkpoint_cleanup_pending' AND target = ?",
    ).all('line-a') as Array<{ detail: string }>;
    assert.deepEqual(audits, [{ detail: '{"code":"checkpoint_cleanup_pending"}' }]);
    assert.doesNotMatch(JSON.stringify(audits), /cleanup-secret|password|token/i);

    f.controls.cleanupFailure = false;
    await f.service.recoverInterrupted();
    await f.service.recoverInterrupted();
    assert.equal(await f.checkpoint.readyExists('line-a', 'tx-01'), false);
  }
});

test('recovery and public rollback finalize exact interrupted journals without reacquiring the durable gate', async () => {
  for (const phase of ['preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back'] as const) {
    const f = migrationFixture();
    await interruptedMigration(f, `tx-recover-${phase}`, phase);

    const result = await f.service.recoverInterrupted();

    assert.deepEqual(
      result.map((entry) => entry.phase),
      ['rolled_back'],
      `${phase}: ${JSON.stringify({ result, events: f.events, runtime: f.docker.runtimeCalls })}`,
    );
    assert.equal(f.repo.nodeMigration('line-a')?.phase, 'rolled_back', phase);
    assert.equal(await f.checkpoint.readyExists('line-a', `tx-recover-${phase}`), false, phase);
  }

  const f = migrationFixture();
  await interruptedMigration(f, 'tx-public-rollback', 'checkpointed');
  assert.equal((await f.service.rollback('line-a', new Error('operator requested'))).phase, 'rolled_back');
});

test('unified recovery awaits bootstrap compensation before scanning migration journals', async () => {
  let bootstrapDone = false;
  const f = migrationFixture({
    onBootstrapRecovery: async () => { bootstrapDone = true; },
    onBarrier: () => { assert.equal(bootstrapDone, true); },
  });
  await interruptedMigration(f, 'tx-after-bootstrap-recovery', 'checkpointed');

  const result = await f.service.recoverInterrupted();

  assert.deepEqual(result.map((entry) => entry.phase), ['rolled_back']);
  assert.equal(f.events[0], 'bootstrap-recovery');
});

test('startup recovery restores every stopped phase from the immutable checkpoint without starting production', async () => {
  for (const phase of [
    'preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back',
  ] as const) {
    const f = migrationFixture({ originalRunning: false });
    const txId = `tx-stopped-recover-${phase}`;
    if (['cutover', 'verifying', 'rolling_back'].includes(phase)) {
      writePriorCommonModule(f);
    }
    const before = {
      settings: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))),
      flows: sha256(readFileSync(join(f.instanceRoot, 'flows.json'))),
      credentials: sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json'))),
      package: sha256(readFileSync(join(f.instanceRoot, 'package.json'))),
      lock: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))),
    };
    await interruptedMigration(f, txId, phase, undefined, false);
    installPhaseRealisticStoppedEffects(f, txId, phase);

    const result = await f.service.recoverInterrupted();

    assert.deepEqual(
      result.map((entry) => entry.phase),
      ['rolled_back'],
      `${phase}: ${JSON.stringify({ result, events: f.events, runtime: f.docker.runtimeCalls, files: readdirSync(f.instanceRoot) })}`,
    );
    assert.equal(f.docker.inspection.running, false, phase);
    assert.equal(f.docker.runtimeCalls.includes('start'), false, phase);
    assert.deepEqual({
      settings: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))),
      flows: sha256(readFileSync(join(f.instanceRoot, 'flows.json'))),
      credentials: sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json'))),
      package: sha256(readFileSync(join(f.instanceRoot, 'package.json'))),
      lock: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))),
    }, before, phase);
  }
});

test('C34 stopped staged cutover and verifying recovery never calls unreachable live Admin', async () => {
  for (const phase of ['staged', 'cutover', 'verifying'] as const) {
    const f = migrationFixture({ originalRunning: false });
    const txId = `tx-stopped-no-admin-${phase}`;
    if (['cutover', 'verifying'].includes(phase)) writePriorCommonModule(f);
    await interruptedMigration(f, txId, phase, undefined, false);
    installPhaseRealisticStoppedEffects(f, txId, phase);
    let adminCalls = 0;
    const unreachable = async () => {
      adminCalls += 1;
      throw new Error('stopped production Admin must stay unreachable');
    };
    f.admin.installedModules = unreachable;
    f.admin.uninstallPlatformModule = unreachable;
    f.admin.currentFlows = unreachable;
    f.adminRuntime.waitReady = unreachable;

    const result = await f.service.recoverInterrupted();

    assert.deepEqual(result.map((entry) => entry.phase), ['rolled_back'], phase);
    assert.equal(adminCalls, 0, phase);
    assert.equal(f.docker.inspection.running, false, phase);
  }
});

test('C40 fresh file-backed service recovers every running and stopped phase with realistic effects', async () => {
  for (const originalRunning of [true, false]) {
    for (const phase of [
      'preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back',
    ] as const) {
      const f = migrationFixture({ originalRunning });
      const txId = `tx-c40-${originalRunning ? 'running' : 'stopped'}-${phase}`;
      const edgeKey = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
      const commonKey = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
      if (!originalRunning && ['cutover', 'verifying', 'rolling_back'].includes(phase)) {
        writePriorCommonModule(f);
      }
      const before = {
        settings: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))),
        flows: sha256(readFileSync(join(f.instanceRoot, 'flows.json'))),
        credentials: sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json'))),
        package: sha256(readFileSync(join(f.instanceRoot, 'package.json'))),
        lock: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))),
        packageMode: lstatSync(join(f.instanceRoot, 'package.json')).mode & 0o777,
        lockMode: lstatSync(join(f.instanceRoot, 'package-lock.json')).mode & 0o777,
        edge: testArtifactFact(f.instanceRoot, edgeKey),
        common: testArtifactFact(f.instanceRoot, commonKey),
      };
      await interruptedMigration(f, txId, phase, undefined, originalRunning);
      if (originalRunning) installPhaseRealisticRunningEffects(f, phase);
      else installPhaseRealisticStoppedEffects(f, txId, phase);
      if (!originalRunning && phase === 'staged') {
        const journal = f.repo.nodeMigration('line-a')!;
        await f.docker.createMigrationProbe({
          spec: {
            id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
            ports: [], adminRoot: '/red/line-a/', ingestToken: 'probe-only-token',
          },
          txId,
          imageId: journal.imageIdBefore,
          checkpointDir: journal.checkpointDir,
        });
      }
      let adminCalls = 0;
      if (!originalRunning) {
        const unreachable = async () => {
          adminCalls += 1;
          throw new Error('stopped production Admin is unreachable');
        };
        f.admin.installedModules = unreachable;
        f.admin.uninstallPlatformModule = unreachable;
        f.admin.currentFlows = unreachable;
        f.adminRuntime.waitReady = unreachable;
      }
      let bootstrapRecoveries = 0;
      const recoveryEventStart = f.events.length;
      const reopened = reopenMigrationFixture(f, async () => {
        bootstrapRecoveries += 1;
        f.events.push('c40-bootstrap-recovery');
        return [{ instanceId: 'bootstrap-residual', residuals: ['data'] }];
      });

      const result = await reopened.service.recoverInterrupted();

      assert.deepEqual(result.map((entry) => entry.phase), ['rolled_back'], `${originalRunning}/${phase}`);
      assert.equal(bootstrapRecoveries, 1, phase);
      assert.equal(f.events[recoveryEventStart], 'c40-bootstrap-recovery', phase);
      assert.equal(f.docker.inspection.running, originalRunning, phase);
      assert.equal(adminCalls, 0, phase);
      assert.deepEqual({
        settings: sha256(readFileSync(join(f.instanceRoot, 'settings.js'))),
        flows: sha256(readFileSync(join(f.instanceRoot, 'flows.json'))),
        credentials: sha256(readFileSync(join(f.instanceRoot, 'flows_cred.json'))),
        package: sha256(readFileSync(join(f.instanceRoot, 'package.json'))),
        lock: sha256(readFileSync(join(f.instanceRoot, 'package-lock.json'))),
        packageMode: lstatSync(join(f.instanceRoot, 'package.json')).mode & 0o777,
        lockMode: lstatSync(join(f.instanceRoot, 'package-lock.json')).mode & 0o777,
        edge: testArtifactFact(f.instanceRoot, edgeKey),
        common: testArtifactFact(f.instanceRoot, commonKey),
      }, before, `${originalRunning}/${phase}`);
      assert.deepEqual(txSidecars(f.instanceRoot, txId), [], `${originalRunning}/${phase}`);
      assert.equal(
        existsSync(stoppedAuthorityPath(f, txId)),
        false,
        `${originalRunning}/${phase}`,
      );
      reopened.db.close();
    }
  }
});

test('C40 fresh recovery preserves pending and terminals without repeating cutover', async () => {
  const pending = migrationFixture({ originalRunning: false });
  assert.equal((await pending.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  const pendingRuntimeEffects = [...pending.docker.runtimeCalls];
  const reopenedPending = reopenMigrationFixture(pending);
  assert.deepEqual(
    (await reopenedPending.service.recoverInterrupted()).map((entry) => entry.phase),
    ['pending_start_verification'],
  );
  assert.deepEqual(pending.docker.runtimeCalls, pendingRuntimeEffects);
  assert.equal(pending.docker.inspection.running, false);
  reopenedPending.db.close();

  const committed = migrationFixture({ originalRunning: false });
  assert.equal((await committed.service.migrate('line-a', 'admin')).phase, 'pending_start_verification');
  assert.equal((await committed.gate.run('line-a', 'start-instance', (lease) => (
    committed.service.completePendingStartUnderLease('line-a', lease, 'admin')
  ))).phase, 'committed');
  const committedEffects = [...committed.docker.runtimeCalls];
  const reopenedCommitted = reopenMigrationFixture(committed);
  assert.deepEqual(
    (await reopenedCommitted.service.recoverInterrupted()).map((entry) => entry.phase),
    ['committed'],
  );
  assert.deepEqual(committed.docker.runtimeCalls, committedEffects);
  reopenedCommitted.db.close();

  const rolledBack = migrationFixture({ originalRunning: false });
  await interruptedMigration(rolledBack, 'tx-c40-terminal-rollback', 'checkpointed', undefined, false);
  assert.deepEqual(
    (await rolledBack.service.recoverInterrupted()).map((entry) => entry.phase),
    ['rolled_back'],
  );
  const rolledBackEffects = [...rolledBack.docker.runtimeCalls];
  const reopenedRolledBack = reopenMigrationFixture(rolledBack);
  assert.deepEqual(
    (await reopenedRolledBack.service.recoverInterrupted()).map((entry) => entry.phase),
    ['rolled_back'],
  );
  assert.deepEqual(rolledBack.docker.runtimeCalls, rolledBackEffects);
  reopenedRolledBack.db.close();
});

test('C40 fresh recovery marks tampered checkpoint and impossible projection manual without destructive retry', async () => {
  const tampered = migrationFixture({ originalRunning: false });
  await interruptedMigration(tampered, 'tx-c40-tampered', 'checkpointed', undefined, false);
  writeFileSync(
    join(tampered.root, '.thinglinks-migration', 'line-a', 'tx-c40-tampered', 'manifest.json'),
    '{"tampered":true}\n',
  );
  const tamperedReopened = reopenMigrationFixture(tampered);
  assert.deepEqual(
    (await tamperedReopened.service.recoverInterrupted()).map((entry) => entry.phase),
    ['manual_required'],
  );
  assert.equal(tampered.docker.inspection.running, false);
  tamperedReopened.db.close();

  const impossible = migrationFixture({ originalRunning: false });
  await interruptedMigration(impossible, 'tx-c40-impossible', 'checkpointed', undefined, false);
  impossible.db.prepare(
    "UPDATE instance SET node_migration_state = 'staged' WHERE id = 'line-a'",
  ).run();
  const effectsBefore = [...impossible.docker.runtimeCalls];
  const impossibleReopened = reopenMigrationFixture(impossible);
  assert.equal(impossibleReopened.repo.nodeMigration('line-a')?.phase, 'manual_required');
  assert.deepEqual(
    (await impossibleReopened.service.recoverInterrupted()).map((entry) => entry.phase),
    ['manual_required'],
  );
  assert.deepEqual(impossible.docker.runtimeCalls, effectsBefore);
  impossibleReopened.db.close();
});

test('public rollback is busy during active migration and preparing without ready finalizes cleanly', async () => {
  const reachedPreparing = deferred<void>();
  const releasePreparing = deferred<void>();
  const active = migrationFixture({
    onBarrier: async (event) => {
      if (event.phase === 'preparing' && event.boundary === 'after-phase-persist') {
        reachedPreparing.resolve();
        await releasePreparing.promise;
      }
    },
  });
  const migrating = active.service.migrate('line-a', 'admin');
  await reachedPreparing.promise;
  await assert.rejects(
    () => active.service.rollback('line-a', new Error('operator requested')),
    (error: unknown) => error instanceof InstanceBusyError
      && error.activeOperation === 'platform-migration'
      && error.requestedOperation === 'platform-recovery',
  );
  releasePreparing.resolve();
  assert.equal((await migrating).phase, 'committed');

  const preparing = migrationFixture();
  await interruptedMigration(preparing, 'tx-preparing-no-ready', 'preparing');
  const result = await preparing.service.rollback('line-a', new Error('operator requested'));
  assert.equal(result.phase, 'rolled_back');
  assert.equal(result.error, 'none');
  assert.deepEqual(preparing.docker.runtimeCalls, []);
  assert.equal(await preparing.checkpoint.readyExists('line-a', 'tx-preparing-no-ready'), false);
});

test('separate Manager recovery cannot steal an unexpired staged migration owner', async () => {
  const staged = deferred<void>();
  const resume = deferred<void>();
  const f = migrationFixture({
    onBarrier: async (event) => {
      if (event.phase === 'staged' && event.boundary === 'after-phase-persist') {
        staged.resolve();
        await resume.promise;
      }
    },
  });
  const active = f.service.migrate('line-a', 'admin-a');
  await staged.promise;
  const peerDb = openDb(join(f.root, 'manager.db'));
  const peerRepo = new InstanceRepo(peerDb, deriveKey('migration-test-master-key', 'instance'));
  const peerGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(peerRepo));
  const peer = f.createService(peerRepo, peerGate, 'tx-peer', 'owner-peer-b-0000000001');

  try {
    const result = await peer.rollback('line-a', new Error('operator requested'));
    assert.equal(result.phase, 'staged');
    assert.equal(f.admin.installCalls, 0);
    assert.equal(f.admin.uninstallCalls, 0);
    assert.deepEqual(f.docker.runtimeCalls, []);
  } finally {
    resume.resolve();
  }
  assert.equal((await active).phase, 'committed');
  assert.equal(f.admin.installCalls, 1);
  assert.deepEqual(f.docker.runtimeCalls, ['write-settings', 'restart']);
  peerDb.close();
});

test('expired staged migration is recovered once and the former owner stops before POST', async () => {
  const staged = deferred<void>();
  const resume = deferred<void>();
  const f = migrationFixture({
    onBarrier: async (event) => {
      if (event.phase === 'staged' && event.boundary === 'after-phase-persist') {
        staged.resolve();
        await resume.promise;
      }
    },
  });
  const active = f.service.migrate('line-a', 'admin-a');
  await staged.promise;
  f.time.advance(1_000);
  const peerDb = openDb(join(f.root, 'manager.db'));
  const peerRepo = new InstanceRepo(peerDb, deriveKey('migration-test-master-key', 'instance'));
  const peerGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(peerRepo));
  const peer = f.createService(peerRepo, peerGate, 'tx-peer', 'owner-peer-b-0000000002');

  assert.equal(
    (await peer.rollback('line-a', new Error('operator requested'))).phase,
    'rolled_back',
  );
  resume.resolve();
  assert.equal((await active).phase, 'rolled_back');
  assert.equal(f.admin.installCalls, 0);
  assert.equal(f.admin.uninstallCalls, 0);
  assert.deepEqual(f.docker.runtimeCalls, ['stop', 'start']);
  peerDb.close();
});

test('active migration heartbeat renews ownership while paused and still fences peer recovery', async () => {
  const staged = deferred<void>();
  const resume = deferred<void>();
  const f = migrationFixture({
    onBarrier: async (event) => {
      if (event.phase === 'staged' && event.boundary === 'after-phase-persist') {
        staged.resolve();
        await resume.promise;
      }
    },
  });
  const active = f.service.migrate('line-a', 'admin-a');
  await staged.promise;
  const before = f.repo.nodeMigration('line-a')?.executionLeaseExpiresAt;
  f.time.advance(500);
  f.time.pulse();
  assert.ok((f.repo.nodeMigration('line-a')?.executionLeaseExpiresAt ?? 0) > (before ?? 0));
  f.time.advance(500);

  const peerDb = openDb(join(f.root, 'manager.db'));
  const peerRepo = new InstanceRepo(peerDb, deriveKey('migration-test-master-key', 'instance'));
  const peerGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(peerRepo));
  const peer = f.createService(peerRepo, peerGate, 'tx-peer', 'owner-peer-heartbeat-0001');
  assert.equal((await peer.rollback('line-a', new Error('operator requested'))).phase, 'staged');
  assert.deepEqual(f.docker.runtimeCalls, []);
  assert.equal(f.admin.installCalls, 0);

  resume.resolve();
  assert.equal((await active).phase, 'committed');
  assert.equal(f.admin.installCalls, 1);
  peerDb.close();
});

test('two recovery workers waiting on one expired owner produce exactly one rollback effect set', async () => {
  const f = migrationFixture();
  await interruptedMigration(
    f,
    'tx-recovery-race',
    'staged',
    { owner: 'owner-crashed-worker-0001', expiresAt: 2_000 },
  );
  writeInstalledPackage(f.instanceRoot);
  f.state.staged = true;
  f.admin.beforeModules = [rawPlatformInventory(), stagedPlatformInventory()];

  const dbB = openDb(join(f.root, 'manager.db'));
  const repoB = new InstanceRepo(dbB, deriveKey('migration-test-master-key', 'instance'));
  const gateB = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repoB));
  const workerB = f.createService(repoB, gateB, 'tx-worker-b', 'owner-recovery-worker-b-0001');
  const dbC = openDb(join(f.root, 'manager.db'));
  const repoC = new InstanceRepo(dbC, deriveKey('migration-test-master-key', 'instance'));
  const gateC = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repoC));
  const workerC = f.createService(repoC, gateC, 'tx-worker-c', 'owner-recovery-worker-c-0001');

  const recoveryB = workerB.recoverInterrupted();
  const recoveryC = workerC.recoverInterrupted();
  assert.equal(f.time.pendingSleeps, 2);
  f.time.advance(1_000);
  await Promise.all([recoveryB, recoveryC]);

  assert.deepEqual(f.time.sleeps, [1_000, 1_000]);
  assert.ok(f.time.sleeps.every((ms) => ms < 60_000));
  assert.equal(f.repo.nodeMigration('line-a')?.phase, 'rolled_back');
  assert.equal(f.admin.uninstallCalls, 1);
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'stop').length, 1);
  assert.equal(f.events.filter((event) => event === 'checkpoint:restore').length, 1);
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'start').length, 1);
  dbB.close();
  dbC.close();
});

test('ownership loss after cutover phase barrier prevents settings write', async () => {
  const f = migrationFixture({
    onBarrier: (event) => {
      if (event.phase === 'cutover' && event.boundary === 'after-phase-persist') {
        claimReplacementExecution(f, 'owner-before-settings-0001', 'cutover');
      }
    },
  });

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'cutover');
  assert.deepEqual(f.docker.runtimeCalls, []);
  assert.equal(f.admin.installCalls, 1);
});

test('ownership loss after settings barrier prevents restart', async () => {
  const f = migrationFixture({
    onBarrier: (event) => {
      if (event.phase === 'cutover' && event.boundary === 'after-settings-write') {
        claimReplacementExecution(f, 'owner-before-restart-0001', 'cutover');
      }
    },
  });

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'cutover');
  assert.deepEqual(f.docker.runtimeCalls, ['write-settings']);
});

test('ownership loss before uninstall prevents uninstall and later rollback effects', async () => {
  const f = migrationFixture();
  const unhealthy = healthyPlatformInventory();
  unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
  unhealthy.enabled = false;
  unhealthy.errors = ['load_failed'];
  unhealthy.health = 'failed';
  f.admin.afterRestart = unhealthy;
  const installedModules = f.admin.installedModules.bind(f.admin);
  let replaced = false;
  f.admin.installedModules = async () => {
    const modules = await installedModules();
    if (!replaced && f.repo.nodeMigration('line-a')?.phase === 'rolling_back') {
      replaced = true;
      claimReplacementExecution(f, 'owner-before-uninstall-001', 'rolling_back');
    }
    return modules;
  };

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolling_back');
  assert.equal(f.admin.uninstallCalls, 0);
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'stop').length, 0);
});

test('ownership loss after uninstall prevents stop', async () => {
  const f = migrationFixture();
  const unhealthy = healthyPlatformInventory();
  unhealthy.nodeSets[0] = { ...unhealthy.nodeSets[0]!, enabled: false, err: 'load_failed' };
  unhealthy.enabled = false;
  unhealthy.errors = ['load_failed'];
  unhealthy.health = 'failed';
  f.admin.afterRestart = unhealthy;
  const uninstall = f.admin.uninstallPlatformModule.bind(f.admin);
  f.admin.uninstallPlatformModule = async () => {
    await uninstall();
    claimReplacementExecution(f, 'owner-before-stop-0000001', 'rolling_back');
  };

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolling_back');
  assert.equal(f.admin.uninstallCalls, 1);
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'stop').length, 0);
});

test('ownership loss after stop prevents checkpoint restore', async () => {
  const f = migrationFixture({
    barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' },
  });
  const stop = f.docker.stop.bind(f.docker);
  f.docker.stop = async () => {
    await stop();
    claimReplacementExecution(f, 'owner-before-restore-0001', 'rolling_back');
  };

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolling_back');
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'stop').length, 1);
  assert.equal(f.events.filter((event) => event === 'checkpoint:restore').length, 0);
});

test('ownership loss after restore prevents start', async () => {
  const f = migrationFixture({
    barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' },
  });
  const restore = f.checkpointPort.restore.bind(f.checkpointPort);
  f.checkpointPort.restore = async (...args) => {
    await restore(...args);
    claimReplacementExecution(f, 'owner-before-start-000001', 'rolling_back');
  };

  const result = await f.service.migrate('line-a', 'admin');

  assert.equal(result.phase, 'rolling_back');
  assert.equal(f.events.filter((event) => event === 'checkpoint:restore').length, 1);
  assert.equal(f.docker.runtimeCalls.filter((call) => call === 'start').length, 0);
});

test('ownership loss before partial checkpoint cleanup prevents cleanup', async () => {
  const f = migrationFixture();
  await interruptedMigration(f, 'tx-cleanup-owner-loss', 'preparing');
  const readyExists = f.checkpointPort.readyExists.bind(f.checkpointPort);
  let replaced = false;
  f.checkpointPort.readyExists = async (...args) => {
    const ready = await readyExists(...args);
    if (!replaced) {
      replaced = true;
      claimReplacementExecution(f, 'owner-before-cleanup-0001', 'preparing');
    }
    return ready;
  };

  const result = await f.service.rollback('line-a', new Error('operator requested'));

  assert.equal(result.phase, 'preparing');
  assert.equal(f.events.filter((event) => event === 'checkpoint:cleanup-partial').length, 0);
});

test('stale recovery scan cannot claim or finalize a replacement tx before runtime effects', async () => {
  const f = migrationFixture();
  await interruptedMigration(f, 'tx-stale-scan', 'preparing');
  const originalReadyExists = f.checkpointPort.readyExists.bind(f.checkpointPort);
  let replaced = false;
  f.checkpointPort.readyExists = async (instanceId, txId) => {
    if (!replaced && txId === 'tx-stale-scan') {
      replaced = true;
      f.db.prepare(
        `UPDATE instance_node_migration
         SET tx_id = 'tx-replacement', checkpoint_dir = '.thinglinks-migration/line-a/tx-replacement'
         WHERE instance_id = 'line-a' AND tx_id = 'tx-stale-scan'`,
      ).run();
      return false;
    }
    return originalReadyExists(instanceId, txId);
  };

  const results = await f.service.recoverInterrupted();

  assert.deepEqual(results.map((result) => result.phase), ['preparing']);
  assert.equal(f.repo.nodeMigration('line-a')?.txId, 'tx-replacement');
  assert.equal(f.repo.nodeMigration('line-a')?.phase, 'preparing');
  assert.deepEqual(f.docker.runtimeCalls, []);
  assert.equal(f.admin.uninstallCalls, 0);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action IN ('rollback-node-migration', 'manual-node-migration')",
    ).get() as { n: number }).n,
    0,
  );
});

test('repeated exact recovery is idempotent after one interrupted rollback', async () => {
  const f = migrationFixture();
  await interruptedMigration(f, 'tx-repeat-recovery', 'checkpointed');

  assert.deepEqual((await f.service.recoverInterrupted()).map((result) => result.phase), ['rolled_back']);
  const calls = {
    runtime: [...f.docker.runtimeCalls],
    uninstall: f.admin.uninstallCalls,
    rollbackAudits: (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'rollback-node-migration'",
    ).get() as { n: number }).n,
  };

  assert.deepEqual((await f.service.recoverInterrupted()).map((result) => result.phase), ['rolled_back']);
  assert.deepEqual(f.docker.runtimeCalls, calls.runtime);
  assert.equal(f.admin.uninstallCalls, calls.uninstall);
  assert.equal(
    (f.db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'rollback-node-migration'",
    ).get() as { n: number }).n,
    calls.rollbackAudits,
  );
});

test('two service objects over one SQLite file race one first migration and one clean rollback retry', async () => {
  {
    const f = migrationFixture();
    const db2 = openDb(join(f.root, 'manager.db'));
    const repo2 = new InstanceRepo(db2, deriveKey('migration-test-master-key', 'instance'));
    const gate2 = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo2));
    const peer = f.createService(repo2, gate2, 'tx-02');

    await Promise.all([
      f.service.migrate('line-a', 'admin-a'),
      peer.migrate('line-a', 'admin-b'),
    ]);

    assert.equal(f.repo.nodeMigration('line-a')?.phase, 'committed');
    assert.equal(f.admin.installCalls, 1);
    assert.deepEqual(f.docker.runtimeCalls, ['write-settings', 'restart']);
    db2.close();
  }
  {
    const f = migrationFixture({
      barrierFailure: { phase: 'checkpointed', boundary: 'after-phase-persist' },
    });
    assert.equal((await f.service.migrate('line-a', 'admin')).phase, 'rolled_back');
    f.controls.barrierFailure = undefined;
    const gate1 = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(f.repo));
    const retryA = f.createService(f.repo, gate1, 'tx-retry-a');
    const db2 = openDb(join(f.root, 'manager.db'));
    const repo2 = new InstanceRepo(db2, deriveKey('migration-test-master-key', 'instance'));
    const gate2 = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo2));
    const retryB = f.createService(repo2, gate2, 'tx-retry-b');

    await Promise.all([
      retryA.migrate('line-a', 'admin-a'),
      retryB.migrate('line-a', 'admin-b'),
    ]);

    assert.equal(f.repo.nodeMigration('line-a')?.phase, 'committed');
    assert.equal(f.admin.installCalls, 1);
    assert.equal(f.docker.runtimeCalls.filter((call) => call === 'restart').length, 1);
    db2.close();
  }
});

test('active, pending, committed, dirty, and manual journals return existing status without side effects', async () => {
  for (const phase of [
    'checkpointed',
    'pending_start_verification',
    'rolled_back_dirty',
    'manual_required',
  ] as const) {
    const f = migrationFixture();
    f.repo.beginNodeMigration({
      instanceId: 'line-a',
      txId: `tx-existing-${phase}`,
      operationKind: 'migration',
      phase: 'preparing',
      originalRunning: true,
      stagedBefore: false,
      modeBefore: 'legacy',
      imageIdBefore: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
      checkpointDir: `.thinglinks-migration/line-a/tx-existing-${phase}`,
      snapshot: {
        version: 1,
        kind: 'migration',
        settings: { exists: true, sha256: 'a'.repeat(64) },
        flows: { exists: true, sha256: 'b'.repeat(64) },
        credentials: { exists: true, sha256: 'c'.repeat(64) },
        packageManifest: { exists: true, sha256: 'd'.repeat(64) },
        lock: { exists: true, sha256: 'e'.repeat(64) },
        legacyManifestSha256: 'f'.repeat(64),
        nodeInventorySha256: '1'.repeat(64),
      },
      actor: 'admin',
    });
    f.repo.updateNodeMigration(
      'line-a',
      phase,
      phase === 'rolled_back_dirty' || phase === 'manual_required' ? 'rollback' : 'none',
    );
    const result = await f.service.migrate('line-a', 'other-admin');
    assert.equal(result.phase, phase);
    assert.deepEqual(f.docker.runtimeCalls, []);
    assert.equal(f.admin.installCalls, 0);
  }

  const committed = migrationFixture();
  assert.equal((await committed.service.migrate('line-a', 'admin')).phase, 'committed');
  const beforeCalls = [...committed.docker.runtimeCalls];
  assert.equal((await committed.service.migrate('line-a', 'other-admin')).phase, 'committed');
  assert.deepEqual(committed.docker.runtimeCalls, beforeCalls);
  assert.equal(committed.admin.installCalls, 1);
});
