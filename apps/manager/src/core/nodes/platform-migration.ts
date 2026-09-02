import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  getFlows,
  getInstalledModules,
  stageModule,
  uninstallModule,
  type AdminTarget,
  type InstalledModule,
} from '../flows/admin-client.ts';
import type { InstanceAdminRuntime } from '../instance/admin-runtime.ts';
import type {
  CreateMigrationProbeInput,
  MigrationProbeHandle,
} from '../instance/docker-client.ts';
import type {
  InstanceOperationGate,
  InstanceOperationLease,
} from '../instance/operation-gate.ts';
import type { ProxySessionRegistry } from '../instance/proxy-session-registry.ts';
import {
  RepoError,
  type InstanceNodeMigrationJournal,
  type InstanceRepo,
  type MigrationNodeMigrationSnapshot,
  type NodeMigrationErrorCode,
  type NodeMigrationFileFact,
  type NodeMigrationState,
  type NodeRuntimeMode,
} from '../instance/repo.ts';
import { redact } from '../diag/redact.ts';
import { verifyInstalledPlatformFiles } from './installed-files.ts';
import { assertHealthyPlatformModule } from './inventory.ts';
import type {
  MigrationCheckpointManifest,
} from './migration-checkpoint.ts';
import type { PlatformNodeOperationBarrier } from './platform-operation-barrier.ts';
import {
  LEGACY_PLATFORM_FILES,
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from './platform-contract.ts';
import type {
  VerifiedPlatformPackage,
} from './platform-package.ts';

export type PlatformMigrationPhase = NodeMigrationState;

export interface PlatformMigrationResult {
  instanceId: string;
  phase: PlatformMigrationPhase;
  runtimeMode: NodeRuntimeMode;
  platformVersion: string;
  error: string;
}

export class PlatformMigrationError extends Error {
  readonly code: NodeMigrationErrorCode;

  constructor(code: NodeMigrationErrorCode, message: string) {
    super(redact(message).slice(0, 300));
    this.name = 'PlatformMigrationError';
    this.code = code;
  }
}

export interface PlatformMigrationContainerInspection {
  running: boolean;
  imageId: string;
  /** Raw only in memory for strict preflight. It is never persisted or echoed. */
  environment: string[];
}

export interface PlatformMigrationDocker {
  expectedMigrationEnvironment(): { managerUrl: string; npmRegistry: string };
  inspectMigrationRuntime(instanceId: string): Promise<PlatformMigrationContainerInspection>;
  writeSettings(instanceId: string, settings: string): Promise<void>;
  restart(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  start(instanceId: string): Promise<void>;
  createMigrationProbe(input: CreateMigrationProbeInput): Promise<MigrationProbeHandle>;
  writeMigrationProbeSettings(handle: MigrationProbeHandle, settingsJs: string): Promise<void>;
  restartMigrationProbe(handle: MigrationProbeHandle): Promise<void>;
  cleanupMigrationProbe(handle: MigrationProbeHandle): Promise<{
    residuals: Array<'container' | 'network' | 'data'>;
  }>;
  cleanupMigrationProbeByTx(instanceId: string, txId: string): Promise<{
    residuals: Array<'container' | 'network' | 'data'>;
  }>;
}

export interface PlatformMigrationAdminActions {
  installedModules(instanceId: string): Promise<InstalledModule[]>;
  stagePlatformModule(instanceId: string): Promise<InstalledModule>;
  uninstallPlatformModule(instanceId: string): Promise<void>;
  currentFlows(instanceId: string): Promise<unknown>;
  waitReadyAt(target: AdminTarget): Promise<void>;
  installedModulesAt(target: AdminTarget): Promise<InstalledModule[]>;
  stagePlatformModuleAt(target: AdminTarget): Promise<InstalledModule>;
  currentFlowsAt(target: AdminTarget): Promise<unknown>;
}

export class NodeRedPlatformMigrationAdminActions implements PlatformMigrationAdminActions {
  private readonly runtime: InstanceAdminRuntime;

  constructor(runtime: InstanceAdminRuntime) {
    this.runtime = runtime;
  }

  installedModules(instanceId: string): Promise<InstalledModule[]> {
    return getInstalledModules(this.runtime.target(instanceId));
  }

  stagePlatformModule(instanceId: string): Promise<InstalledModule> {
    return stageModule(
      this.runtime.target(instanceId),
      PLATFORM_NODE_PACKAGE.name,
      PLATFORM_NODE_PACKAGE.version,
    );
  }

  uninstallPlatformModule(instanceId: string): Promise<void> {
    return uninstallModule(this.runtime.target(instanceId), PLATFORM_NODE_PACKAGE.name);
  }

  currentFlows(instanceId: string): Promise<unknown> {
    return getFlows(this.runtime.target(instanceId));
  }

  async waitReadyAt(target: AdminTarget): Promise<void> {
    const deadline = Date.now() + 30_000;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        await getInstalledModules(target);
        return;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw last instanceof Error ? last : new Error('probe Admin API readiness timed out');
  }

  installedModulesAt(target: AdminTarget): Promise<InstalledModule[]> {
    return getInstalledModules(target);
  }

  stagePlatformModuleAt(target: AdminTarget): Promise<InstalledModule> {
    return stageModule(target, PLATFORM_NODE_PACKAGE.name, PLATFORM_NODE_PACKAGE.version);
  }

  currentFlowsAt(target: AdminTarget): Promise<unknown> {
    return getFlows(target);
  }
}

export interface PlatformPackageInstallVerifier {
  verifyForInstall(): VerifiedPlatformPackage;
}

export interface MigrationSettingsRenderer {
  renderNodeSettingsUnderLease(
    instanceId: string,
    lease: InstanceOperationLease,
    runtimeMode: NodeRuntimeMode,
  ): string;
}

export interface MigrationSameImageRepair {
  recreateSameImageUnderLease(
    instanceId: string,
    lease: InstanceOperationLease,
    reason: 'environment-repair',
  ): Promise<void>;
}

export interface MigrationCheckpointPort {
  create(instanceId: string, txId: string): Promise<string>;
  cleanupPartial(instanceId: string, txId: string): Promise<void>;
  readyExists(instanceId: string, txId: string): Promise<boolean>;
  verify(instanceId: string, txId: string): Promise<MigrationCheckpointManifest>;
  restore(instanceId: string, txId: string): Promise<void>;
  verifyLive(instanceId: string, txId: string): Promise<void>;
  cleanupTerminal(
    instanceId: string,
    txId: string,
    phase: NodeMigrationState,
  ): Promise<boolean>;
}

export interface PlatformMigrationServiceOptions {
  repo: InstanceRepo;
  gate: InstanceOperationGate;
  proxySessions: ProxySessionRegistry;
  docker: PlatformMigrationDocker;
  adminRuntime: InstanceAdminRuntime;
  admin: PlatformMigrationAdminActions;
  platformPackages: PlatformPackageInstallVerifier;
  checkpoint: MigrationCheckpointPort;
  settings: MigrationSettingsRenderer;
  repair?: MigrationSameImageRepair | undefined;
  bootstrapRecovery?: {
    recoverInterruptedBootstraps(): Promise<unknown>;
  } | undefined;
  barrier: PlatformNodeOperationBarrier;
  instanceDataRoot: string;
  txId?: (() => string) | undefined;
  /** Internal deterministic time/heartbeat port; production uses the bounded defaults below. */
  executionRuntime?: PlatformMigrationExecutionRuntime | undefined;
}

export interface PlatformMigrationExecutionRuntime {
  now(): number;
  sleep(ms: number): Promise<void>;
  startHeartbeat(intervalMs: number, task: () => void): () => void;
  executionOwner(): string;
  leaseDurationMs: number;
}

interface PreflightFacts {
  inspection: PlatformMigrationContainerInspection;
  snapshot: MigrationNodeMigrationSnapshot;
  stagedBefore: boolean;
  flowIdentity: string;
  needsEnvironmentRepair: boolean;
}

const TARGET_TYPES = new Set<string>(PLATFORM_NODE_TYPES);
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const RECOVERABLE_PHASES = [
  'preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back',
] as const;
const OWNED_PHASES = [...RECOVERABLE_PHASES, 'pending_start_verification'] as const;
const DEFAULT_EXECUTION_LEASE_MS = 15_000;
const MAX_EXECUTION_LEASE_MS = 59_000;

const DEFAULT_EXECUTION_RUNTIME: PlatformMigrationExecutionRuntime = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  startHeartbeat: (intervalMs, task) => {
    const timer = setInterval(task, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
  executionOwner: () => `owner-${randomUUID()}`,
  leaseDurationMs: DEFAULT_EXECUTION_LEASE_MS,
};

interface MigrationExecutionSession {
  readonly instanceId: string;
  readonly txId: string;
  readonly owner: string;
  renew(expected: readonly (typeof OWNED_PHASES)[number][]): InstanceNodeMigrationJournal;
  stop(): void;
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function controlled(
  code: NodeMigrationErrorCode,
  message: string,
): PlatformMigrationError {
  return new PlatformMigrationError(code, message);
}

function normalizeManagerUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '' : '');
  } catch {
    return '';
  }
}

function exactEnvironment(environment: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const entry of environment) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const key = entry.slice(0, at);
    if (values.has(key)) duplicates.add(key);
    values.set(key, entry.slice(at + 1));
  }
  for (const key of [
    'TLE_INSTANCE_ID',
    'TLE_MANAGER_URL',
    'TLE_INGEST_TOKEN',
    'NPM_CONFIG_REGISTRY',
  ]) {
    if (duplicates.has(key)) throw controlled('preflight', `container ${key} is duplicated`);
  }
  return values;
}

function safeDigestEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return leftDigest.length === rightDigest.length && timingSafeEqual(leftDigest, rightDigest);
}

function stableInventory(modules: readonly InstalledModule[]): string {
  return JSON.stringify([...modules]
    .sort((a, b) => a.module.localeCompare(b.module))
    .map((module) => ({
      module: module.module,
      version: module.version,
      observedVersions: [...module.observedVersions].sort(),
      types: [...module.types].sort(),
      enabled: module.enabled,
      errors: [...module.errors].sort(),
      nodeSets: [...module.nodeSets]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((set) => ({
          id: set.id,
          name: set.name,
          module: set.module,
          version: set.version,
          types: [...set.types].sort(),
          enabled: set.enabled,
          err: set.err,
        })),
    })));
}

function assertStagedEvidence(module: InstalledModule): void {
  if (
    module.module !== PLATFORM_NODE_PACKAGE.name
    || module.version !== PLATFORM_NODE_PACKAGE.version
    || module.observedVersions.length !== 1
    || module.observedVersions[0] !== PLATFORM_NODE_PACKAGE.version
    || module.nodeSets.length !== PLATFORM_NODE_TYPES.length
  ) {
    throw controlled('preflight', 'preexisting platform package identity is not exact');
  }
  const seen = new Set<string>();
  for (const set of module.nodeSets) {
    if (
      set.module !== PLATFORM_NODE_PACKAGE.name
      || set.version !== PLATFORM_NODE_PACKAGE.version
      || set.types.length !== 1
      || !TARGET_TYPES.has(set.types[0]!)
      || seen.has(set.types[0]!)
      || set.err !== 'type_already_registered'
    ) {
      throw controlled('preflight', 'preexisting platform package staging evidence is incomplete');
    }
    seen.add(set.types[0]!);
  }
  if (seen.size !== PLATFORM_NODE_TYPES.length) {
    throw controlled('preflight', 'preexisting platform package node sets are incomplete');
  }
}

function assertRawOwners(modules: readonly InstalledModule[]): void {
  const rawOwners = new Set<string>();
  const rawModules = modules.filter((module) => module.module === 'node-red');
  if (rawModules.length !== 1) {
    throw controlled('preflight', 'legacy raw owner inventory is ambiguous');
  }
  for (const module of modules) {
    for (const type of module.types) {
      if (!TARGET_TYPES.has(type)) continue;
      if (module.module !== 'node-red' && module.module !== PLATFORM_NODE_PACKAGE.name) {
        throw controlled('preflight', `target type ${type} has a third-party owner`);
      }
      if (module.module === 'node-red') rawOwners.add(type);
    }
  }
  if (PLATFORM_NODE_TYPES.some((type) => !rawOwners.has(type))) {
    throw controlled('preflight', 'legacy raw target ownership is incomplete');
  }
  const raw = rawModules[0]!;
  const targetSets = raw.nodeSets.filter((set) => set.types.some((type) => TARGET_TYPES.has(type)));
  const seen = new Set<string>();
  for (const set of targetSets) {
    if (
      set.module !== 'node-red'
      || set.types.length !== 1
      || !TARGET_TYPES.has(set.types[0]!)
      || seen.has(set.types[0]!)
      || !set.enabled
      || set.err !== ''
    ) throw controlled('preflight', 'legacy raw target node-set health is invalid');
    seen.add(set.types[0]!);
  }
  if (
    seen.size !== PLATFORM_NODE_TYPES.length
    || raw.errors.length !== 0
    || !raw.enabled
    || raw.health !== 'healthy'
  ) throw controlled('preflight', 'legacy raw module health is invalid');
}

function assertNpmOwners(modules: readonly InstalledModule[]): InstalledModule {
  const owners = new Map<string, string[]>();
  for (const module of modules) {
    for (const type of module.types) {
      if (!TARGET_TYPES.has(type)) continue;
      const current = owners.get(type) ?? [];
      current.push(module.module);
      owners.set(type, current);
    }
  }
  for (const type of PLATFORM_NODE_TYPES) {
    if (owners.get(type)?.join('\0') !== PLATFORM_NODE_PACKAGE.name) {
      throw controlled('verification', `target type ${type} ownership is not exact`);
    }
  }
  const platform = modules.find((module) => module.module === PLATFORM_NODE_PACKAGE.name);
  if (!platform) throw controlled('verification', 'platform module is missing after restart');
  try {
    assertHealthyPlatformModule(platform);
  } catch {
    throw controlled('verification', 'platform module runtime node-set health is invalid');
  }
  return platform;
}

function flowIds(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { flows?: unknown }).flows)
      ? (value as { flows: unknown[] }).flows
      : undefined;
  if (!entries) return undefined;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) return undefined;
    ids.add(id);
  }
  return [...ids].sort();
}

function samePreflightFacts(left: PreflightFacts, right: PreflightFacts): boolean {
  return left.stagedBefore === right.stagedBefore
    && left.needsEnvironmentRepair === right.needsEnvironmentRepair
    && left.flowIdentity === right.flowIdentity
    && JSON.stringify(left.inspection) === JSON.stringify(right.inspection)
    && JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot);
}

function assertCheckpointMatchesPreflight(
  manifest: MigrationCheckpointManifest,
  snapshot: MigrationNodeMigrationSnapshot,
): void {
  const paths: Array<[keyof Pick<MigrationNodeMigrationSnapshot,
    'settings' | 'flows' | 'credentials' | 'packageManifest' | 'lock'>, string]> = [
    ['settings', 'settings.js'],
    ['flows', 'flows.json'],
    ['credentials', 'flows_cred.json'],
    ['packageManifest', 'package.json'],
    ['lock', 'package-lock.json'],
  ];
  for (const [snapshotKey, path] of paths) {
    const expected = snapshot[snapshotKey];
    const actual = manifest.files.find((file) => file.path === path);
    if (!actual || actual.exists !== expected.exists) {
      throw controlled('checkpoint', `${path} checkpoint fact changed after preflight`);
    }
    if (actual.exists && expected.exists && actual.sha256 !== expected.sha256) {
      throw controlled('checkpoint', `${path} checkpoint hash changed after preflight`);
    }
  }
}

const STOPPED_EXPORT_PATHS = Object.freeze([
  'settings.js',
  'settings.js.backup',
  'package.json',
  'package.json.backup',
  'package-lock.json',
  'package-lock.json.backup',
  '.config.nodes.json',
  '.config.nodes.json.backup',
  '.config.modules.json',
  '.config.modules.json.backup',
  join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/')),
  join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/')),
] as const);

type StoppedArtifactFact =
  | { key: string; exists: false }
  | { key: string; exists: true; kind: 'file' | 'directory'; mode: number; sha256: string };

async function artifactFact(root: string, key: string): Promise<StoppedArtifactFact> {
  const absolute = join(root, key);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { key, exists: false };
    throw error;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`untrusted stopped artifact ${key}`);
  }
  const mode = stat.mode & 0o777;
  if (stat.isFile()) {
    return { key, exists: true, kind: 'file', mode, sha256: hash(await readFile(absolute)) };
  }
  const entries: Array<{ path: string; kind: 'file' | 'directory'; mode: number; sha256?: string }> = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = prefix ? join(prefix, child.name) : child.name;
      const childAbsolute = join(directory, child.name);
      const childStat = await lstat(childAbsolute);
      if (childStat.isSymbolicLink() || (!childStat.isFile() && !childStat.isDirectory())) {
        throw new Error(`untrusted stopped artifact entry ${key}/${path}`);
      }
      if (childStat.isDirectory()) {
        entries.push({ path, kind: 'directory', mode: childStat.mode & 0o777 });
        await walk(childAbsolute, path);
      } else {
        entries.push({
          path, kind: 'file', mode: childStat.mode & 0o777,
          sha256: hash(await readFile(childAbsolute)),
        });
      }
    }
  };
  await walk(absolute, '');
  return { key, exists: true, kind: 'directory', mode, sha256: hash(JSON.stringify(entries)) };
}

