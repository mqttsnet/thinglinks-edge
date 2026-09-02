import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getFlows,
  getInstalledModules,
  stageModule,
  uninstallModule,
  type InstalledModule,
} from '../flows/admin-client.ts';
import type { InstanceAdminRuntime } from '../instance/admin-runtime.ts';
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
}

export interface PlatformMigrationAdminActions {
  installedModules(instanceId: string): Promise<InstalledModule[]>;
  stagePlatformModule(instanceId: string): Promise<InstalledModule>;
  uninstallPlatformModule(instanceId: string): Promise<void>;
  currentFlows(instanceId: string): Promise<unknown>;
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
  barrier: PlatformNodeOperationBarrier;
  instanceDataRoot: string;
  txId?: (() => string) | undefined;
}

interface PreflightFacts {
  inspection: PlatformMigrationContainerInspection;
  snapshot: MigrationNodeMigrationSnapshot;
  stagedBefore: boolean;
  flowIdentity: string;
}

const TARGET_TYPES = new Set<string>(PLATFORM_NODE_TYPES);
const IMAGE_ID = /^sha256:[a-fA-F0-9]{64}$/;

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

function flowEvidenceHealthy(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return !!value && typeof value === 'object' && Array.isArray((value as { flows?: unknown }).flows);
}

function flowIdentity(value: unknown): string | undefined {
  if (!flowEvidenceHealthy(value)) return undefined;
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') return undefined;
  return hash(serialized);
}

