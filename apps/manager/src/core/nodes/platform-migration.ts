import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import {
  chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  getFlows,
  getInstalledModules,
  stageModule,
  uninstallModule,
  type AdminTarget,
  type InstalledModule,
} from '../flows/admin-client.ts';
import type { InstanceAdminRuntime } from '../instance/admin-runtime.ts';
import { assertValidId } from '../instance/container-spec.ts';
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
import {
  isAcceptedPlatformNodeRootSelector,
  verifyInstalledPlatformFiles,
} from './installed-files.ts';
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
  /** Internal object-only probe quiescence port; never populated from HTTP or environment input. */
  probeSettleRuntime?: PlatformMigrationProbeSettleRuntime | undefined;
}

export interface PlatformMigrationExecutionRuntime {
  now(): number;
  sleep(ms: number): Promise<void>;
  startHeartbeat(intervalMs: number, task: () => void): () => void;
  executionOwner(): string;
  leaseDurationMs: number;
}

export interface PlatformMigrationProbeSettleRuntime {
  sleep(ms: number): Promise<void>;
  pollIntervalMs?: number | undefined;
  quietSamples?: number | undefined;
  maxSamples?: number | undefined;
}

interface ResolvedPlatformMigrationProbeSettleRuntime {
  sleep(ms: number): Promise<void>;
  pollIntervalMs: number;
  quietSamples: number;
  maxSamples: number;
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
const DEFAULT_PROBE_SETTLE_POLL_INTERVAL_MS = 500;
const DEFAULT_PROBE_SETTLE_QUIET_SAMPLES = 5;
const DEFAULT_PROBE_SETTLE_MAX_SAMPLES = 20;
const MAX_PROBE_SETTLE_POLL_INTERVAL_MS = 1_000;

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

const DEFAULT_PROBE_SETTLE_RUNTIME: ResolvedPlatformMigrationProbeSettleRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs: DEFAULT_PROBE_SETTLE_POLL_INTERVAL_MS,
  quietSamples: DEFAULT_PROBE_SETTLE_QUIET_SAMPLES,
  maxSamples: DEFAULT_PROBE_SETTLE_MAX_SAMPLES,
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
  const duplicateErrors = new Map<string, string>();
  for (const set of module.nodeSets) {
    if (
      set.module !== PLATFORM_NODE_PACKAGE.name
      || set.version !== PLATFORM_NODE_PACKAGE.version
      || set.types.length !== 1
    ) {
      throw controlled('preflight', 'preexisting platform package staging evidence is incomplete');
    }
    const type = set.types[0]!;
    if (!TARGET_TYPES.has(type) || duplicateErrors.has(type)) {
      throw controlled('preflight', 'preexisting platform package staging evidence is incomplete');
    }
    duplicateErrors.set(type, set.err);
  }
  if (duplicateErrors.size !== PLATFORM_NODE_TYPES.length) {
    throw controlled('preflight', 'preexisting platform package node sets are incomplete');
  }
  for (const type of PLATFORM_NODE_TYPES) {
    const error = duplicateErrors.get(type);
    if (error !== 'type_already_registered' && error !== `${type} already registered`) {
      throw controlled('preflight', 'preexisting platform package staging evidence is incomplete');
    }
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
  'package.json',
  'package-lock.json',
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

type StoppedPostStartExpectation =
  | { comparison: 'exact'; fact: StoppedArtifactFact }
  | {
    comparison: 'canonical-json';
    exists: true;
    kind: 'file';
    mode: number;
    canonicalSha256: string;
  };

interface StoppedEvidenceAuthority {
  version: 1 | 2;
  instanceId: string;
  txId: string;
  targetIntegrity: string;
  artifacts: Array<{
    key: string;
    desired: StoppedArtifactFact;
    prior: StoppedArtifactFact;
    postStart: StoppedPostStartExpectation;
  }>;
}

const STOPPED_EVIDENCE_TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTHORITY_MANIFEST = 'manifest.json';
const NODE_CONFIG_PATH = '.config.nodes.json';
const NODE_CONFIG_BACKUP_PATH = '.config.nodes.json.backup';
const MAX_NODE_CONFIG_JSON_BYTES = 1024 * 1024;
const MAX_STOPPED_AUTHORITY_BYTES = 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_VALUES = 100_000;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactAuthorityFact(value: unknown, expectedKey: string): StoppedArtifactFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stopped authority fact must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record['key'] !== expectedKey || typeof record['exists'] !== 'boolean') {
    throw new Error('stopped authority fact identity mismatch');
  }
  if (!record['exists']) {
    if (!exactKeys(record, ['key', 'exists'])) throw new Error('absent authority fact has extra fields');
    return { key: expectedKey, exists: false };
  }
  if (!exactKeys(record, ['key', 'exists', 'kind', 'mode', 'sha256'])) {
    throw new Error('present authority fact field set mismatch');
  }
  if (
    (record['kind'] !== 'file' && record['kind'] !== 'directory')
    || !Number.isInteger(record['mode'])
    || (record['mode'] as number) < 0
    || (record['mode'] as number) > 0o777
    || typeof record['sha256'] !== 'string'
    || !/^[a-f0-9]{64}$/.test(record['sha256'])
  ) throw new Error('present authority fact is invalid');
  return {
    key: expectedKey,
    exists: true,
    kind: record['kind'],
    mode: record['mode'] as number,
    sha256: record['sha256'],
  };
}

function exactPostStartExpectation(
  value: unknown,
  key: string,
  desired: StoppedArtifactFact,
): StoppedPostStartExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stopped post-start expectation must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record['comparison'] === 'exact') {
    if (!exactKeys(record, ['comparison', 'fact'])) {
      throw new Error('exact post-start expectation field set mismatch');
    }
    const fact = exactAuthorityFact(record['fact'], key);
    if (!sameArtifact(fact, desired)) {
      throw new Error('exact post-start expectation differs from desired');
    }
    return { comparison: 'exact', fact };
  }
  if (
    record['comparison'] !== 'canonical-json'
    || (key !== NODE_CONFIG_PATH && key !== NODE_CONFIG_BACKUP_PATH)
    || !exactKeys(record, [
      'comparison', 'exists', 'kind', 'mode', 'canonicalSha256',
    ])
    || record['exists'] !== true
    || record['kind'] !== 'file'
    || !Number.isInteger(record['mode'])
    || (record['mode'] as number) < 0
    || (record['mode'] as number) > 0o777
    || typeof record['canonicalSha256'] !== 'string'
    || !/^[a-f0-9]{64}$/.test(record['canonicalSha256'])
  ) throw new Error('canonical post-start expectation is invalid');
  return {
    comparison: 'canonical-json',
    exists: true,
    kind: 'file',
    mode: record['mode'] as number,
    canonicalSha256: record['canonicalSha256'],
  };
}

function stoppedAuthorityPaths(instanceDataRoot: string, instanceId: string, txId: string) {
  assertValidId(instanceId);
  if (!STOPPED_EVIDENCE_TX.test(txId)) throw new Error('stopped authority tx id invalid');
  const managerRoot = resolve(instanceDataRoot);
  const evidenceRoot = resolve(managerRoot, '.thinglinks-stopped-evidence');
  const instanceRoot = resolve(evidenceRoot, instanceId);
  const txRoot = resolve(instanceRoot, txId);
  const manifest = resolve(txRoot, AUTHORITY_MANIFEST);
  for (const [parent, child] of [
    [managerRoot, evidenceRoot],
    [evidenceRoot, instanceRoot],
    [instanceRoot, txRoot],
    [txRoot, manifest],
  ] as const) {
    const path = relative(parent, child);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('stopped authority path escapes root');
  }
  return { managerRoot, evidenceRoot, instanceRoot, txRoot, manifest };
}