function sameArtifact(left: StoppedArtifactFact, right: StoppedArtifactFact): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stoppedSidecar(
  path: string,
  txId: string,
  suffix: 'partial' | 'backup' | 'manifest' | 'backup-manifest',
): string {
  return join(dirname(path), `.${basename(path)}.tle-${txId}.${suffix}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncExistingDirectory(path: string): Promise<void> {
  try {
    await syncDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function trustedArtifactParent(
  root: string,
  key: string,
  create: boolean,
): Promise<string | undefined> {
  const parent = dirname(join(root, key));
  const rel = relative(root, parent);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('stopped artifact parent escapes root');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('stopped live root is untrusted');
  }
  let current = root;
  for (const segment of rel === '' ? [] : rel.split(sep)) {
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return undefined;
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('stopped artifact parent is untrusted');
    }
  }
  return parent;
}

async function copyArtifact(source: string, destination: string, fact: StoppedArtifactFact): Promise<void> {
  if (!fact.exists) throw new Error('cannot copy absent stopped artifact');
  await cp(source, destination, {
    recursive: fact.kind === 'directory',
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
  });
  await chmod(destination, fact.mode);
  const copied = await artifactFact(dirname(destination), basename(destination));
  if (!sameArtifact({ ...copied, key: fact.key }, fact)) {
    throw new Error(`stopped artifact copy mismatch ${fact.key}`);
  }
  await syncDirectory(dirname(destination));
}

async function writeArtifactManifest(path: string, fact: StoppedArtifactFact): Promise<void> {
  const serialized = `${JSON.stringify(fact)}\n`;
  let marker;
  try {
    marker = await open(path, 'wx', 0o600);
    await marker.writeFile(serialized, 'utf8');
    await marker.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== serialized) {
      throw new Error('stale artifact manifest differs', { cause: error });
    }
  } finally {
    await marker?.close();
  }
}

async function readArtifactManifest(
  path: string,
  key: string,
): Promise<StoppedArtifactFact | undefined> {
  try {
    const fact = JSON.parse(await readFile(path, 'utf8')) as StoppedArtifactFact;
    if (!fact || typeof fact !== 'object' || fact.key !== key || typeof fact.exists !== 'boolean') {
      throw new Error('artifact manifest identity mismatch');
    }
    return fact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class PlatformMigrationService {
  private readonly o: PlatformMigrationServiceOptions;
  private readonly executionRuntime: PlatformMigrationExecutionRuntime;

  constructor(options: PlatformMigrationServiceOptions) {
    this.o = options;
    this.executionRuntime = options.executionRuntime ?? DEFAULT_EXECUTION_RUNTIME;
    if (
      !Number.isSafeInteger(this.executionRuntime.leaseDurationMs)
      || this.executionRuntime.leaseDurationMs <= 0
      || this.executionRuntime.leaseDurationMs > MAX_EXECUTION_LEASE_MS
    ) throw new Error('platform migration execution lease must be 1..59000 ms');
  }

  status(instanceId: string): PlatformMigrationResult {
    const runtime = this.o.repo.nodeRuntime(instanceId);
    if (!runtime) throw controlled('preflight', `instance ${instanceId} does not exist`);
    const journal = this.o.repo.nodeMigration(instanceId);
    return {
      instanceId,
      phase: journal?.phase ?? runtime.migrationState,
      runtimeMode: runtime.mode,
      platformVersion: runtime.platformVersion,
      error: journal?.error ?? runtime.migrationError,
    };
  }

  private startExecutionSession(
    instanceId: string,
    txId: string,
    owner: string,
  ): MigrationExecutionSession {
    let lost = false;
    const renew = (
      expected: readonly (typeof OWNED_PHASES)[number][],
    ): InstanceNodeMigrationJournal => {
      if (lost) throw new RepoError('迁移执行租约所有权已变化');
      try {
        return this.o.repo.renewNodeMigrationExecution(
          instanceId,
          txId,
          owner,
          expected,
          this.executionRuntime.now(),
          this.executionRuntime.leaseDurationMs,
        );
      } catch (error) {
        lost = true;
        throw error;
      }
    };
    const stopHeartbeat = this.executionRuntime.startHeartbeat(
      Math.max(1, Math.floor(this.executionRuntime.leaseDurationMs / 3)),
      () => {
        if (lost) return;
        try {
          renew(OWNED_PHASES);
        } catch {
          lost = true;
        }
      },
    );
    return { instanceId, txId, owner, renew, stop: stopHeartbeat };
  }

  private async claimExecution(
    scanned: InstanceNodeMigrationJournal,
    owner: string,
    waitForScannedLease: boolean,
  ): Promise<InstanceNodeMigrationJournal | undefined> {
    let current = this.o.repo.nodeMigration(scanned.instanceId);
    if (!current || current.txId !== scanned.txId || current.phase !== scanned.phase) return undefined;
    const now = this.executionRuntime.now();
    if (
      waitForScannedLease
      && current.executionOwner !== ''
      && current.executionOwner !== owner
      && current.executionLeaseExpiresAt > now
    ) {
      const waitMs = Math.min(
        current.executionLeaseExpiresAt - now,
        this.executionRuntime.leaseDurationMs,
      );
      await this.executionRuntime.sleep(waitMs);
      current = this.o.repo.nodeMigration(scanned.instanceId);
      if (!current || current.txId !== scanned.txId || current.phase !== scanned.phase) return undefined;
    }
    if (!RECOVERABLE_PHASES.includes(current.phase as (typeof RECOVERABLE_PHASES)[number])) {
      return undefined;
    }
    return this.o.repo.claimNodeMigrationExecution(
      current.instanceId,
      current.txId,
      owner,
      [current.phase as (typeof RECOVERABLE_PHASES)[number]],
      this.executionRuntime.now(),
      this.executionRuntime.leaseDurationMs,
    );
  }

  private async reachOwned(
    execution: MigrationExecutionSession,
    phase: (typeof RECOVERABLE_PHASES)[number],
    sequence: number,
  ): Promise<void> {
    await this.reach(execution.instanceId, execution.txId, phase, sequence);
    execution.renew([phase]);
  }

  private async barrierOwned(
    execution: MigrationExecutionSession,
    event: Parameters<PlatformNodeOperationBarrier['reach']>[0] & {
      phase: (typeof RECOVERABLE_PHASES)[number];
    },
  ): Promise<void> {
    await this.o.barrier.reach(event);
    execution.renew([event.phase]);
  }

  async migrate(instanceId: string, actor: string): Promise<PlatformMigrationResult> {
    const existing = this.o.repo.nodeMigration(instanceId);
    let replaceRolledBackTxId: string | undefined;
    if (existing) {
      if (existing.phase !== 'rolled_back') return this.status(instanceId);
      try {
        if (await this.o.checkpoint.readyExists(instanceId, existing.txId)) {
          return this.status(instanceId);
        }
      } catch {
        return this.status(instanceId);
      }
      replaceRolledBackTxId = existing.txId;
    }

    // This pass must remain read-only: a rejected migration must not evict editors.
    const initialFacts = await this.preflight(instanceId);

    return this.o.gate.runOrCurrent(
      instanceId,
      'platform-migration',
      () => this.status(instanceId),
      async (lease) => this.migrateUnderLease(
        instanceId,
        actor,
        lease,
        initialFacts,
        replaceRolledBackTxId,
      ),
    );
  }

  private async migrateUnderLease(
    instanceId: string,
    actor: string,
    lease: InstanceOperationLease,
    initialFacts: PreflightFacts,
    replaceRolledBackTxId?: string,
  ): Promise<PlatformMigrationResult> {
    this.o.gate.assertLease(lease, instanceId, ['platform-migration']);
    if (initialFacts.needsEnvironmentRepair) {
      if (!this.o.repair) {
        throw controlled('preflight', 'container environment identity requires same-image repair');
      }
      await this.o.repair.recreateSameImageUnderLease(
        instanceId, lease, 'environment-repair',
      ).catch(() => {
        throw controlled('preflight', 'same-image environment repair failed');
      });
      initialFacts = await this.preflight(instanceId);
      if (initialFacts.needsEnvironmentRepair) {
        throw controlled('preflight', 'container environment identity repair did not converge');
      }
    }
    await this.o.proxySessions.closeAndDrain(instanceId, { code: 1012, timeoutMs: 5_000 });

    // Proxy drain is the only mutation between the two passes. Re-read every mutable
    // fact immediately before the durable journal and reject any drift.
    const facts = await this.preflight(instanceId);
    if (!samePreflightFacts(initialFacts, facts)) {
      throw controlled('preflight', 'migration facts changed while editor sessions drained');
    }
    const txId = this.o.txId?.() ?? `migration-${randomUUID()}`;
    const executionOwner = this.executionRuntime.executionOwner();
    const executionLeaseExpiresAt = this.executionRuntime.now()
      + this.executionRuntime.leaseDurationMs;
    const checkpointDir = `.thinglinks-migration/${instanceId}/${txId}`;
    let journalOwned = false;
    let installedByTx = false;
    let failureCode: NodeMigrationErrorCode = 'checkpoint';
    let execution: MigrationExecutionSession | undefined;
    try {
      try {
        this.o.repo.beginNodeMigration({
          instanceId,
          txId,
          operationKind: 'migration',
          phase: 'preparing',
          originalRunning: facts.inspection.running,
          stagedBefore: facts.stagedBefore,
          modeBefore: 'legacy',
          imageIdBefore: facts.inspection.imageId,
          targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
          checkpointDir,
          snapshot: facts.snapshot,
          actor,
          executionOwner,
          executionLeaseExpiresAt,
          ...(replaceRolledBackTxId ? { replaceRolledBackTxId } : {}),
        });
        const owned = this.o.repo.nodeMigration(instanceId);
        journalOwned = owned?.txId === txId && owned.executionOwner === executionOwner;
      } catch (error) {
        const current = this.o.repo.nodeMigration(instanceId);
        if (current && current.txId !== txId) return this.status(instanceId);
        if (error instanceof RepoError) throw controlled('preflight', 'migration journal precondition changed');
        throw error;
      }
      execution = this.startExecutionSession(instanceId, txId, executionOwner);
      await this.reachOwned(execution, 'preparing', 1);
      execution.renew(['preparing']);
      await this.o.checkpoint.create(instanceId, txId);
      assertCheckpointMatchesPreflight(
        await this.o.checkpoint.verify(instanceId, txId),
        facts.snapshot,
      );

      this.o.repo.transitionNodeMigrationExact(
        instanceId, txId, executionOwner, this.executionRuntime.now(),
        ['preparing'], 'checkpointed',
      );
      await this.reachOwned(execution, 'checkpointed', 2);

      if (!facts.inspection.running) {
        failureCode = 'verification';
        return await this.migrateStoppedInstance(
          instanceId, lease, facts, txId, execution,
        );
      }

      failureCode = 'install';
      if (!facts.stagedBefore) {
        // A POST can mutate and then fail/lose its response. Persist ownership before it.
        this.o.repo.transitionNodeMigrationExact(
          instanceId, txId, executionOwner, this.executionRuntime.now(),
          ['checkpointed'], 'staged',
        );
        await this.reachOwned(execution, 'staged', 3);
        installedByTx = true;
        this.o.platformPackages.verifyForInstall();
        execution.renew(['staged']);
        const staged = await this.o.admin.stagePlatformModule(instanceId);
        try {
          assertStagedEvidence(staged);
        } catch {
          throw controlled('install', 'installed package returned unauthorized duplicate-type evidence');
        }
      }
      await verifyInstalledPlatformFiles({
        instanceDataRoot: this.o.instanceDataRoot,
        instanceId,
        readFile,
      }).catch(() => {
        throw controlled('install', 'installed platform package filesystem evidence is invalid');
      });
      if (facts.stagedBefore) {
        this.o.repo.transitionNodeMigrationExact(
          instanceId, txId, executionOwner, this.executionRuntime.now(),
          ['checkpointed'], 'staged',
        );
        await this.reachOwned(execution, 'staged', 3);
      }

      failureCode = 'cutover';
      this.o.repo.transitionNodeMigrationExact(
        instanceId, txId, executionOwner, this.executionRuntime.now(),
        ['staged'], 'cutover',
      );
      await this.reachOwned(execution, 'cutover', 4);
      const settings = this.o.settings.renderNodeSettingsUnderLease(instanceId, lease, 'npm');
      execution.renew(['cutover']);
      await this.o.docker.writeSettings(instanceId, settings);
      await this.barrierOwned(execution, {
        instanceId,
        txId,
        phase: 'cutover',
        sequence: 5,
        artifact: 'settings',
        boundary: 'after-settings-write',
      });
      execution.renew(['cutover']);
      await this.o.docker.restart(instanceId);
      await this.o.adminRuntime.waitReady(instanceId, { timeoutMs: 30_000, intervalMs: 250 });

      failureCode = 'verification';
      this.o.repo.transitionNodeMigrationExact(
        instanceId, txId, executionOwner, this.executionRuntime.now(),
        ['cutover'], 'verifying',
      );
      await this.reachOwned(execution, 'verifying', 6);
      await this.verifyCutover(instanceId, this.o.repo.nodeMigration(instanceId)!);
      execution.renew(['verifying']);
      this.o.repo.commitNodeMigrationExact(
        instanceId,
        txId,
        executionOwner,
        this.executionRuntime.now(),
        'verifying',
        PLATFORM_NODE_PACKAGE.version,
        actor,
      );
      await this.reach(instanceId, txId, 'committed', 7);
      await this.cleanupTerminal(instanceId, txId, 'committed', actor);
      return this.status(instanceId);
    } catch (error) {
      if (!journalOwned) {
        if (error instanceof PlatformMigrationError) throw error;
        throw controlled('preflight', 'migration preflight failed');
      }
      const current = this.o.repo.nodeMigration(instanceId);
      if (current?.txId === txId && current.phase === 'committed') {
        // A verifier interruption after the atomic final commit must never run rollback.
        return this.status(instanceId);
      }
      const cause = error instanceof PlatformMigrationError
        ? error
        : controlled(failureCode, `${failureCode} external operation failed`);
      if (!execution) return this.status(instanceId);
      return this.rollbackUnderLease(instanceId, txId, cause, lease, installedByTx, execution);
    } finally {
      execution?.stop();
    }
  }

  private probeAdminTarget(instanceId: string, handle: MigrationProbeHandle): AdminTarget {
    const live = this.o.adminRuntime.target(instanceId);
    return { ...live, upstream: handle.adminUpstream };
  }

  private async probeFlowIds(root: string): Promise<string[]> {
    try {
      const value = JSON.parse(await readFile(join(root, 'flows.json'), 'utf8'));
      const ids = flowIds(value);
      if (!ids) throw new Error('invalid probe flows');
      return ids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw controlled('verification', 'probe flow identity is invalid');
    }
  }

  private async verifyProbePackageFiles(root: string): Promise<void> {
    const json = async (path: string): Promise<Record<string, unknown>> => {
      const parsed = JSON.parse(await readFile(join(root, path), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(path);
      return parsed as Record<string, unknown>;
    };
    try {
      const edgePath = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
      const commonPath = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
      const packageJson = await json('package.json');
      const lock = await json('package-lock.json');
      const edge = await json(join(edgePath, 'package.json'));
      const common = await json(join(commonPath, 'package.json'));
      const dependencies = packageJson['dependencies'] as Record<string, unknown> | undefined;
      const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined;
      const edgeLock = packages?.[edgePath];
      const commonLock = packages?.[commonPath];
      const lockRootDependencies = packages?.['']?.['dependencies'] as Record<string, unknown> | undefined;
      const edgeDependencies = edge['dependencies'] as Record<string, unknown> | undefined;
      const edgeLockDependencies = edgeLock?.['dependencies'] as Record<string, unknown> | undefined;
      const nodeRed = edge['node-red'] as Record<string, unknown> | undefined;
      const registrations = nodeRed?.['nodes'] as Record<string, unknown> | undefined;
      const observedRegistrations = Object.entries(registrations ?? {}).sort(([a], [b]) => a.localeCompare(b));
      const expectedRegistrations = PLATFORM_NODE_TYPES
        .map((type) => [type, `${type}.js`] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      if (
        dependencies?.[PLATFORM_NODE_PACKAGE.name] !== PLATFORM_NODE_PACKAGE.version
        || lockRootDependencies?.[PLATFORM_NODE_PACKAGE.name] !== PLATFORM_NODE_PACKAGE.version
        || edge['name'] !== PLATFORM_NODE_PACKAGE.name
        || edge['version'] !== PLATFORM_NODE_PACKAGE.version
        || edgeDependencies?.[PLATFORM_COMMON_PACKAGE.name] !== PLATFORM_COMMON_PACKAGE.version
        || JSON.stringify(observedRegistrations) !== JSON.stringify(expectedRegistrations)
        || common['name'] !== PLATFORM_COMMON_PACKAGE.name
        || common['version'] !== PLATFORM_COMMON_PACKAGE.version
        || Object.prototype.hasOwnProperty.call(common, 'node-red')
        || edgeLock?.['version'] !== PLATFORM_NODE_PACKAGE.version
        || edgeLock?.['integrity'] !== PLATFORM_NODE_PACKAGE.integrity
        || edgeLockDependencies?.[PLATFORM_COMMON_PACKAGE.name] !== PLATFORM_COMMON_PACKAGE.version
        || commonLock?.['version'] !== PLATFORM_COMMON_PACKAGE.version
        || commonLock?.['integrity'] !== PLATFORM_COMMON_PACKAGE.integrity
      ) throw new Error('package identity');
    } catch {
      throw controlled('verification', 'probe package filesystem evidence is invalid');
    }
  }

  private async exportStoppedProbe(root: string): Promise<StoppedArtifactFact[]> {
    const facts: StoppedArtifactFact[] = [];
    for (const key of STOPPED_EXPORT_PATHS) facts.push(await artifactFact(root, key));
    return facts;
  }

  private artifactBarrierKey(key: string): NonNullable<
    Parameters<PlatformNodeOperationBarrier['reach']>[0]['artifact']
  > {
    if (key.startsWith('settings.js')) return 'settings';
    if (key.startsWith('package.json')) return 'package-manifest';
    if (key.startsWith('package-lock.json')) return 'package-lock';
    if (key.startsWith('.config.nodes.json')) return 'node-config';
    if (key.startsWith('.config.modules.json')) return 'module-config';
    if (key.includes(PLATFORM_NODE_PACKAGE.name)) return 'edge-module';
    return 'common-module';
  }

  private async prepareStoppedPartials(
    instanceId: string,
    txId: string,
    probeRoot: string,
    facts: readonly StoppedArtifactFact[],
  ): Promise<void> {
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    for (const fact of facts) {
      if (!fact.exists) continue;
      const target = join(liveRoot, fact.key);
      const partial = stoppedSidecar(target, txId, 'partial');
      const manifest = stoppedSidecar(target, txId, 'manifest');
      await trustedArtifactParent(liveRoot, fact.key, true);
      try {
        const existing = await artifactFact(dirname(partial), basename(partial));
        if (existing.exists) {
          const normalized = { ...existing, key: fact.key } as StoppedArtifactFact;
          if (!sameArtifact(normalized, fact)) throw new Error('stale stopped partial differs');
        } else {
          await copyArtifact(join(probeRoot, fact.key), partial, fact);
        }
        await writeArtifactManifest(manifest, fact);
        await syncDirectory(dirname(target));
      } catch {
        throw controlled('cutover', `could not prepare stopped artifact ${fact.key}`);
      }
    }
    for (const fact of facts) {
      if (!sameArtifact(await artifactFact(probeRoot, fact.key), fact)) {
        throw controlled('cutover', `probe artifact changed during export ${fact.key}`);
      }
    }
  }

  private async applyStoppedArtifacts(
    execution: MigrationExecutionSession,
    facts: readonly StoppedArtifactFact[],
    startSequence: number,
  ): Promise<number> {
    const liveRoot = join(this.o.instanceDataRoot, execution.instanceId);
    let sequence = startSequence;
    for (const fact of facts) {
      execution.renew(['cutover']);
      const target = join(liveRoot, fact.key);
      await trustedArtifactParent(liveRoot, fact.key, false);
      const partial = stoppedSidecar(target, execution.txId, 'partial');
      const backup = stoppedSidecar(target, execution.txId, 'backup');
      const manifest = stoppedSidecar(target, execution.txId, 'manifest');
      const backupManifest = stoppedSidecar(target, execution.txId, 'backup-manifest');
      const live = await artifactFact(liveRoot, fact.key);
      const backupFact = await artifactFact(dirname(backup), basename(backup));
      if (backupFact.exists) throw controlled('cutover', `stopped backup already exists ${fact.key}`);

      if (!fact.exists) {
        if (!live.exists) continue;
        await writeArtifactManifest(backupManifest, live);
        await syncDirectory(dirname(target));
        await rename(target, backup);
        await syncDirectory(dirname(target));
        await this.barrierOwned(execution, {
          instanceId: execution.instanceId, txId: execution.txId, phase: 'cutover',
          sequence: sequence++, artifact: this.artifactBarrierKey(fact.key),
          boundary: 'after-live-backup',
        });
        continue;
      }

      if (live.exists && sameArtifact(live, fact)) {
        await rm(partial, { recursive: true, force: true });
        await rm(manifest, { force: true });
        await syncDirectory(dirname(target));
        continue;
      }
      if (live.exists) {
        await writeArtifactManifest(backupManifest, live);
        await syncDirectory(dirname(target));
        await rename(target, backup);
        await syncDirectory(dirname(target));
        await this.barrierOwned(execution, {
          instanceId: execution.instanceId, txId: execution.txId, phase: 'cutover',
          sequence: sequence++, artifact: this.artifactBarrierKey(fact.key),
          boundary: 'after-live-backup',
        });
      }
      const targetAfterBackup = await artifactFact(liveRoot, fact.key);
      if (targetAfterBackup.exists) {
        throw controlled('cutover', `stopped target remained occupied ${fact.key}`);
      }
      await rename(partial, target);
      await syncExistingDirectory(dirname(target));
      await this.barrierOwned(execution, {
        instanceId: execution.instanceId, txId: execution.txId, phase: 'cutover',
        sequence: sequence++, artifact: this.artifactBarrierKey(fact.key),
        boundary: 'after-live-rename',
      });
    }
    for (const fact of facts) {
      if (!sameArtifact(await artifactFact(liveRoot, fact.key), fact)) {
        throw controlled('verification', `stopped live artifact mismatch ${fact.key}`);
      }
    }
    return sequence;
  }

  private async restoreStoppedArtifacts(journal: InstanceNodeMigrationJournal): Promise<void> {
    const liveRoot = join(this.o.instanceDataRoot, journal.instanceId);
    for (const key of [...STOPPED_EXPORT_PATHS].reverse()) {
      const target = join(liveRoot, key);
      await trustedArtifactParent(liveRoot, key, false);
      const partial = stoppedSidecar(target, journal.txId, 'partial');
      const backup = stoppedSidecar(target, journal.txId, 'backup');
      const manifest = stoppedSidecar(target, journal.txId, 'manifest');
      const backupManifest = stoppedSidecar(target, journal.txId, 'backup-manifest');
      const backupFact = await artifactFact(dirname(backup), basename(backup));
      const partialFact = await artifactFact(dirname(partial), basename(partial));
      const marker = await readArtifactManifest(manifest, key);
      const priorMarker = await readArtifactManifest(backupManifest, key);
      if (backupFact.exists) {
        if (!priorMarker) throw new Error(`stopped backup owner missing ${key}`);
        const normalized = { ...backupFact, key } as StoppedArtifactFact;
        if (!sameArtifact(normalized, priorMarker)) {
          throw new Error(`stopped backup owner mismatch ${key}`);
        }
      }
      const live = await artifactFact(liveRoot, key);
      if (backupFact.exists) {
        if (live.exists && marker) {
          if (!sameArtifact(live, marker)) throw new Error(`foreign live artifact ${key}`);
          await rm(target, { recursive: true, force: false });
        } else if (live.exists) {
          // A deletion operation has no marker. Any replacement after its backup is foreign.
          throw new Error(`occupied stopped restore target ${key}`);
        }
      } else if (marker && !partialFact.exists && live.exists) {
        // No backup means the target was originally absent; a consumed partial plus
        // exact marker proves this live value belongs to the interrupted tx.
        if (!sameArtifact(live, marker)) throw new Error(`foreign live artifact ${key}`);
        await rm(target, { recursive: true, force: false });
      }
      if (backupFact.exists) {
        const afterRemoval = await artifactFact(liveRoot, key);
        if (afterRemoval.exists) throw new Error(`stopped restore target occupied ${key}`);
        await rename(backup, target);
      }
      await rm(partial, { recursive: true, force: true });
      await rm(manifest, { force: true });
      await rm(backupManifest, { force: true });
      await syncExistingDirectory(dirname(target));
    }
    for (const parent of [
      join(liveRoot, 'node_modules', '@mqttsnet'),
      join(liveRoot, 'node_modules'),
    ]) {
      await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
      });
    }
  }

  private async cleanupStoppedEvidence(instanceId: string, txId: string): Promise<void> {
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    for (const key of STOPPED_EXPORT_PATHS) {
      const target = join(liveRoot, key);
      const partial = stoppedSidecar(target, txId, 'partial');
      const backup = stoppedSidecar(target, txId, 'backup');
      const manifest = stoppedSidecar(target, txId, 'manifest');
      const backupManifest = stoppedSidecar(target, txId, 'backup-manifest');
      const partialFact = await artifactFact(dirname(partial), basename(partial));
      const backupFact = await artifactFact(dirname(backup), basename(backup));
      if (partialFact.exists) {
        const expected = await readArtifactManifest(manifest, key);
        if (!expected || !sameArtifact({ ...partialFact, key } as StoppedArtifactFact, expected)) {
          throw new Error(`stopped partial cleanup owner mismatch ${key}`);
        }
        await rm(partial, { recursive: true, force: false });
      }
      if (backupFact.exists) {
        const expected = await readArtifactManifest(backupManifest, key);
        if (!expected || !sameArtifact({ ...backupFact, key } as StoppedArtifactFact, expected)) {
          throw new Error(`stopped backup cleanup owner mismatch ${key}`);
        }
        await rm(backup, { recursive: true, force: false });
      }
      await rm(manifest, { force: true });
      await rm(backupManifest, { force: true });
    }
  }

  private async migrateStoppedInstance(
    instanceId: string,
    lease: InstanceOperationLease,
    facts: PreflightFacts,
    txId: string,
    execution: MigrationExecutionSession,
  ): Promise<PlatformMigrationResult> {
    const inst = this.o.repo.get(instanceId);
    const journal = this.o.repo.nodeMigration(instanceId);
    if (!inst || !journal || journal.txId !== txId || journal.originalRunning) {
      throw controlled('state-inconsistent', 'stopped migration journal identity is invalid');
    }
    this.o.repo.transitionNodeMigrationExact(
      instanceId, txId, execution.owner, this.executionRuntime.now(),
      ['checkpointed'], 'staged',
    );
    await this.reachOwned(execution, 'staged', 3);
    let handle: MigrationProbeHandle | undefined;
    try {
      handle = await this.o.docker.createMigrationProbe({
        spec: {
          id: instanceId,
          imageTag: inst.imageTag,
          memoryMb: inst.memLimit,
          cpus: inst.cpuLimit,
          ports: this.o.repo.ports(instanceId),
          adminRoot: inst.adminRoot,
          ingestToken: this.o.repo.ingestToken(instanceId),
        },
        txId,
        imageId: facts.inspection.imageId,
        checkpointDir: journal.checkpointDir,
      });
      const target = this.probeAdminTarget(instanceId, handle);
      await this.o.admin.waitReadyAt(target);
      this.o.platformPackages.verifyForInstall();
      // The immutable checkpoint intentionally contains no node_modules directories.
      // Always install into the isolated copy, even when production had a staged copy.
      const installed = await this.o.admin.stagePlatformModuleAt(target);
      assertHealthyPlatformModule(installed);
      const settings = this.o.settings.renderNodeSettingsUnderLease(instanceId, lease, 'npm');
      execution.renew(['staged']);
      await this.o.docker.writeMigrationProbeSettings(handle, settings);
      await this.barrierOwned(execution, {
        instanceId, txId, phase: 'staged', sequence: 4, artifact: 'settings',
        boundary: 'after-settings-write',
      });
      await this.o.docker.restartMigrationProbe(handle);
      await this.o.admin.waitReadyAt(target);
      assertNpmOwners(await this.o.admin.installedModulesAt(target));
      await this.verifyProbePackageFiles(handle.dataRoot);
      const expectedFlows = await this.probeFlowIds(handle.dataRoot);
      const observedFlows = flowIds(await this.o.admin.currentFlowsAt(target));
      if (!observedFlows || JSON.stringify(observedFlows) !== JSON.stringify(expectedFlows)) {
        throw controlled('verification', 'probe Admin flow identity mismatch');
      }
      const exported = await this.exportStoppedProbe(handle.dataRoot);
      await this.prepareStoppedPartials(instanceId, txId, handle.dataRoot, exported);
      const cleanup = await this.o.docker.cleanupMigrationProbe(handle);
      handle = undefined;
      if (cleanup.residuals.length > 0) {
        throw controlled('verification', 'probe resource cleanup left residuals');
      }
      this.o.repo.transitionNodeMigrationExact(
        instanceId, txId, execution.owner, this.executionRuntime.now(),
        ['staged'], 'cutover',
      );
      await this.reachOwned(execution, 'cutover', 5);
      const nextSequence = await this.applyStoppedArtifacts(execution, exported, 6);
      this.o.repo.parkNodeMigrationPendingStartExact(
        instanceId, txId, execution.owner, this.executionRuntime.now(), 'cutover',
      );
      await this.reach(instanceId, txId, 'pending_start_verification', nextSequence);
      return this.status(instanceId);
    } finally {
      if (handle) await this.o.docker.cleanupMigrationProbe(handle).catch(() => undefined);
    }
  }

  /**
   * Explicit-start continuation for a parked stopped migration. The caller already
   * owns the single start-instance gate lease; this method claims the exact pending
   * tx before the one production start and never enters a public facade recursively.
   */
  async completePendingStartUnderLease(
    instanceId: string,
    lease: InstanceOperationLease,
    actor: string,
  ): Promise<PlatformMigrationResult> {
    this.o.gate.assertLease(lease, instanceId, ['start-instance']);
    const scanned = this.o.repo.nodeMigration(instanceId);
    if (
      !scanned
      || scanned.operationKind !== 'migration'
      || scanned.phase !== 'pending_start_verification'
      || scanned.error !== 'none'
      || scanned.originalRunning
      || scanned.executionOwner !== ''
      || scanned.executionLeaseExpiresAt !== 0
    ) throw controlled('state-inconsistent', 'pending-start migration identity is invalid');
    const owner = this.executionRuntime.executionOwner();
    const claimed = this.o.repo.claimPendingStartExecutionExact(
      instanceId,
      scanned.txId,
      owner,
      this.executionRuntime.now(),
      this.executionRuntime.leaseDurationMs,
    );
    if (!claimed) throw controlled('state-inconsistent', 'pending-start execution claim failed');
    const execution = this.startExecutionSession(instanceId, scanned.txId, owner);
    try {
      execution.renew(['pending_start_verification']);
      this.o.repo.transitionNodeMigrationExact(
        instanceId, scanned.txId, owner, this.executionRuntime.now(),
        ['pending_start_verification'], 'verifying',
      );
      await this.reachOwned(execution, 'verifying', 200);
      execution.renew(['verifying']);
      await this.o.docker.start(instanceId);
      await this.o.adminRuntime.waitReady(instanceId, { timeoutMs: 30_000, intervalMs: 250 });
      await this.verifyCutover(instanceId, this.o.repo.nodeMigration(instanceId)!);
      execution.renew(['verifying']);
      this.o.repo.commitNodeMigrationExact(
        instanceId, scanned.txId, owner, this.executionRuntime.now(),
        'verifying', PLATFORM_NODE_PACKAGE.version, actor,
      );
      await this.reach(instanceId, scanned.txId, 'committed', 201);
      await this.cleanupStoppedEvidence(instanceId, scanned.txId);
      await this.cleanupTerminal(instanceId, scanned.txId, 'committed', actor);
      return this.status(instanceId);
    } catch (error) {
      const current = this.o.repo.nodeMigration(instanceId);
      if (current?.txId === scanned.txId && current.phase === 'committed') {
        return this.status(instanceId);
      }
      const cause = error instanceof PlatformMigrationError
        ? error
        : controlled('verification', 'pending-start verification failed');
      const journal = this.o.repo.nodeMigration(instanceId);
      if (
        journal?.txId === scanned.txId
        && journal.executionOwner === owner
        && OWNED_PHASES.includes(journal.phase as (typeof OWNED_PHASES)[number])
      ) {
        return this.rollbackExactJournal(journal, cause, false, execution);
      }
      return this.status(instanceId);
    } finally {
      execution.stop();
    }
  }

  async rollback(instanceId: string, cause: unknown): Promise<PlatformMigrationResult> {
    const controlledCause = cause instanceof PlatformMigrationError
      ? cause
      : controlled('rollback', 'rollback requested after a controlled migration failure');
    if (this.o.gate.current(instanceId)) {
      return this.o.gate.run(instanceId, 'platform-recovery', async () => this.status(instanceId));
    }
    const scanned = this.o.repo.nodeMigration(instanceId);
    if (!scanned || ![
      'preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back',
    ].includes(scanned.phase)) return this.status(instanceId);
    const recoveryOwner = this.executionRuntime.executionOwner();
    return this.o.gate.run(instanceId, 'platform-recovery', async (lease) => {
      this.o.gate.assertLease(lease, instanceId, ['platform-recovery']);
      const current = this.o.repo.nodeMigration(instanceId);
      if (
        !current
        || current.txId !== scanned.txId
        || current.phase !== scanned.phase
        || current.error !== scanned.error
      ) {
        return this.status(instanceId);
      }
      const claimed = await this.claimExecution(current, recoveryOwner, false);
      if (!claimed) return this.status(instanceId);
      const execution = this.startExecutionSession(instanceId, claimed.txId, recoveryOwner);
      try {
        return await this.recoverExactJournal(claimed, controlledCause, execution);
      } finally {
        execution.stop();
      }
    });
  }

  private async rollbackUnderLease(
    instanceId: string,
    txId: string,
    cause: PlatformMigrationError,
    lease: InstanceOperationLease,
    installedByTx: boolean,
    execution: MigrationExecutionSession,
  ): Promise<PlatformMigrationResult> {
    this.o.gate.assertLease(lease, instanceId, ['platform-migration']);
    const journal = this.o.repo.nodeMigration(instanceId);
    if (
      !journal
      || journal.txId !== txId
      || journal.executionOwner !== execution.owner
      || !RECOVERABLE_PHASES.includes(journal.phase as (typeof RECOVERABLE_PHASES)[number])
    ) return this.status(instanceId);
    try {
      execution.renew([journal.phase as (typeof RECOVERABLE_PHASES)[number]]);
    } catch {
      return this.status(instanceId);
    }
    return this.rollbackExactJournal(journal, cause, installedByTx, execution);
  }

  /** Recovery path: claim and operate only on the caller-observed exact durable journal. */
  private async rollbackExactJournal(
    journal: InstanceNodeMigrationJournal,
    cause: PlatformMigrationError,
    installedByTx: boolean,
    execution: MigrationExecutionSession,
  ): Promise<PlatformMigrationResult> {
    const { instanceId } = journal;
    let cleanupDirty = false;
    let claimed = false;
    try {
      this.o.repo.transitionNodeMigrationExact(
        instanceId,
        journal.txId,
        execution.owner,
        this.executionRuntime.now(),
        [journal.phase],
        'rolling_back',
        cause.code,
      );
      claimed = true;
      await this.reachOwned(execution, 'rolling_back', 100);
      if (!journal.originalRunning) {
        const cleanup = await this.o.docker.cleanupMigrationProbeByTx(
          instanceId, journal.txId,
        );
        if (cleanup.residuals.length > 0) {
          throw controlled('rollback', 'stopped probe cleanup left residuals');
        }
        execution.renew(['rolling_back']);
        const current = await this.o.docker.inspectMigrationRuntime(instanceId);
        if (current.running) await this.o.docker.stop(instanceId);
        await this.restoreStoppedArtifacts(journal);
      }
      if (installedByTx && !journal.stagedBefore) {
        cleanupDirty = await this.cleanupAttemptedInstall(instanceId, execution);
      }
      if (journal.originalRunning) {
        execution.renew(['rolling_back']);
        await this.o.docker.stop(instanceId);
      }
      execution.renew(['rolling_back']);
      await this.o.checkpoint.restore(instanceId, journal.txId);
      await this.o.checkpoint.verifyLive(instanceId, journal.txId);
      const afterRestore = await this.o.docker.inspectMigrationRuntime(instanceId);
      if (afterRestore.imageId !== journal.imageIdBefore) {
        throw controlled('rollback', 'rollback immutable image identity changed');
      }
      if (journal.originalRunning) {
        execution.renew(['rolling_back']);
        await this.o.docker.start(instanceId);
        await this.o.adminRuntime.waitReady(instanceId, { timeoutMs: 30_000, intervalMs: 250 });
        // Node-RED can rewrite /data while starting; the post-start bytes are authoritative.
        await this.o.checkpoint.verifyLive(instanceId, journal.txId);
        const modules = await this.o.admin.installedModules(instanceId);
        assertRawOwners(modules);
        if (journal.stagedBefore) {
          const staged = modules.filter((module) => module.module === PLATFORM_NODE_PACKAGE.name);
          if (staged.length !== 1) {
            throw controlled('rollback', 'preexisting platform package disappeared during rollback');
          }
          assertStagedEvidence(staged[0]!);
          await verifyInstalledPlatformFiles({
            instanceDataRoot: this.o.instanceDataRoot,
            instanceId,
            readFile,
          }).catch(() => {
            throw controlled('rollback', 'preexisting platform package integrity changed during rollback');
          });
        }
        await this.verifyAdminFlowIds(
          instanceId,
          await this.liveFlowIds(instanceId, 'rollback'),
          'rollback',
        );
      }
      if (cleanupDirty) {
        execution.renew(['rolling_back']);
        this.o.repo.finishNodeMigrationRollbackExact(
          instanceId,
          journal.txId,
          execution.owner,
          this.executionRuntime.now(),
          'rolling_back',
          'rolled_back_dirty',
          journal.actor,
        );
        await this.reach(instanceId, journal.txId, 'rolled_back_dirty', 101)
          .catch(() => undefined);
        return this.status(instanceId);
      }
      execution.renew(['rolling_back']);
      this.o.repo.finishNodeMigrationRollbackExact(
        instanceId,
        journal.txId,
        execution.owner,
        this.executionRuntime.now(),
        'rolling_back',
        'rolled_back',
        journal.actor,
      );
      try {
        await this.reach(instanceId, journal.txId, 'rolled_back', 101);
      } catch {
        return this.status(instanceId);
      }
      await this.cleanupTerminal(instanceId, journal.txId, 'rolled_back', journal.actor);
      return this.status(instanceId);
    } catch {
      if (!claimed) return this.status(instanceId);
      try {
        execution.renew(['rolling_back']);
        this.o.repo.finishNodeMigrationManualExact(
          instanceId,
          journal.txId,
          execution.owner,
          this.executionRuntime.now(),
          ['rolling_back'],
          'rollback',
          journal.actor,
        );
        await this.reach(instanceId, journal.txId, 'manual_required', 102)
          .catch(() => undefined);
      } catch {
        // Existing journal/projection reconciliation remains the recovery authority.
      }
      return this.status(instanceId);
    }
  }

  async recoverInterrupted(): Promise<PlatformMigrationResult[]> {
    if (this.o.bootstrapRecovery) {
      await this.o.bootstrapRecovery.recoverInterruptedBootstraps();
    }
    const results: PlatformMigrationResult[] = [];
    for (const journal of this.o.repo.nodeMigrations()) {
      if (journal.operationKind !== 'migration') continue;
      if (journal.phase === 'committed' || journal.phase === 'rolled_back') {
        await this.cleanupTerminal(journal.instanceId, journal.txId, journal.phase, 'system');
        results.push(this.status(journal.instanceId));
        continue;
      }
      if (!['preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back']
        .includes(journal.phase)) {
        results.push(this.status(journal.instanceId));
        continue;
      }
      try {
        results.push(await this.o.gate.run(journal.instanceId, 'platform-recovery', async (lease) => {
          this.o.gate.assertLease(lease, journal.instanceId, ['platform-recovery']);
          const current = this.o.repo.nodeMigration(journal.instanceId);
          if (!current || current.txId !== journal.txId || current.phase !== journal.phase) {
            return this.status(journal.instanceId);
          }
          const recoveryOwner = this.executionRuntime.executionOwner();
          const claimed = await this.claimExecution(current, recoveryOwner, true);
          if (!claimed) return this.status(journal.instanceId);
          const execution = this.startExecutionSession(
            journal.instanceId,
            journal.txId,
            recoveryOwner,
          );
          try {
            return await this.recoverExactJournal(
              claimed,
              controlled('rollback', 'interrupted migration recovery requested'),
              execution,
            );
          } finally {
            execution.stop();
          }
        }));
      } catch {
        results.push(this.status(journal.instanceId));
      }
    }
    return results;
  }

  private async recoverExactJournal(
    journal: InstanceNodeMigrationJournal,
    cause: PlatformMigrationError,
    execution: MigrationExecutionSession,
  ): Promise<PlatformMigrationResult> {
    if (journal.phase === 'preparing') {
      let ready: boolean;
      try {
        ready = await this.o.checkpoint.readyExists(journal.instanceId, journal.txId);
      } catch {
        try {
          execution.renew(['preparing']);
          this.o.repo.finishNodeMigrationManualExact(
            journal.instanceId,
            journal.txId,
            execution.owner,
            this.executionRuntime.now(),
            ['preparing'],
            'checkpoint',
            journal.actor,
          );
        } catch {
          // Exact ownership was lost; the replacement journal remains authoritative.
        }
        return this.status(journal.instanceId);
      }
      if (!ready) {
        try {
          execution.renew(['preparing']);
          await this.o.checkpoint.cleanupPartial(journal.instanceId, journal.txId);
          this.o.repo.transitionNodeMigrationExact(
            journal.instanceId,
            journal.txId,
            execution.owner,
            this.executionRuntime.now(),
            ['preparing'],
            'rolling_back',
            'checkpoint',
          );
          await this.reachOwned(execution, 'rolling_back', 100);
          execution.renew(['rolling_back']);
          this.o.repo.finishNodeMigrationRollbackExact(
            journal.instanceId,
            journal.txId,
            execution.owner,
            this.executionRuntime.now(),
            'rolling_back',
            'rolled_back',
            journal.actor,
          );
          await this.cleanupTerminal(journal.instanceId, journal.txId, 'rolled_back', journal.actor);
        } catch {
          try {
            execution.renew(['preparing', 'rolling_back']);
            this.o.repo.finishNodeMigrationManualExact(
              journal.instanceId,
              journal.txId,
              execution.owner,
              this.executionRuntime.now(),
              ['preparing', 'rolling_back'],
              'rollback',
              journal.actor,
            );
          } catch {
            // Exact ownership was lost; do not finalize the replacement journal.
          }
        }
        return this.status(journal.instanceId);
      }
    }
    return this.rollbackExactJournal(
      journal,
      cause,
      !journal.stagedBefore && !['preparing', 'checkpointed'].includes(journal.phase),
      execution,
    );
  }

  private async cleanupTerminal(
    instanceId: string,
    txId: string,
    phase: 'committed' | 'rolled_back',
    actor: string,
  ): Promise<void> {
    try {
      await this.o.checkpoint.cleanupTerminal(instanceId, txId, phase);
    } catch {
      this.o.repo.recordCheckpointCleanupPending(instanceId, actor);
    }
  }

  private async reach(
    instanceId: string,
    txId: string,
    phase: NodeMigrationState,
    sequence: number,
  ): Promise<void> {
    await this.o.barrier.reach({
      instanceId,
      txId,
      phase,
      sequence,
      boundary: 'after-phase-persist',
    });
  }

  private async preflight(instanceId: string): Promise<PreflightFacts> {
    const runtime = this.o.repo.nodeRuntime(instanceId);
    if (!runtime || runtime.mode !== 'legacy') {
      throw controlled('preflight', 'instance is not an existing legacy runtime');
    }
    try {
      this.o.platformPackages.verifyForInstall();
    } catch {
      throw controlled('preflight', 'platform approval or package trust verification failed');
    }

    let inspection: PlatformMigrationContainerInspection;
    try {
      inspection = await this.o.docker.inspectMigrationRuntime(instanceId);
    } catch {
      throw controlled('preflight', 'managed container inspection failed');
    }
    if (!IMAGE_ID.test(inspection.imageId)) throw controlled('preflight', 'immutable image id is missing or invalid');
    const expected = this.o.docker.expectedMigrationEnvironment();
    const environment = exactEnvironment(inspection.environment);
    const needsEnvironmentRepair = (
      !expected.managerUrl
      || normalizeManagerUrl(environment.get('TLE_MANAGER_URL') ?? '')
        !== normalizeManagerUrl(expected.managerUrl)
      || !expected.npmRegistry
      || environment.get('NPM_CONFIG_REGISTRY') !== expected.npmRegistry
      || environment.get('TLE_INSTANCE_ID') !== instanceId
      || !safeDigestEqual(
        environment.get('TLE_INGEST_TOKEN'),
        this.o.repo.ingestToken(instanceId),
      )
    );
    if (needsEnvironmentRepair && !this.o.repair) {
      throw controlled('preflight', 'container environment identity mismatch');
    }
    if (
      !expected.npmRegistry
    ) throw controlled('preflight', 'private registry identity is not configured');

    const legacyManifest = await this.verifyLegacyFiles(instanceId);
    const footprint = await this.platformFootprint(instanceId);
    let stagedBefore: boolean;
    let nodeInventorySha256: string;
    let preflightFlowIdentity: string;
    if (inspection.running) {
      let modules: InstalledModule[];
      try {
        modules = await this.o.admin.installedModules(instanceId);
      } catch {
        throw controlled('preflight', 'Admin inventory preflight failed');
      }
      assertRawOwners(modules);
      const platformModules = modules.filter(
        (module) => module.module === PLATFORM_NODE_PACKAGE.name,
      );
      if (platformModules.length > 1) {
        throw controlled('preflight', 'preexisting platform package inventory is ambiguous');
      }
      stagedBefore = platformModules.length === 1;
      if (stagedBefore) {
        assertStagedEvidence(platformModules[0]!);
        if (!footprint) throw controlled('preflight', 'preexisting platform package is partial on disk');
      } else if (footprint) {
        throw controlled('preflight', 'partial platform package files exist without Admin inventory');
      }
      try {
        const expectedFlowIds = await this.liveFlowIds(instanceId, 'preflight');
        const observedFlowIds = flowIds(await this.o.admin.currentFlows(instanceId));
        if (!observedFlowIds || JSON.stringify(observedFlowIds) !== JSON.stringify(expectedFlowIds)) {
          throw controlled('preflight', 'Admin flow ids do not match flows.json');
        }
        preflightFlowIdentity = hash(JSON.stringify(expectedFlowIds));
      } catch (error) {
        if (error instanceof PlatformMigrationError) throw error;
        throw controlled('preflight', 'existing flow preflight failed');
      }
      nodeInventorySha256 = hash(stableInventory(modules));
    } else {
      stagedBefore = footprint;
      if (stagedBefore) {
        await verifyInstalledPlatformFiles({
          instanceDataRoot: this.o.instanceDataRoot,
          instanceId,
          readFile,
        }).catch(() => {
          throw controlled('preflight', 'stopped preexisting platform package is partial on disk');
        });
      }
      preflightFlowIdentity = hash(JSON.stringify(
        await this.liveFlowIds(instanceId, 'preflight'),
      ));
      nodeInventorySha256 = hash(JSON.stringify({ stopped: true, stagedBefore }));
    }
    if (stagedBefore) {
      await verifyInstalledPlatformFiles({
        instanceDataRoot: this.o.instanceDataRoot,
        instanceId,
        readFile,
      }).catch(() => {
        throw controlled('preflight', 'preexisting platform package integrity is invalid');
      });
    }
    const snapshot: MigrationNodeMigrationSnapshot = {
      version: 1,
      kind: 'migration',
      settings: await this.fileFact(instanceId, 'settings.js'),
      flows: await this.fileFact(instanceId, 'flows.json'),
      credentials: await this.fileFact(instanceId, 'flows_cred.json'),
      packageManifest: await this.fileFact(instanceId, 'package.json'),
      lock: await this.fileFact(instanceId, 'package-lock.json'),
      legacyManifestSha256: hash(legacyManifest),
      nodeInventorySha256,
    };
    return {
      inspection, snapshot, stagedBefore,
      flowIdentity: preflightFlowIdentity,
      needsEnvironmentRepair,
    };
  }

  private async verifyLegacyFiles(instanceId: string): Promise<string> {
    const root = join(this.o.instanceDataRoot, instanceId, 'nodes');
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      throw controlled('preflight', 'legacy raw node directory is missing');
    }
    const actual = entries.map((entry) => entry.name).sort();
    const expected = Object.keys(LEGACY_PLATFORM_FILES).sort();
    if (
      actual.length !== expected.length
      || actual.some((path, index) => path !== expected[index])
    ) throw controlled('preflight', 'legacy raw node directory contains missing or extra files');
    const facts: Array<[string, string]> = [];
    for (const path of expected) {
      const entry = entries.find((candidate) => candidate.name === path)!;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw controlled('preflight', `legacy ${path} is not a regular file`);
      }
      const digest = hash(await readFile(join(root, path)));
      if (digest !== LEGACY_PLATFORM_FILES[path as keyof typeof LEGACY_PLATFORM_FILES]) {
        throw controlled('preflight', `legacy ${path} hash mismatch`);
      }
      facts.push([path, digest]);
    }
    return JSON.stringify(facts);
  }

  private async fileFact(instanceId: string, path: string): Promise<NodeMigrationFileFact> {
    const absolute = join(this.o.instanceDataRoot, instanceId, path);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
      throw controlled('preflight', `${path} could not be inspected`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw controlled('preflight', `${path} is not a regular file`);
    }
    return { exists: true, sha256: hash(await readFile(absolute)) };
  }

  private async liveFlowIds(
    instanceId: string,
    code: 'preflight' | 'verification' | 'rollback',
  ): Promise<string[]> {
    let serialized: string;
    try {
      serialized = await readFile(join(this.o.instanceDataRoot, instanceId, 'flows.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw controlled(code, 'flows.json could not be read for identity verification');
    }
    try {
      const ids = flowIds(JSON.parse(serialized));
      if (!ids) throw new Error('invalid flow file');
      return ids;
    } catch {
      throw controlled(code, 'flows.json has invalid flow identity data');
    }
  }

  private async verifyAdminFlowIds(
    instanceId: string,
    expected: readonly string[],
    code: 'verification' | 'rollback',
  ): Promise<void> {
    let observed: string[] | undefined;
    try {
      observed = flowIds(await this.o.admin.currentFlows(instanceId));
    } catch {
      throw controlled(code, 'Admin flow identity could not be read');
    }
    if (!observed || JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw controlled(code, 'Admin flow ids do not match restored flows.json');
    }
  }

  private async platformFootprint(instanceId: string): Promise<boolean> {
    const root = join(this.o.instanceDataRoot, instanceId);
    const candidates = [
      join(root, 'node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/')),
      join(root, 'node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/')),
    ];
    for (const path of candidates) {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    for (const path of ['package.json', 'package-lock.json']) {
      try {
        const serialized = await readFile(join(root, path), 'utf8');
        if (
          serialized.includes(PLATFORM_NODE_PACKAGE.name)
          || serialized.includes(PLATFORM_COMMON_PACKAGE.name)
        ) {
          return true;
        }
      } catch {
        // Missing/invalid root files are handled by the checkpoint snapshot and install verifier.
      }
    }
    return false;
  }

  /** A POST may have changed disk or Admin state even when it rejects; clean both facts first. */
  private async cleanupAttemptedInstall(
    instanceId: string,
    execution: MigrationExecutionSession,
  ): Promise<boolean> {
    let modules: InstalledModule[];
    let footprint: boolean;
    try {
      [modules, footprint] = await Promise.all([
        this.o.admin.installedModules(instanceId),
        this.platformFootprint(instanceId),
      ]);
    } catch {
      return true;
    }
    const adminFootprint = modules.some((module) => module.module === PLATFORM_NODE_PACKAGE.name);
    if (!adminFootprint && !footprint) return false;
    try {
      execution.renew(['rolling_back']);
      await this.o.admin.uninstallPlatformModule(instanceId);
    } catch {
      return true;
    }
    try {
      const [afterModules, afterFootprint] = await Promise.all([
        this.o.admin.installedModules(instanceId),
        this.platformFootprint(instanceId),
      ]);
      return afterFootprint || afterModules.some((module) => module.module === PLATFORM_NODE_PACKAGE.name);
    } catch {
      return true;
    }
  }

  private async verifyCutover(
    instanceId: string,
    journal: InstanceNodeMigrationJournal,
  ): Promise<void> {
    const inspection = await this.o.docker.inspectMigrationRuntime(instanceId).catch(() => {
      throw controlled('verification', 'post-cutover container inspection failed');
    });
    if (!inspection.running || inspection.imageId !== journal.imageIdBefore) {
      throw controlled('verification', 'post-cutover running or image identity mismatch');
    }
    const modules = await this.o.admin.installedModules(instanceId).catch(() => {
      throw controlled('verification', 'post-cutover Admin inventory failed');
    });
    assertNpmOwners(modules);
    await verifyInstalledPlatformFiles({
      instanceDataRoot: this.o.instanceDataRoot,
      instanceId,
      readFile,
    }).catch(() => {
      throw controlled('verification', 'post-cutover filesystem integrity failed');
    });
    if (journal.snapshot.kind !== 'migration') {
      throw controlled('state-inconsistent', 'migration journal snapshot kind is invalid');
    }
    const flows = await this.fileFact(instanceId, 'flows.json');
    const credentials = await this.fileFact(instanceId, 'flows_cred.json');
    if (
      JSON.stringify(flows) !== JSON.stringify(journal.snapshot.flows)
      || JSON.stringify(credentials) !== JSON.stringify(journal.snapshot.credentials)
    ) throw controlled('verification', 'existing flow or credential hash changed');
    await this.verifyAdminFlowIds(
      instanceId,
      await this.liveFlowIds(instanceId, 'verification'),
      'verification',
    );
  }
}