function samePreflightFacts(left: PreflightFacts, right: PreflightFacts): boolean {
  return left.stagedBefore === right.stagedBefore
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

export class PlatformMigrationService {
  private readonly o: PlatformMigrationServiceOptions;

  constructor(options: PlatformMigrationServiceOptions) {
    this.o = options;
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
    await this.o.proxySessions.closeAndDrain(instanceId, { code: 1012, timeoutMs: 5_000 });

    // Proxy drain is the only mutation between the two passes. Re-read every mutable
    // fact immediately before the durable journal and reject any drift.
    const facts = await this.preflight(instanceId);
    if (!samePreflightFacts(initialFacts, facts)) {
      throw controlled('preflight', 'migration facts changed while editor sessions drained');
    }
    const txId = this.o.txId?.() ?? `migration-${randomUUID()}`;
    const checkpointDir = `.thinglinks-migration/${instanceId}/${txId}`;
    let journalOwned = false;
    let installedByTx = false;
    let failureCode: NodeMigrationErrorCode = 'checkpoint';
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
          ...(replaceRolledBackTxId ? { replaceRolledBackTxId } : {}),
        });
        journalOwned = this.o.repo.nodeMigration(instanceId)?.txId === txId;
      } catch (error) {
        const current = this.o.repo.nodeMigration(instanceId);
        if (current && current.txId !== txId) return this.status(instanceId);
        if (error instanceof RepoError) throw controlled('preflight', 'migration journal precondition changed');
        throw error;
      }
      await this.reach(instanceId, txId, 'preparing', 1);
      await this.o.checkpoint.create(instanceId, txId);
      assertCheckpointMatchesPreflight(
        await this.o.checkpoint.verify(instanceId, txId),
        facts.snapshot,
      );

      this.o.repo.updateNodeMigration(instanceId, 'checkpointed');
      await this.reach(instanceId, txId, 'checkpointed', 2);

      failureCode = 'install';
      if (!facts.stagedBefore) {
        // A POST can mutate and then fail/lose its response. Persist ownership before it.
        this.o.repo.updateNodeMigration(instanceId, 'staged');
        await this.reach(instanceId, txId, 'staged', 3);
        installedByTx = true;
        this.o.platformPackages.verifyForInstall();
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
        this.o.repo.updateNodeMigration(instanceId, 'staged');
        await this.reach(instanceId, txId, 'staged', 3);
      }

      failureCode = 'cutover';
      this.o.repo.updateNodeMigration(instanceId, 'cutover');
      await this.reach(instanceId, txId, 'cutover', 4);
      const settings = this.o.settings.renderNodeSettingsUnderLease(instanceId, lease, 'npm');
      await this.o.docker.writeSettings(instanceId, settings);
      await this.o.barrier.reach({
        instanceId,
        txId,
        phase: 'cutover',
        sequence: 5,
        artifact: 'settings',
        boundary: 'after-settings-write',
      });
      await this.o.docker.restart(instanceId);
      await this.o.adminRuntime.waitReady(instanceId, { timeoutMs: 30_000, intervalMs: 250 });

      failureCode = 'verification';
      this.o.repo.updateNodeMigration(instanceId, 'verifying');
      await this.reach(instanceId, txId, 'verifying', 6);
      await this.verifyCutover(
        instanceId,
        this.o.repo.nodeMigration(instanceId)!,
        facts.flowIdentity,
      );
      this.o.repo.commitNodeMigration(instanceId, PLATFORM_NODE_PACKAGE.version, actor);
      await this.reach(instanceId, txId, 'committed', 7);
      await this.cleanupTerminal(instanceId, txId, 'committed', actor);
      return this.status(instanceId);
    } catch (error) {
      if (!journalOwned) {
        if (error instanceof PlatformMigrationError) throw error;
        throw controlled('preflight', 'migration preflight failed');
      }
      if (this.o.repo.nodeMigration(instanceId)?.phase === 'committed') {
        // A verifier interruption after the atomic final commit must never run rollback.
        return this.status(instanceId);
      }
      const cause = error instanceof PlatformMigrationError
        ? error
        : controlled(failureCode, `${failureCode} external operation failed`);
      return this.rollbackUnderLease(instanceId, cause, lease, installedByTx);
    }
  }

  async rollback(instanceId: string, cause: unknown): Promise<PlatformMigrationResult> {
    const existing = this.o.repo.nodeMigration(instanceId);
    if (!existing) return this.status(instanceId);
    if (['committed', 'rolled_back', 'rolled_back_dirty', 'manual_required'].includes(existing.phase)) {
      return this.status(instanceId);
    }
    const controlledCause = cause instanceof PlatformMigrationError
      ? cause
      : controlled('rollback', 'rollback requested after a controlled migration failure');
    // The durable gate correctly fences interrupted rows, so recovery must use the
    // exact journal rather than attempting an ordinary new migration lease.
    return this.rollbackExactJournal(
      instanceId,
      controlledCause,
      !existing.stagedBefore && !['preparing', 'checkpointed'].includes(existing.phase),
    );
  }

  private async rollbackUnderLease(
    instanceId: string,
    cause: PlatformMigrationError,
    lease: InstanceOperationLease,
    installedByTx: boolean,
  ): Promise<PlatformMigrationResult> {
    this.o.gate.assertLease(lease, instanceId, ['platform-migration']);
    return this.rollbackExactJournal(instanceId, cause, installedByTx);
  }

  /** Recovery path: operate only on the durable exact journal, never reacquire its blocked gate. */
  private async rollbackExactJournal(
    instanceId: string,
    cause: PlatformMigrationError,
    installedByTx: boolean,
  ): Promise<PlatformMigrationResult> {
    const journal = this.o.repo.nodeMigration(instanceId);
    if (!journal) return this.status(instanceId);
    let cleanupDirty = false;
    try {
      this.o.repo.updateNodeMigration(instanceId, 'rolling_back', cause.code);
      await this.reach(instanceId, journal.txId, 'rolling_back', 100);
      if (installedByTx && !journal.stagedBefore) {
        cleanupDirty = await this.cleanupAttemptedInstall(instanceId);
      }
      if (journal.originalRunning) await this.o.docker.stop(instanceId);
      await this.o.checkpoint.restore(instanceId, journal.txId);
      await this.o.checkpoint.verifyLive(instanceId, journal.txId);
      const afterRestore = await this.o.docker.inspectMigrationRuntime(instanceId);
      if (afterRestore.imageId !== journal.imageIdBefore) {
        throw controlled('rollback', 'rollback immutable image identity changed');
      }
      if (journal.originalRunning) {
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
        if (!flowEvidenceHealthy(await this.o.admin.currentFlows(instanceId))) {
          throw controlled('rollback', 'legacy flow health could not be restored');
        }
      }
      if (cleanupDirty) {
        this.o.repo.finishNodeMigrationRollback(
          instanceId,
          'rolled_back_dirty',
          journal.actor,
        );
        await this.reach(instanceId, journal.txId, 'rolled_back_dirty', 101)
          .catch(() => undefined);
        return this.status(instanceId);
      }
      this.o.repo.finishNodeMigrationRollback(instanceId, 'rolled_back', journal.actor);
      try {
        await this.reach(instanceId, journal.txId, 'rolled_back', 101);
      } catch {
        return this.status(instanceId);
      }
      await this.cleanupTerminal(instanceId, journal.txId, 'rolled_back', journal.actor);
      return this.status(instanceId);
    } catch {
      try {
        this.o.repo.finishNodeMigrationManual(instanceId, 'rollback', journal.actor);
        await this.reach(instanceId, journal.txId, 'manual_required', 102)
          .catch(() => undefined);
      } catch {
        // Existing journal/projection reconciliation remains the recovery authority.
      }
      return this.status(instanceId);
    }
  }

  async recoverInterrupted(): Promise<PlatformMigrationResult[]> {
    const results: PlatformMigrationResult[] = [];
    for (const journal of this.o.repo.nodeMigrations()) {
      if (journal.operationKind !== 'migration') continue;
      if (journal.phase === 'preparing') {
        let ready: boolean;
        try {
          ready = await this.o.checkpoint.readyExists(journal.instanceId, journal.txId);
        } catch {
          this.o.repo.finishNodeMigrationManual(journal.instanceId, 'checkpoint', journal.actor);
          results.push(this.status(journal.instanceId));
          continue;
        }
        if (!ready) {
          try {
            await this.o.checkpoint.cleanupPartial(journal.instanceId, journal.txId);
            this.o.repo.updateNodeMigration(journal.instanceId, 'rolling_back', 'checkpoint');
            await this.reach(journal.instanceId, journal.txId, 'rolling_back', 100);
            this.o.repo.finishNodeMigrationRollback(journal.instanceId, 'rolled_back', journal.actor);
            await this.cleanupTerminal(journal.instanceId, journal.txId, 'rolled_back', journal.actor);
          } catch {
            this.o.repo.finishNodeMigrationManual(journal.instanceId, 'rollback', journal.actor);
          }
          results.push(this.status(journal.instanceId));
          continue;
        }
      }
      if (journal.phase === 'committed' || journal.phase === 'rolled_back') {
        await this.cleanupTerminal(
          journal.instanceId,
          journal.txId,
          journal.phase,
          'system',
        );
      } else if (
        ['preparing', 'checkpointed', 'staged', 'cutover', 'verifying', 'rolling_back']
          .includes(journal.phase)
      ) {
        results.push(await this.rollbackExactJournal(
          journal.instanceId,
          controlled('rollback', 'interrupted migration recovery requested'),
          !journal.stagedBefore && !['preparing', 'checkpointed'].includes(journal.phase),
        ));
        continue;
      }
      results.push(this.status(journal.instanceId));
    }
    return results;
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
    if (!inspection.running) throw controlled('preflight', 'Task 8 requires an originally running instance');
    if (!IMAGE_ID.test(inspection.imageId)) throw controlled('preflight', 'immutable image id is missing or invalid');
    const expected = this.o.docker.expectedMigrationEnvironment();
    const environment = exactEnvironment(inspection.environment);
    if (
      !expected.managerUrl
      || normalizeManagerUrl(environment.get('TLE_MANAGER_URL') ?? '')
        !== normalizeManagerUrl(expected.managerUrl)
    ) throw controlled('preflight', 'normalized Manager URL identity mismatch');
    if (
      !expected.npmRegistry
      || environment.get('NPM_CONFIG_REGISTRY') !== expected.npmRegistry
    ) throw controlled('preflight', 'private registry identity mismatch');
    if (environment.get('TLE_INSTANCE_ID') !== instanceId) {
      throw controlled('preflight', 'container instance identity mismatch');
    }
    if (!safeDigestEqual(
      environment.get('TLE_INGEST_TOKEN'),
      this.o.repo.ingestToken(instanceId),
    )) throw controlled('preflight', 'container ingest token digest mismatch');

    const legacyManifest = await this.verifyLegacyFiles(instanceId);
    let modules: InstalledModule[];
    try {
      modules = await this.o.admin.installedModules(instanceId);
    } catch {
      throw controlled('preflight', 'Admin inventory preflight failed');
    }
    assertRawOwners(modules);
    const platformModules = modules.filter((module) => module.module === PLATFORM_NODE_PACKAGE.name);
    if (platformModules.length > 1) {
      throw controlled('preflight', 'preexisting platform package inventory is ambiguous');
    }
    const stagedBefore = platformModules.length === 1;
    const footprint = await this.platformFootprint(instanceId);
    if (stagedBefore) {
      assertStagedEvidence(platformModules[0]!);
      if (!footprint) throw controlled('preflight', 'preexisting platform package is partial on disk');
      await verifyInstalledPlatformFiles({
        instanceDataRoot: this.o.instanceDataRoot,
        instanceId,
        readFile,
      }).catch(() => {
        throw controlled('preflight', 'preexisting platform package integrity is invalid');
      });
    } else if (footprint) {
      throw controlled('preflight', 'partial platform package files exist without Admin inventory');
    }

    let preflightFlowIdentity: string;
    try {
      preflightFlowIdentity = flowIdentity(await this.o.admin.currentFlows(instanceId)) ?? '';
      if (!preflightFlowIdentity) throw controlled('preflight', 'existing flow preflight is unhealthy');
    } catch (error) {
      if (error instanceof PlatformMigrationError) throw error;
      throw controlled('preflight', 'existing flow preflight failed');
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
      nodeInventorySha256: hash(stableInventory(modules)),
    };
    return { inspection, snapshot, stagedBefore, flowIdentity: preflightFlowIdentity };
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

  private async platformFootprint(instanceId: string): Promise<boolean> {
    const root = join(this.o.instanceDataRoot, instanceId);
    const candidates = [
      join(root, 'node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'), 'package.json'),
      join(root, 'node_modules', '@mqttsnet', 'thinglinks-node-red-common', 'package.json'),
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
        if ((await readFile(join(root, path), 'utf8')).includes(PLATFORM_NODE_PACKAGE.name)) {
          return true;
        }
      } catch {
        // Missing/invalid root files are handled by the checkpoint snapshot and install verifier.
      }
    }
    return false;
  }

  /** A POST may have changed disk or Admin state even when it rejects; clean both facts first. */
  private async cleanupAttemptedInstall(instanceId: string): Promise<boolean> {
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
    expectedFlowIdentity: string,
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
    const flow = await this.o.admin.currentFlows(instanceId).catch(() => undefined);
    if (!flowEvidenceHealthy(flow) || flowIdentity(flow) !== expectedFlowIdentity) {
      throw controlled('verification', 'existing flow health check failed');
    }
  }
}