async function requireAuthorityDirectory(path: string, mode?: number): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('stopped authority directory untrusted');
  if (mode !== undefined && (stat.mode & 0o777) !== mode) {
    throw new Error('stopped authority directory mode mismatch');
  }
}

async function ensureAuthorityDirectory(path: string, parent: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await requireAuthorityDirectory(path);
  await chmod(path, 0o700);
  await requireAuthorityDirectory(path, 0o700);
  await syncDirectory(path);
  if (created) await syncDirectory(parent);
}

function exactStoppedAuthority(
  value: unknown,
  expected: { instanceId: string; txId: string; targetIntegrity: string },
): StoppedEvidenceAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stopped authority must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['version', 'instanceId', 'txId', 'targetIntegrity', 'artifacts'])) {
    throw new Error('stopped authority field set mismatch');
  }
  const version = record['version'];
  if (
    (version !== 1 && version !== 2)
    || record['instanceId'] !== expected.instanceId
    || record['txId'] !== expected.txId
    || record['targetIntegrity'] !== expected.targetIntegrity
    || !Array.isArray(record['artifacts'])
    || record['artifacts'].length !== STOPPED_EXPORT_PATHS.length
  ) throw new Error('stopped authority identity mismatch');
  const artifacts = record['artifacts'].map((value, index) => {
    const key = STOPPED_EXPORT_PATHS[index]!;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('stopped authority artifact invalid');
    }
    const artifact = value as Record<string, unknown>;
    const expectedKeys = version === 1
      ? ['key', 'desired', 'prior']
      : ['key', 'desired', 'prior', 'postStart'];
    if (!exactKeys(artifact, expectedKeys) || artifact['key'] !== key) {
      throw new Error('stopped authority artifact order mismatch');
    }
    const desired = exactAuthorityFact(artifact['desired'], key);
    const postStart = version === 1
      ? { comparison: 'exact' as const, fact: desired }
      : exactPostStartExpectation(artifact['postStart'], key, desired);
    return {
      key,
      desired,
      prior: exactAuthorityFact(artifact['prior'], key),
      postStart,
    };
  });
  const nodePost = artifacts.filter((artifact) => (
    artifact.key === NODE_CONFIG_PATH || artifact.key === NODE_CONFIG_BACKUP_PATH
  ));
  if (version === 2) {
    const main = nodePost.find((artifact) => artifact.key === NODE_CONFIG_PATH);
    if (
      nodePost.length !== 2
      || !main?.desired.exists
      || main.desired.kind !== 'file'
      || nodePost.some((artifact) => artifact.postStart.comparison !== 'canonical-json')
      || nodePost[0]!.postStart.comparison !== 'canonical-json'
      || nodePost[1]!.postStart.comparison !== 'canonical-json'
      || nodePost[0]!.postStart.canonicalSha256 !== nodePost[1]!.postStart.canonicalSha256
      || nodePost[0]!.postStart.mode !== nodePost[1]!.postStart.mode
      || nodePost[0]!.postStart.mode !== main.desired.mode
      || artifacts.some((artifact) => (
        artifact.key !== NODE_CONFIG_PATH
        && artifact.key !== NODE_CONFIG_BACKUP_PATH
        && artifact.postStart.comparison !== 'exact'
      ))
    ) throw new Error('stopped authority post-start policy mismatch');
  }
  return {
    version,
    instanceId: expected.instanceId,
    txId: expected.txId,
    targetIntegrity: expected.targetIntegrity,
    artifacts,
  };
}

async function readStoppedAuthority(
  instanceDataRoot: string,
  expected: { instanceId: string; txId: string; targetIntegrity: string },
): Promise<StoppedEvidenceAuthority> {
  const paths = stoppedAuthorityPaths(instanceDataRoot, expected.instanceId, expected.txId);
  await requireAuthorityDirectory(paths.managerRoot);
  await requireAuthorityDirectory(paths.evidenceRoot, 0o700);
  await requireAuthorityDirectory(paths.instanceRoot, 0o700);
  await requireAuthorityDirectory(paths.txRoot, 0o700);
  const handle = await open(
    paths.manifest,
    FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || (before.mode & 0o777) !== 0o600
      || before.size <= 0
      || before.size > MAX_STOPPED_AUTHORITY_BYTES
    ) {
      throw new Error('stopped authority manifest untrusted');
    }
    const serialized = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || serialized.length !== before.size
      || (after.mode & 0o777) !== 0o600
    ) throw new Error('stopped authority manifest changed while reading');
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(serialized);
    const canonical = canonicalJsonObject(decoded);
    return exactStoppedAuthority(JSON.parse(canonical), expected);
  } finally {
    await handle.close();
  }
}

async function createStoppedAuthority(
  instanceDataRoot: string,
  authority: StoppedEvidenceAuthority,
): Promise<void> {
  const paths = stoppedAuthorityPaths(instanceDataRoot, authority.instanceId, authority.txId);
  await requireAuthorityDirectory(paths.managerRoot);
  await ensureAuthorityDirectory(paths.evidenceRoot, paths.managerRoot);
  await ensureAuthorityDirectory(paths.instanceRoot, paths.evidenceRoot);
  try {
    await mkdir(paths.txRoot, { mode: 0o700 });
    await chmod(paths.txRoot, 0o700);
    await syncDirectory(paths.instanceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readStoppedAuthority(instanceDataRoot, authority);
    if (JSON.stringify(existing) !== JSON.stringify(authority)) {
      throw new Error('existing stopped authority differs', { cause: error });
    }
    return;
  }
  await requireAuthorityDirectory(paths.txRoot, 0o700);
  const handle = await open(
    paths.manifest,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL
      | FS_CONSTANTS.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(authority)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(paths.txRoot);
  await syncDirectory(paths.instanceRoot);
}

async function stoppedAuthorityRootExists(
  instanceDataRoot: string,
  instanceId: string,
  txId: string,
): Promise<boolean> {
  const { txRoot } = stoppedAuthorityPaths(instanceDataRoot, instanceId, txId);
  try {
    await lstat(txRoot);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupStoppedAuthority(
  instanceDataRoot: string,
  expected: StoppedEvidenceAuthority,
  allowCompletedManifestRemoval: boolean,
): Promise<void> {
  const paths = stoppedAuthorityPaths(instanceDataRoot, expected.instanceId, expected.txId);
  let manifestPresent = true;
  try {
    const current = await readStoppedAuthority(instanceDataRoot, expected);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error('stopped authority cleanup identity mismatch');
    }
  } catch (error) {
    if (!allowCompletedManifestRemoval) throw error;
    try {
      await requireAuthorityDirectory(paths.txRoot, 0o700);
      const entries = await readdir(paths.txRoot);
      if (entries.length !== 0) throw error;
      manifestPresent = false;
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  if (manifestPresent) {
    await rm(paths.manifest, { force: false });
    await syncDirectory(paths.txRoot);
  }
  await rmdir(paths.txRoot);
  await syncDirectory(paths.instanceRoot);
  if (await stoppedAuthorityRootExists(instanceDataRoot, expected.instanceId, expected.txId)) {
    throw new Error('stopped authority cleanup did not remove tx root');
  }
  for (const [path, parent] of [
    [paths.instanceRoot, paths.evidenceRoot],
    [paths.evidenceRoot, paths.managerRoot],
  ] as const) {
    await rmdir(path).then(() => syncDirectory(parent)).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
    });
  }
}

async function cleanupStoppedAuthorityRemainder(
  instanceDataRoot: string,
  instanceId: string,
  txId: string,
): Promise<void> {
  const paths = stoppedAuthorityPaths(instanceDataRoot, instanceId, txId);
  try {
    await requireAuthorityDirectory(paths.evidenceRoot, 0o700);
    await requireAuthorityDirectory(paths.instanceRoot, 0o700);
    await requireAuthorityDirectory(paths.txRoot, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if ((await readdir(paths.txRoot)).length !== 0) {
    throw new Error('stopped authority remainder is not empty');
  }
  await rmdir(paths.txRoot);
  await syncDirectory(paths.instanceRoot);
  for (const [path, parent] of [
    [paths.instanceRoot, paths.evidenceRoot],
    [paths.evidenceRoot, paths.managerRoot],
  ] as const) {
    await rmdir(path).then(() => syncDirectory(parent)).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
    });
  }
}

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

function canonicalJsonObject(source: string): string {
  let index = 0;
  let values = 0;

  const skipWhitespace = (): void => {
    while (
      source[index] === ' '
      || source[index] === '\t'
      || source[index] === '\n'
      || source[index] === '\r'
    ) index += 1;
  };

  const parseHexCodeUnit = (): number => {
    const hex = source.slice(index, index + 4);
    if (!/^[a-fA-F0-9]{4}$/.test(hex)) throw new Error('invalid JSON unicode escape');
    index += 4;
    return Number.parseInt(hex, 16);
  };

  const parseString = (): string => {
    if (source[index] !== '"') throw new Error('JSON string expected');
    index += 1;
    let decoded = '';
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return decoded;
      }
      if (code < 0x20) throw new Error('unescaped JSON control character');
      if (code === 0x5c) {
        index += 1;
        const escape = source[index];
        index += 1;
        const simple: Record<string, string> = {
          '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
        };
        if (escape && Object.prototype.hasOwnProperty.call(simple, escape)) {
          decoded += simple[escape];
          continue;
        }
        if (escape !== 'u') throw new Error('invalid JSON string escape');
        const unit = parseHexCodeUnit();
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (source.slice(index, index + 2) !== '\\u') {
            throw new Error('lone high surrogate in JSON string');
          }
          index += 2;
          const low = parseHexCodeUnit();
          if (low < 0xdc00 || low > 0xdfff) {
            throw new Error('lone high surrogate in JSON string');
          }
          decoded += String.fromCharCode(unit, low);
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw new Error('lone low surrogate in JSON string');
        } else {
          decoded += String.fromCharCode(unit);
        }
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = source.charCodeAt(index + 1);
        if (index + 1 >= source.length || low < 0xdc00 || low > 0xdfff) {
          throw new Error('lone high surrogate in JSON string');
        }
        decoded += source[index]! + source[index + 1]!;
        index += 2;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('lone low surrogate in JSON string');
      } else {
        decoded += source[index]!;
        index += 1;
      }
    }
    throw new Error('unterminated JSON string');
  };

  type ParsedValue = { canonical: string; kind: 'object' | 'array' | 'primitive' };
  const parseValue = (depth: number): ParsedValue => {
    values += 1;
    if (values > MAX_CANONICAL_JSON_VALUES || depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new Error('node config JSON structure exceeds limits');
    }
    skipWhitespace();
    const token = source[index];
    if (token === '{') {
      index += 1;
      skipWhitespace();
      const entries: Array<[string, string]> = [];
      const keys = new Set<string>();
      if (source[index] === '}') {
        index += 1;
        return { canonical: '{}', kind: 'object' };
      }
      let closed = false;
      while (index < source.length) {
        const key = parseString();
        if (keys.has(key)) throw new Error('duplicate decoded JSON object key');
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ':') throw new Error('JSON object colon expected');
        index += 1;
        const value = parseValue(depth + 1);
        entries.push([key, value.canonical]);
        skipWhitespace();
        if (source[index] === '}') {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] !== ',') throw new Error('JSON object comma expected');
        index += 1;
        skipWhitespace();
      }
      if (!closed) throw new Error('unterminated JSON object');
      entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return {
        canonical: `{${entries.map(([key, value]) => (
          `${JSON.stringify(key)}:${value}`
        )).join(',')}}`,
        kind: 'object',
      };
    }
    if (token === '[') {
      index += 1;
      skipWhitespace();
      const entries: string[] = [];
      if (source[index] === ']') {
        index += 1;
        return { canonical: '[]', kind: 'array' };
      }
      let closed = false;
      while (index < source.length) {
        entries.push(parseValue(depth + 1).canonical);
        skipWhitespace();
        if (source[index] === ']') {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] !== ',') throw new Error('JSON array comma expected');
        index += 1;
      }
      if (!closed) throw new Error('unterminated JSON array');
      return { canonical: `[${entries.join(',')}]`, kind: 'array' };
    }
    if (token === '"') {
      return { canonical: JSON.stringify(parseString()), kind: 'primitive' };
    }
    for (const literal of ['true', 'false', 'null'] as const) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return { canonical: literal, kind: 'primitive' };
      }
    }
    const start = index;
    if (source[index] === '-') index += 1;
    if (source[index] === '0') {
      index += 1;
      if (source[index] && /[0-9]/.test(source[index]!)) {
        throw new Error('non-canonical JSON integer');
      }
    } else if (source[index] && /[1-9]/.test(source[index]!)) {
      while (source[index] && /[0-9]/.test(source[index]!)) index += 1;
    } else {
      throw new Error('JSON value expected');
    }
    if (source[index] === '.' || source[index] === 'e' || source[index] === 'E') {
      throw new Error('non-integer JSON number');
    }
    const integer = source.slice(start, index);
    const number = Number(integer);
    if (integer === '-0' || !Number.isSafeInteger(number)) {
      throw new Error('unsafe or non-canonical JSON integer');
    }
    return { canonical: integer, kind: 'primitive' };
  };

  skipWhitespace();
  const parsed = parseValue(0);
  skipWhitespace();
  if (parsed.kind !== 'object' || index !== source.length) {
    throw new Error('node config JSON root must be one plain object');
  }
  return parsed.canonical;
}

async function canonicalNodeConfigExpectation(
  root: string,
  key: string,
  expectedRaw?: StoppedArtifactFact,
): Promise<Extract<StoppedPostStartExpectation, { comparison: 'canonical-json' }>> {
  const absolute = join(root, key);
  const handle = await open(absolute, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.size > MAX_NODE_CONFIG_JSON_BYTES
      || before.size <= 0
    ) throw new Error('node config JSON file is invalid');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || (after.mode & 0o777) !== (before.mode & 0o777)
    ) throw new Error('node config JSON changed while reading');
    if (
      expectedRaw
      && (
        !expectedRaw.exists
        || expectedRaw.kind !== 'file'
        || expectedRaw.mode !== (before.mode & 0o777)
        || expectedRaw.sha256 !== hash(bytes)
      )
    ) throw new Error('node config JSON differs from raw authority');
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return {
      comparison: 'canonical-json',
      exists: true,
      kind: 'file',
      mode: before.mode & 0o777,
      canonicalSha256: hash(canonicalJsonObject(decoded)),
    };
  } finally {
    await handle.close();
  }
}

function sameArtifact(left: StoppedArtifactFact, right: StoppedArtifactFact): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameArtifactFacts(
  left: readonly StoppedArtifactFact[],
  right: readonly StoppedArtifactFact[],
): boolean {
  return left.length === right.length
    && left.every((fact, index) => sameArtifact(fact, right[index]!));
}

async function matchesPostStartExpectation(
  root: string,
  key: string,
  expected: StoppedPostStartExpectation,
): Promise<boolean> {
  if (expected.comparison === 'exact') {
    return sameArtifact(await artifactFact(root, key), expected.fact);
  }
  try {
    return JSON.stringify(await canonicalNodeConfigExpectation(root, key))
      === JSON.stringify(expected);
  } catch {
    return false;
  }
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
  await syncArtifactTree(destination);
  const copied = await artifactFact(dirname(destination), basename(destination));
  if (!sameArtifact({ ...copied, key: fact.key }, fact)) {
    throw new Error(`stopped artifact copy mismatch ${fact.key}`);
  }
  await syncDirectory(dirname(destination));
}

async function syncArtifactTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('stopped partial contains an untrusted filesystem type');
  }
  if (stat.isFile()) {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) await syncArtifactTree(join(path, entry.name));
  await syncDirectory(path);
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
    const existing = await readArtifactManifest(path, fact.key);
    if (!existing || !sameArtifact(existing, fact)) {
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
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) {
    throw new Error('artifact manifest is untrusted');
  }
  const serialized = await readFile(path, 'utf8');
  const after = await lstat(path);
  if (
    !after.isFile() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || (after.mode & 0o777) !== 0o600
  ) throw new Error('artifact manifest changed while reading');
  const fact = JSON.parse(serialized) as StoppedArtifactFact;
  if (!fact || typeof fact !== 'object' || fact.key !== key || typeof fact.exists !== 'boolean') {
    throw new Error('artifact manifest identity mismatch');
  }
  return fact;
}

export class PlatformMigrationService {
  private readonly o: PlatformMigrationServiceOptions;
  private readonly executionRuntime: PlatformMigrationExecutionRuntime;
  private readonly probeSettleRuntime: ResolvedPlatformMigrationProbeSettleRuntime;

  constructor(options: PlatformMigrationServiceOptions) {
    this.o = options;
    this.executionRuntime = options.executionRuntime ?? DEFAULT_EXECUTION_RUNTIME;
    this.probeSettleRuntime = {
      sleep: options.probeSettleRuntime?.sleep ?? DEFAULT_PROBE_SETTLE_RUNTIME.sleep,
      pollIntervalMs: options.probeSettleRuntime?.pollIntervalMs
        ?? DEFAULT_PROBE_SETTLE_RUNTIME.pollIntervalMs,
      quietSamples: options.probeSettleRuntime?.quietSamples
        ?? DEFAULT_PROBE_SETTLE_RUNTIME.quietSamples,
      maxSamples: options.probeSettleRuntime?.maxSamples
        ?? DEFAULT_PROBE_SETTLE_RUNTIME.maxSamples,
    };
    if (
      !Number.isSafeInteger(this.executionRuntime.leaseDurationMs)
      || this.executionRuntime.leaseDurationMs <= 0
      || this.executionRuntime.leaseDurationMs > MAX_EXECUTION_LEASE_MS
    ) throw new Error('platform migration execution lease must be 1..59000 ms');
    if (
      typeof this.probeSettleRuntime.sleep !== 'function'
      || !Number.isSafeInteger(this.probeSettleRuntime.pollIntervalMs)
      || this.probeSettleRuntime.pollIntervalMs <= 0
      || this.probeSettleRuntime.pollIntervalMs > MAX_PROBE_SETTLE_POLL_INTERVAL_MS
      || !Number.isSafeInteger(this.probeSettleRuntime.quietSamples)
      || this.probeSettleRuntime.quietSamples <= 0
      || !Number.isSafeInteger(this.probeSettleRuntime.maxSamples)
      || this.probeSettleRuntime.maxSamples < this.probeSettleRuntime.quietSamples
      || this.probeSettleRuntime.maxSamples > DEFAULT_PROBE_SETTLE_MAX_SAMPLES
    ) throw new Error('platform migration probe settle runtime bounds are invalid');
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
    const txId = this.o.txId?.() ?? `migration-${randomUUID()}`;
    if (initialFacts.needsEnvironmentRepair) {
      if (!this.o.repair) {
        throw controlled('preflight', 'container environment identity requires same-image repair');
      }
      await this.o.repair.recreateSameImageUnderLease(
        instanceId, lease, 'environment-repair',
      ).catch(() => {
        throw controlled('preflight', 'same-image environment repair failed');
      });
      try {
        await this.o.barrier.reach({
          instanceId,
          txId,
          phase: 'preparing',
          sequence: 0,
          boundary: 'after-same-image-rebuild',
        });
      } catch {
        throw controlled('preflight', 'same-image environment repair barrier failed');
      }
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
        !isAcceptedPlatformNodeRootSelector(dependencies?.[PLATFORM_NODE_PACKAGE.name])
        || !isAcceptedPlatformNodeRootSelector(
          lockRootDependencies?.[PLATFORM_NODE_PACKAGE.name],
        )
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

  private async verifyStoppedProbeRuntime(
    handle: MigrationProbeHandle,
    target: AdminTarget,
  ): Promise<void> {
    assertNpmOwners(await this.o.admin.installedModulesAt(target));
    await this.verifyProbePackageFiles(handle.dataRoot);
    const expectedFlows = await this.probeFlowIds(handle.dataRoot);
    const observedFlows = flowIds(await this.o.admin.currentFlowsAt(target));
    if (!observedFlows || JSON.stringify(observedFlows) !== JSON.stringify(expectedFlows)) {
      throw controlled('verification', 'probe Admin flow identity mismatch');
    }
  }

  private async settleStoppedProbeArtifacts(
    execution: MigrationExecutionSession,
    root: string,
  ): Promise<StoppedArtifactFact[]> {
    let settled = await this.exportStoppedProbe(root);
    execution.renew(['staged']);
    let quiet = 0;
    for (let sample = 0; sample < this.probeSettleRuntime.maxSamples; sample += 1) {
      await this.probeSettleRuntime.sleep(this.probeSettleRuntime.pollIntervalMs);
      const current = await this.exportStoppedProbe(root);
      execution.renew(['staged']);
      if (sameArtifactFacts(settled, current)) {
        quiet += 1;
        if (quiet >= this.probeSettleRuntime.quietSamples) break;
      } else {
        settled = current;
        quiet = 0;
      }
    }
    if (quiet < this.probeSettleRuntime.quietSamples) {
      throw controlled('verification', 'probe runtime artifacts did not become quiet');
    }
    return settled;
  }

  private async settleAndVerifyStoppedProbe(
    execution: MigrationExecutionSession,
    handle: MigrationProbeHandle,
    target: AdminTarget,
  ): Promise<StoppedArtifactFact[]> {
    await this.o.admin.waitReadyAt(target);
    execution.renew(['staged']);
    await this.verifyStoppedProbeRuntime(handle, target);
    await this.settleStoppedProbeArtifacts(execution, handle.dataRoot);
    await this.verifyStoppedProbeRuntime(handle, target);
    return this.settleStoppedProbeArtifacts(execution, handle.dataRoot);
  }

  private async persistStoppedAuthority(
    journal: InstanceNodeMigrationJournal,
    desiredFacts: readonly StoppedArtifactFact[],
    probeRoot: string,
  ): Promise<StoppedEvidenceAuthority> {
    if (desiredFacts.length !== STOPPED_EXPORT_PATHS.length) {
      throw controlled('cutover', 'stopped desired authority set is incomplete');
    }
    const liveRoot = join(this.o.instanceDataRoot, journal.instanceId);
    const nodeConfigDesired = desiredFacts.find((fact) => fact.key === NODE_CONFIG_PATH);
    if (!nodeConfigDesired) {
      throw controlled('cutover', 'stopped node config authority is missing');
    }
    let nodeConfigPostStart: Extract<
      StoppedPostStartExpectation,
      { comparison: 'canonical-json' }
    >;
    try {
      nodeConfigPostStart = await canonicalNodeConfigExpectation(
        probeRoot,
        NODE_CONFIG_PATH,
        nodeConfigDesired,
      );
    } catch {
      throw controlled('cutover', 'stopped node config semantic authority is invalid');
    }
    const artifacts = [] as StoppedEvidenceAuthority['artifacts'];
    for (let index = 0; index < STOPPED_EXPORT_PATHS.length; index += 1) {
      const key = STOPPED_EXPORT_PATHS[index]!;
      const desired = desiredFacts[index];
      if (!desired || desired.key !== key) {
        throw controlled('cutover', 'stopped desired authority order mismatch');
      }
      const postStart: StoppedPostStartExpectation = (
        key === NODE_CONFIG_PATH || key === NODE_CONFIG_BACKUP_PATH
      )
        ? { ...nodeConfigPostStart }
        : { comparison: 'exact', fact: desired };
      artifacts.push({
        key,
        desired,
        prior: await artifactFact(liveRoot, key),
        postStart,
      });
    }
    const authority: StoppedEvidenceAuthority = {
      version: 2,
      instanceId: journal.instanceId,
      txId: journal.txId,
      targetIntegrity: journal.targetIntegrity,
      artifacts,
    };
    await createStoppedAuthority(this.o.instanceDataRoot, authority);
    return readStoppedAuthority(this.o.instanceDataRoot, authority);
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
      const target = join(liveRoot, fact.key);
      const partial = stoppedSidecar(target, txId, 'partial');
      const manifest = stoppedSidecar(target, txId, 'manifest');
      await trustedArtifactParent(liveRoot, fact.key, true);
      try {
        const existing = await artifactFact(dirname(partial), basename(partial));
        if (!fact.exists && existing.exists) {
          throw new Error('absent stopped artifact has a stale partial');
        }
        if (fact.exists && existing.exists) {
          const normalized = { ...existing, key: fact.key } as StoppedArtifactFact;
          if (!sameArtifact(normalized, fact)) throw new Error('stale stopped partial differs');
        } else if (fact.exists) {
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
    authority: StoppedEvidenceAuthority,
    startSequence: number,
  ): Promise<number> {
    const liveRoot = join(this.o.instanceDataRoot, execution.instanceId);
    let sequence = startSequence;
    const persistedAuthority = await readStoppedAuthority(this.o.instanceDataRoot, {
      instanceId: execution.instanceId,
      txId: execution.txId,
      targetIntegrity: authority.targetIntegrity,
    });
    if (JSON.stringify(persistedAuthority) !== JSON.stringify(authority)) {
      throw controlled('cutover', 'stopped authority changed before live apply');
    }
    // C36 closing pass: recursively flush and revalidate every complete partial
    // immediately before the first live rename. No live mutation may precede this loop.
    for (const artifact of authority.artifacts) {
      const fact = artifact.desired;
      const target = join(liveRoot, fact.key);
      await trustedArtifactParent(liveRoot, fact.key, false);
      const partial = stoppedSidecar(target, execution.txId, 'partial');
      const manifest = stoppedSidecar(target, execution.txId, 'manifest');
      const observed = await artifactFact(dirname(partial), basename(partial));
      const marker = await readArtifactManifest(manifest, fact.key);
      if (!sameArtifact(await artifactFact(liveRoot, fact.key), artifact.prior)) {
        throw controlled('cutover', `stopped prior drifted before live apply ${fact.key}`);
      }
      if (!marker || !sameArtifact(marker, fact)) {
        throw controlled('cutover', `prepared stopped desired manifest is incomplete ${fact.key}`);
      }
      if (!fact.exists) {
        if (observed.exists) {
          throw controlled('cutover', `unexpected absent-artifact partial ${fact.key}`);
        }
        continue;
      }
      if (!observed.exists) {
        throw controlled('cutover', `prepared stopped artifact is incomplete ${fact.key}`);
      }
      await syncArtifactTree(partial).catch(() => {
        throw controlled('cutover', `prepared stopped artifact is untrusted ${fact.key}`);
      });
      const flushed = await artifactFact(dirname(partial), basename(partial));
      if (!sameArtifact({ ...flushed, key: fact.key } as StoppedArtifactFact, fact)) {
        throw controlled('cutover', `prepared stopped artifact drifted ${fact.key}`);
      }
      await syncDirectory(dirname(partial));
    }
    for (const artifact of authority.artifacts) {
      const fact = artifact.desired;
      execution.renew(['cutover']);
      const target = join(liveRoot, fact.key);
      await trustedArtifactParent(liveRoot, fact.key, false);
      const partial = stoppedSidecar(target, execution.txId, 'partial');
      const backup = stoppedSidecar(target, execution.txId, 'backup');
      const backupManifest = stoppedSidecar(target, execution.txId, 'backup-manifest');
      const live = await artifactFact(liveRoot, fact.key);
      if (!sameArtifact(live, artifact.prior)) {
        throw controlled('cutover', `stopped prior changed before artifact mutation ${fact.key}`);
      }
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
        // C41 retains equal desired+partial evidence through explicit-start verification.
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
    for (const artifact of authority.artifacts) {
      if (!sameArtifact(await artifactFact(liveRoot, artifact.key), artifact.desired)) {
        throw controlled('verification', `stopped live artifact mismatch ${artifact.key}`);
      }
    }
    return sequence;
  }

  private async restoreStoppedArtifacts(
    journal: InstanceNodeMigrationJournal,
    authority?: StoppedEvidenceAuthority,
  ): Promise<void> {
    const liveRoot = join(this.o.instanceDataRoot, journal.instanceId);
    if (authority) {
      for (const artifact of [...authority.artifacts].reverse()) {
        const { key, desired, prior } = artifact;
        const target = join(liveRoot, key);
        await trustedArtifactParent(liveRoot, key, false);
        const partial = stoppedSidecar(target, journal.txId, 'partial');
        const backup = stoppedSidecar(target, journal.txId, 'backup');
        const manifest = stoppedSidecar(target, journal.txId, 'manifest');
        const backupManifest = stoppedSidecar(target, journal.txId, 'backup-manifest');
        const live = await artifactFact(liveRoot, key);
        const liveIsDesired = sameArtifact(live, desired);
        const liveIsPostStart = await matchesPostStartExpectation(
          liveRoot,
          key,
          artifact.postStart,
        );
        const partialFact = await artifactFact(dirname(partial), basename(partial));
        const backupFact = await artifactFact(dirname(backup), basename(backup));
        const desiredMarker = await readArtifactManifest(manifest, key);
        const priorMarker = await readArtifactManifest(backupManifest, key);
        if (desiredMarker && !sameArtifact(desiredMarker, desired)) {
          throw new Error(`stopped desired marker differs from authority ${key}`);
        }
        if (priorMarker && !sameArtifact(priorMarker, prior)) {
          throw new Error(`stopped prior marker differs from authority ${key}`);
        }
        if (partialFact.exists && !sameArtifact(
          { ...partialFact, key } as StoppedArtifactFact,
          desired,
        )) throw new Error(`stopped partial differs from authority ${key}`);
        if (
          desired.exists
          && desiredMarker
          && !partialFact.exists
          && !backupFact.exists
          && !sameArtifact(prior, desired)
          && sameArtifact(live, prior)
        ) {
          throw new Error(`stopped prepared partial disappeared before mutation ${key}`);
        }
        if (backupFact.exists) {
          if (
            !prior.exists || !priorMarker
            || !sameArtifact({ ...backupFact, key } as StoppedArtifactFact, prior)
          ) throw new Error(`stopped backup differs from authority ${key}`);
          if (liveIsDesired || liveIsPostStart) {
            if (!desiredMarker) throw new Error(`applied desired marker missing ${key}`);
            if (live.exists) await rm(target, { recursive: true, force: false });
          } else if (live.exists && !sameArtifact(live, prior)) {
            throw new Error(`foreign stopped restore target ${key}`);
          }
          const afterRemoval = await artifactFact(liveRoot, key);
          if (afterRemoval.exists) {
            if (!sameArtifact(afterRemoval, prior)) {
              throw new Error(`stopped restore target occupied ${key}`);
            }
          } else {
            // Preserve the authoritative backup until rolled_back plus its audit are
            // durable. A terminal-publication failure must leave retryable evidence.
            await copyArtifact(backup, target, prior);
          }
        } else if (sameArtifact(prior, desired)) {
          if (sameArtifact(live, prior)) {
            // Already restored or never rewritten.
          } else if (liveIsPostStart) {
            if (!desiredMarker) throw new Error(`equal desired marker missing ${key}`);
            if (live.exists) await rm(target, { recursive: true, force: false });
            if (prior.exists) {
              if (!partialFact.exists) throw new Error(`equal desired partial missing ${key}`);
              await copyArtifact(partial, target, prior);
            }
          } else {
            throw new Error(`equal live differs from authority ${key}`);
          }
        } else if (!prior.exists) {
          if (liveIsDesired || liveIsPostStart) {
            if (!desiredMarker) throw new Error(`created desired marker missing ${key}`);
            if (live.exists) await rm(target, { recursive: true, force: false });
          } else if (!sameArtifact(live, prior)) {
            throw new Error(`created live differs from authority ${key}`);
          }
        } else if (!sameArtifact(live, prior)) {
          throw new Error(`changed live lacks authoritative backup ${key}`);
        }
        await syncExistingDirectory(dirname(target));
      }
      return;
    }
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
      const live = await artifactFact(liveRoot, key);
      if (partialFact.exists) {
        const normalizedPartial = { ...partialFact, key } as StoppedArtifactFact;
        const owned = marker
          ? sameArtifact(normalizedPartial, marker)
          : live.exists && sameArtifact(normalizedPartial, live);
        if (!owned) throw new Error(`stopped partial owner mismatch ${key}`);
      }
      if (backupFact.exists) {
        if (!priorMarker) throw new Error(`stopped backup owner missing ${key}`);
        const normalized = { ...backupFact, key } as StoppedArtifactFact;
        if (!sameArtifact(normalized, priorMarker)) {
          throw new Error(`stopped backup owner mismatch ${key}`);
        }
      }
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

  private async hasStoppedOperationalEvidence(instanceId: string, txId: string): Promise<boolean> {
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    for (const key of STOPPED_EXPORT_PATHS) {
      const target = join(liveRoot, key);
      for (const suffix of ['partial', 'backup', 'manifest', 'backup-manifest'] as const) {
        try {
          await lstat(stoppedSidecar(target, txId, suffix));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    return false;
  }

  private async verifyStoppedEvidenceOwned(
    instanceId: string,
    txId: string,
    allowCommittedCleanupResidue = false,
  ): Promise<StoppedEvidenceAuthority['artifacts']> {
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    const journal = this.o.repo.nodeMigration(instanceId);
    if (!journal || journal.txId !== txId) throw new Error('stopped evidence journal identity mismatch');
    let authority: StoppedEvidenceAuthority;
    try {
      authority = await readStoppedAuthority(this.o.instanceDataRoot, {
        instanceId,
        txId,
        targetIntegrity: journal.targetIntegrity,
      });
    } catch (error) {
      if (allowCommittedCleanupResidue && !await this.hasStoppedOperationalEvidence(instanceId, txId)) {
        return [];
      }
      throw error;
    }
    for (const artifact of authority.artifacts) {
      const { key, desired: requiredDesired, prior: expectedPrior } = artifact;
      const target = join(liveRoot, key);
      await trustedArtifactParent(liveRoot, key, false);
      const partial = stoppedSidecar(target, txId, 'partial');
      const backup = stoppedSidecar(target, txId, 'backup');
      const manifest = stoppedSidecar(target, txId, 'manifest');
      const backupManifest = stoppedSidecar(target, txId, 'backup-manifest');
      const partialFact = await artifactFact(dirname(partial), basename(partial));
      const backupFact = await artifactFact(dirname(backup), basename(backup));
      const desiredMarker = await readArtifactManifest(manifest, key);
      const priorMarker = await readArtifactManifest(backupManifest, key);
      if (!await matchesPostStartExpectation(liveRoot, key, artifact.postStart)) {
        throw new Error(`stopped live differs from Manager authority ${key}`);
      }
      if (!allowCommittedCleanupResidue && !desiredMarker) {
        throw new Error(`stopped desired manifest missing ${key}`);
      }
      if (desiredMarker && !sameArtifact(desiredMarker, requiredDesired)) {
        throw new Error(`stopped desired marker differs from Manager authority ${key}`);
      }
      if (!allowCommittedCleanupResidue) {
        const changed = !sameArtifact(expectedPrior, requiredDesired);
        if (changed && expectedPrior.exists) {
          if (
            !backupFact.exists || !priorMarker
            || !sameArtifact({ ...backupFact, key } as StoppedArtifactFact, expectedPrior)
            || !sameArtifact(priorMarker, expectedPrior)
          ) throw new Error(`stopped changed prior evidence missing ${key}`);
        } else if (backupFact.exists || priorMarker) {
          throw new Error(`stopped unchanged/created artifact has prior evidence ${key}`);
        }
        if (changed) {
          if (partialFact.exists) throw new Error(`stopped changed partial was not consumed ${key}`);
        } else if (requiredDesired.exists) {
          if (!partialFact.exists || !sameArtifact(
            { ...partialFact, key } as StoppedArtifactFact,
            requiredDesired,
          )) throw new Error(`stopped equal partial evidence missing ${key}`);
        } else if (partialFact.exists) {
          throw new Error(`stopped absent no-op has unexpected partial ${key}`);
        }
        continue;
      }
      if (partialFact.exists) {
        if (!desiredMarker || !sameArtifact(
          { ...partialFact, key } as StoppedArtifactFact,
          requiredDesired,
        )) {
          throw new Error(`stopped partial owner mismatch ${key}`);
        }
      }
      if (backupFact.exists) {
        if (!desiredMarker || !priorMarker || !expectedPrior.exists || !sameArtifact(
          { ...backupFact, key } as StoppedArtifactFact,
          expectedPrior,
        ) || !sameArtifact(
          priorMarker,
          expectedPrior,
        )) {
          throw new Error(`stopped backup owner mismatch ${key}`);
        }
      } else if (priorMarker && !sameArtifact(priorMarker, expectedPrior)) {
        throw new Error(`orphan stopped backup marker mismatch ${key}`);
      }
    }
    return authority.artifacts;
  }

  private async verifyRolledBackStoppedEvidenceOwned(
    instanceId: string,
    txId: string,
    authority: StoppedEvidenceAuthority,
  ): Promise<void> {
    const journal = this.o.repo.nodeMigration(instanceId);
    if (
      !journal
      || journal.txId !== txId
      || journal.originalRunning
      || !['rolling_back', 'rolled_back'].includes(journal.phase)
      || authority.instanceId !== instanceId
      || authority.txId !== txId
      || authority.targetIntegrity !== journal.targetIntegrity
    ) throw new Error('rolled-back stopped evidence journal identity mismatch');
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    for (const artifact of authority.artifacts) {
      const { key, desired, prior } = artifact;
      if (!sameArtifact(await artifactFact(liveRoot, key), prior)) {
        throw new Error(`rolled-back stopped live differs from authority ${key}`);
      }
      const target = join(liveRoot, key);
      await trustedArtifactParent(liveRoot, key, false);
      const partial = stoppedSidecar(target, txId, 'partial');
      const backup = stoppedSidecar(target, txId, 'backup');
      const manifest = stoppedSidecar(target, txId, 'manifest');
      const backupManifest = stoppedSidecar(target, txId, 'backup-manifest');
      const partialFact = await artifactFact(dirname(partial), basename(partial));
      const backupFact = await artifactFact(dirname(backup), basename(backup));
      const desiredMarker = await readArtifactManifest(manifest, key);
      const priorMarker = await readArtifactManifest(backupManifest, key);
      if (desiredMarker && !sameArtifact(desiredMarker, desired)) {
        throw new Error(`rolled-back desired marker differs from authority ${key}`);
      }
      if (priorMarker && !sameArtifact(priorMarker, prior)) {
        throw new Error(`rolled-back prior marker differs from authority ${key}`);
      }
      if (partialFact.exists && (
        !desired.exists
        || !sameArtifact({ ...partialFact, key } as StoppedArtifactFact, desired)
        || (!desiredMarker && !sameArtifact(prior, desired))
      )) throw new Error(`rolled-back stopped partial differs from authority ${key}`);
      if (backupFact.exists && (
        !prior.exists
        || !priorMarker
        || !sameArtifact({ ...backupFact, key } as StoppedArtifactFact, prior)
      )) throw new Error(`rolled-back stopped backup differs from authority ${key}`);
    }
  }

  private async cleanupEqualStoppedEvidenceBeforeCommit(
    execution: MigrationExecutionSession,
    artifacts: readonly StoppedEvidenceAuthority['artifacts'][number][],
    startSequence: number,
  ): Promise<{ sequence: number; cleanedKeys: Set<string> }> {
    const liveRoot = join(this.o.instanceDataRoot, execution.instanceId);
    let sequence = startSequence;
    const cleanedKeys = new Set<string>();
    for (const artifact of artifacts) {
      const { desired, prior, postStart } = artifact;
      if (postStart.comparison !== 'exact' || !sameArtifact(prior, desired)) continue;
      const target = join(liveRoot, desired.key);
      const partial = stoppedSidecar(target, execution.txId, 'partial');
      const partialFact = await artifactFact(dirname(partial), basename(partial));
      if (!partialFact.exists) continue;
      // Strict verification proved a retained partial is an equal/no-op artifact.
      const manifest = stoppedSidecar(target, execution.txId, 'manifest');
      await rm(manifest, { force: false });
      await syncDirectory(dirname(target));
      await this.barrierOwned(execution, {
        instanceId: execution.instanceId, txId: execution.txId, phase: 'verifying',
        sequence: sequence++, artifact: this.artifactBarrierKey(desired.key),
        boundary: 'after-live-backup',
      });
      await rm(partial, { recursive: true, force: false });
      await syncDirectory(dirname(target));
      await this.barrierOwned(execution, {
        instanceId: execution.instanceId, txId: execution.txId, phase: 'verifying',
        sequence: sequence++, artifact: this.artifactBarrierKey(desired.key),
        boundary: 'after-live-rename',
      });
      cleanedKeys.add(desired.key);
    }
    return { sequence, cleanedKeys };
  }

  private async verifyInitialCommittedCleanup(
    instanceId: string,
    txId: string,
    artifacts: readonly StoppedEvidenceAuthority['artifacts'][number][],
    precleanedKeys: ReadonlySet<string>,
  ): Promise<void> {
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    for (const artifact of artifacts) {
      const { desired } = artifact;
      if (!await matchesPostStartExpectation(liveRoot, artifact.key, artifact.postStart)) {
        throw new Error(`committed live desired drift ${artifact.key}`);
      }
      const target = join(liveRoot, desired.key);
      const manifest = stoppedSidecar(target, txId, 'manifest');
      const partial = stoppedSidecar(target, txId, 'partial');
      const marker = await readArtifactManifest(manifest, desired.key);
      const partialFact = await artifactFact(dirname(partial), basename(partial));
      if (precleanedKeys.has(desired.key)) {
        if (marker || partialFact.exists) {
          throw new Error(`equal evidence cleanup was incomplete ${desired.key}`);
        }
      } else if (!marker || !sameArtifact(marker, desired)) {
        throw new Error(`initial committed desired manifest missing ${desired.key}`);
      }
    }
  }

  private async cleanupStoppedEvidence(
    instanceId: string,
    txId: string,
    phase: 'committed' | 'rolled_back' = 'committed',
  ): Promise<void> {
    if (phase === 'committed') {
      await this.verifyStoppedEvidenceOwned(instanceId, txId, true);
    } else {
      const journal = this.o.repo.nodeMigration(instanceId);
      if (!journal || journal.txId !== txId || journal.phase !== 'rolled_back') {
        throw new Error('rolled-back stopped cleanup journal mismatch');
      }
      const authority = await readStoppedAuthority(this.o.instanceDataRoot, {
        instanceId,
        txId,
        targetIntegrity: journal.targetIntegrity,
      });
      await this.verifyRolledBackStoppedEvidenceOwned(instanceId, txId, authority);
    }
    const liveRoot = join(this.o.instanceDataRoot, instanceId);
    for (const key of STOPPED_EXPORT_PATHS) {
      const target = join(liveRoot, key);
      const partial = stoppedSidecar(target, txId, 'partial');
      const backup = stoppedSidecar(target, txId, 'backup');
      const manifest = stoppedSidecar(target, txId, 'manifest');
      const backupManifest = stoppedSidecar(target, txId, 'backup-manifest');
      await rm(partial, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
      await rm(manifest, { force: true });
      await rm(backupManifest, { force: true });
      await syncExistingDirectory(dirname(target));
      for (const sidecar of [partial, backup, manifest, backupManifest]) {
        if ((await artifactFact(dirname(sidecar), basename(sidecar))).exists) {
          throw new Error(`stopped evidence cleanup did not remove ${key}`);
        }
      }
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

  private async cleanupCommittedStoppedEvidence(
    instanceId: string,
    txId: string,
    actor: string,
    initial?: {
      artifacts: readonly StoppedEvidenceAuthority['artifacts'][number][];
      precleanedKeys: ReadonlySet<string>;
    },
  ): Promise<boolean> {
    try {
      const journal = this.o.repo.nodeMigration(instanceId);
      if (!journal || journal.txId !== txId) throw new Error('committed cleanup journal mismatch');
      let authority: StoppedEvidenceAuthority;
      try {
        authority = await readStoppedAuthority(this.o.instanceDataRoot, {
          instanceId,
          txId,
          targetIntegrity: journal.targetIntegrity,
        });
      } catch (error) {
        if (initial || await this.hasStoppedOperationalEvidence(instanceId, txId)) throw error;
        await cleanupStoppedAuthorityRemainder(this.o.instanceDataRoot, instanceId, txId);
        return true;
      }
      if (initial) {
        await this.verifyInitialCommittedCleanup(
          instanceId, txId, initial.artifacts, initial.precleanedKeys,
        );
      }
      await this.cleanupStoppedEvidence(instanceId, txId);
      await cleanupStoppedAuthority(this.o.instanceDataRoot, authority, false);
      return true;
    } catch {
      try {
        this.o.repo.recordStoppedEvidenceCleanupPendingExact(
          instanceId, txId, 'committed', actor,
        );
      } catch {
        // The committed journal plus retained sidecars/checkpoint remain recovery authority.
      }
      return false;
    }
  }

  private async cleanupRolledBackStoppedTransaction(
    instanceId: string,
    txId: string,
    actor: string,
  ): Promise<boolean> {
    try {
      const journal = this.o.repo.nodeMigration(instanceId);
      if (
        !journal
        || journal.txId !== txId
        || journal.phase !== 'rolled_back'
        || journal.error !== 'none'
        || journal.originalRunning
      ) throw new Error('rolled-back stopped cleanup journal mismatch');
      let authority: StoppedEvidenceAuthority;
      try {
        authority = await readStoppedAuthority(this.o.instanceDataRoot, {
          instanceId,
          txId,
          targetIntegrity: journal.targetIntegrity,
        });
      } catch (error) {
        if (await this.hasStoppedOperationalEvidence(instanceId, txId)) throw error;
        await cleanupStoppedAuthorityRemainder(this.o.instanceDataRoot, instanceId, txId);
        if (await stoppedAuthorityRootExists(this.o.instanceDataRoot, instanceId, txId)) {
          throw new Error('rolled-back stopped authority cleanup remains ambiguous', {
            cause: error,
          });
        }
        await this.o.checkpoint.cleanupTerminal(instanceId, txId, 'rolled_back');
        return true;
      }
      await this.cleanupStoppedEvidence(instanceId, txId, 'rolled_back');
      if (await this.hasStoppedOperationalEvidence(instanceId, txId)) {
        throw new Error('rolled-back stopped sidecar cleanup remains ambiguous');
      }
      await cleanupStoppedAuthority(this.o.instanceDataRoot, authority, false);
      if (await stoppedAuthorityRootExists(this.o.instanceDataRoot, instanceId, txId)) {
        throw new Error('rolled-back stopped authority cleanup remains ambiguous');
      }
      await this.o.checkpoint.cleanupTerminal(instanceId, txId, 'rolled_back');
      return true;
    } catch {
      try {
        this.o.repo.recordStoppedEvidenceCleanupPendingExact(
          instanceId, txId, 'rolled_back', actor,
        );
      } catch {
        // The exact rolled_back journal plus remaining evidence/checkpoint stay retryable.
      }
      return false;
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
      let previous = await this.settleAndVerifyStoppedProbe(execution, handle, target);
      let exported: StoppedArtifactFact[] | undefined;
      for (let confirmation = 0; confirmation < 2; confirmation += 1) {
        execution.renew(['staged']);
        await this.o.docker.restartMigrationProbe(handle);
        const current = await this.settleAndVerifyStoppedProbe(execution, handle, target);
        if (sameArtifactFacts(previous, current)) {
          exported = current;
          break;
        }
        previous = current;
      }
      if (!exported) {
        throw controlled('verification', 'probe runtime artifact facts did not converge');
      }
      execution.renew(['staged']);
      const authority = await this.persistStoppedAuthority(journal, exported, handle.dataRoot);
      execution.renew(['staged']);
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
      const nextSequence = await this.applyStoppedArtifacts(execution, authority, 6);
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
    const claimed = this.o.repo.claimPendingStartVerifyingExact(
      instanceId,
      scanned.txId,
      owner,
      this.executionRuntime.now(),
      this.executionRuntime.leaseDurationMs,
    );
    if (!claimed) throw controlled('state-inconsistent', 'pending-start execution claim failed');
    const execution = this.startExecutionSession(instanceId, scanned.txId, owner);
    try {
      await this.reachOwned(execution, 'verifying', 200);
      execution.renew(['verifying']);
      // Validate the Manager-only authority before the one production start.
      // Live data and its operational sidecars remain untrusted until the later
      // strict post-start/precommit comparison.
      await readStoppedAuthority(this.o.instanceDataRoot, {
        instanceId,
        txId: scanned.txId,
        targetIntegrity: scanned.targetIntegrity,
      });
      await this.o.docker.start(instanceId);
      await this.o.adminRuntime.waitReady(instanceId, { timeoutMs: 30_000, intervalMs: 250 });
      await this.verifyCutover(instanceId, this.o.repo.nodeMigration(instanceId)!);
      execution.renew(['verifying']);
      const artifacts = await this.verifyStoppedEvidenceOwned(instanceId, scanned.txId);
      const equalCleanup = await this.cleanupEqualStoppedEvidenceBeforeCommit(
        execution, artifacts, 201,
      );
      const liveRoot = join(this.o.instanceDataRoot, instanceId);
      for (const artifact of artifacts) {
        if (!await matchesPostStartExpectation(liveRoot, artifact.key, artifact.postStart)) {
          throw controlled(
            'verification',
            `stopped live artifact drifted before commit ${artifact.key}`,
          );
        }
      }
      execution.renew(['verifying']);
      this.o.repo.commitNodeMigrationExact(
        instanceId, scanned.txId, owner, this.executionRuntime.now(),
        'verifying', PLATFORM_NODE_PACKAGE.version, actor,
      );
      await this.reach(instanceId, scanned.txId, 'committed', equalCleanup.sequence);
      if (!await this.cleanupCommittedStoppedEvidence(instanceId, scanned.txId, actor, {
        artifacts,
        precleanedKeys: equalCleanup.cleanedKeys,
      })) {
        return this.status(instanceId);
      }
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
    let stoppedAuthority: StoppedEvidenceAuthority | undefined;
    try {
      if (!journal.originalRunning) {
        const requiresAuthority = ['cutover', 'verifying'].includes(journal.phase)
          || await stoppedAuthorityRootExists(this.o.instanceDataRoot, instanceId, journal.txId)
          || await this.hasStoppedOperationalEvidence(instanceId, journal.txId);
        if (requiresAuthority) {
          try {
            stoppedAuthority = await readStoppedAuthority(this.o.instanceDataRoot, {
              instanceId,
              txId: journal.txId,
              targetIntegrity: journal.targetIntegrity,
            });
          } catch {
            const inspection = await this.o.docker.inspectMigrationRuntime(instanceId)
              .catch(() => undefined);
            if (inspection?.running) await this.o.docker.stop(instanceId).catch(() => undefined);
            try {
              this.o.repo.finishNodeMigrationManualExact(
                instanceId,
                journal.txId,
                execution.owner,
                this.executionRuntime.now(),
                [journal.phase],
                'rollback',
                journal.actor,
              );
              await this.reach(instanceId, journal.txId, 'manual_required', 99)
                .catch(() => undefined);
            } catch {
              // Exact owner loss leaves the replacement journal authoritative.
            }
            return this.status(instanceId);
          }
        }
      }
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
        await this.restoreStoppedArtifacts(journal, stoppedAuthority);
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
      if (!journal.originalRunning && afterRestore.running) {
        throw controlled('rollback', 'rollback changed the original stopped runtime state');
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
      if (stoppedAuthority) {
        await this.verifyRolledBackStoppedEvidenceOwned(
          instanceId, journal.txId, stoppedAuthority,
        );
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
      if (journal.originalRunning) {
        await this.cleanupTerminal(instanceId, journal.txId, 'rolled_back', journal.actor);
      } else {
        await this.cleanupRolledBackStoppedTransaction(
          instanceId, journal.txId, journal.actor,
        );
      }
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
      if (journal.phase === 'pending_start_verification' && !journal.originalRunning) {
        try {
          await readStoppedAuthority(this.o.instanceDataRoot, {
            instanceId: journal.instanceId,
            txId: journal.txId,
            targetIntegrity: journal.targetIntegrity,
          });
        } catch {
          try {
            const inspection = await this.o.docker.inspectMigrationRuntime(journal.instanceId);
            if (!inspection.running) {
              this.o.repo.finishOwnerlessPendingManualExact(
                journal.instanceId, journal.txId, 'rollback', 'system',
              );
              await this.reach(journal.instanceId, journal.txId, 'manual_required', 102)
                .catch(() => undefined);
            }
          } catch {
            // A running/unknown instance or changed pending journal must not be touched here.
          }
        }
        results.push(this.status(journal.instanceId));
        continue;
      }
      if (journal.phase === 'committed' || journal.phase === 'rolled_back') {
        if (journal.phase === 'rolled_back' && !journal.originalRunning) {
          await this.cleanupRolledBackStoppedTransaction(
            journal.instanceId, journal.txId, 'system',
          );
          results.push(this.status(journal.instanceId));
          continue;
        }
        if (
          journal.phase === 'committed'
          && !journal.originalRunning
          && !await this.cleanupCommittedStoppedEvidence(
            journal.instanceId, journal.txId, 'system',
          )
        ) {
          results.push(this.status(journal.instanceId));
          continue;
        }
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
      journal.originalRunning
        && !journal.stagedBefore
        && !['preparing', 'checkpointed'].includes(journal.phase),
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
    if (inspection.running && stagedBefore) {
      throw controlled(
        'preflight',
        'running legacy instance already has the platform package staged; '
          + 'stop the instance before retrying migration',
      );
    }
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
