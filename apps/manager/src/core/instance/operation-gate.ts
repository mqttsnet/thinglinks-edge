import type { InstanceRepo, NodeMigrationState } from './repo.ts';

export type InstanceOperation =
  | 'create-instance'
  | 'start-instance'
  | 'stop-instance'
  | 'remove-instance'
  | 'reset-credential'
  | 'upgrade-image'
  | 'same-image-rebuild'
  | 'apply-node-policy'
  | 'install-node'
  | 'flow-write'
  | 'proxy-write'
  | 'platform-migration';

const LEASE_BRAND: unique symbol = Symbol('instance-operation-lease');

export interface InstanceOperationLease {
  readonly [LEASE_BRAND]: true;
  readonly instanceId: string;
  readonly operation: InstanceOperation;
}

export interface RepositoryOperationPolicy {
  assertAllowed(instanceId: string, operation: InstanceOperation): void;
}

/** The single error shape used for both live and durable per-instance fences. */
export class InstanceBusyError extends Error {
  readonly code = 'INSTANCE_BUSY';
  readonly instanceId: string;
  readonly activeOperation: InstanceOperation;
  readonly requestedOperation: InstanceOperation;

  constructor(
    instanceId: string,
    activeOperation: InstanceOperation,
    requestedOperation: InstanceOperation,
    detail = '',
  ) {
    super(
      `实例 ${instanceId} 正在执行 ${activeOperation}，不能开始 ${requestedOperation}`
      + (detail ? `（${detail}）` : ''),
    );
    this.name = 'InstanceBusyError';
    this.instanceId = instanceId;
    this.activeOperation = activeOperation;
    this.requestedOperation = requestedOperation;
  }
}

const ORDINARY_SAFE_STATES = new Set<NodeMigrationState>([
  'idle',
  'committed',
  'rolled_back',
]);

/**
 * Durable half of the gate.
 *
 * The in-memory lease map disappears on Manager restart, while the repository
 * projection does not. Every incomplete or dirty migration therefore remains
 * fenced until recovery reaches a clean terminal state. The one exception is
 * the explicit start that owns pending-start verification.
 */
export class InstanceRepositoryOperationPolicy implements RepositoryOperationPolicy {
  private readonly repo: Pick<InstanceRepo, 'nodeRuntime' | 'nodeMigration'>;

  constructor(repo: Pick<InstanceRepo, 'nodeRuntime' | 'nodeMigration'>) {
    this.repo = repo;
  }

  assertAllowed(instanceId: string, operation: InstanceOperation): void {
    const runtime = this.repo.nodeRuntime(instanceId);
    if (!runtime) return;
    const journal = this.repo.nodeMigration(instanceId);
    if (!journal && runtime.migrationState !== 'idle') {
      throw new InstanceBusyError(
        instanceId,
        'platform-migration',
        operation,
        `持久化迁移状态不一致：projection ${runtime.migrationState}/${runtime.migrationError}`
          + '，journal missing',
      );
    }
    if (
      journal
      && (
        runtime.migrationState !== journal.phase
        || runtime.migrationError !== journal.error
      )
    ) {
      throw new InstanceBusyError(
        instanceId,
        'platform-migration',
        operation,
        `持久化迁移状态不一致：projection ${runtime.migrationState}/${runtime.migrationError}`
          + `，journal ${journal.phase}/${journal.error}`,
      );
    }
    if (
      runtime.migrationError === 'none'
      && ORDINARY_SAFE_STATES.has(runtime.migrationState)
    ) return;
    if (
      runtime.migrationError === 'none'
      && runtime.migrationState === 'pending_start_verification'
      && operation === 'start-instance'
    ) return;

    throw new InstanceBusyError(
      instanceId,
      'platform-migration',
      operation,
      `持久化迁移状态 ${runtime.migrationState}/${runtime.migrationError}`,
    );
  }
}

const issuedLeases = new WeakSet<object>();

export class InstanceOperationGate {
  private readonly active = new Map<string, InstanceOperationLease>();
  private readonly policy: RepositoryOperationPolicy;

  constructor(policy: RepositoryOperationPolicy) {
    this.policy = policy;
  }

  current(instanceId: string): InstanceOperation | undefined {
    return this.active.get(instanceId)?.operation;
  }

  async run<T>(
    instanceId: string,
    operation: InstanceOperation,
    work: (lease: InstanceOperationLease) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire(instanceId, operation);
    try {
      return await work(lease);
    } finally {
      this.release(lease);
    }
  }

  async runOrCurrent<T>(
    instanceId: string,
    operation: 'platform-migration',
    current: () => T | Promise<T>,
    work: (lease: InstanceOperationLease) => Promise<T>,
  ): Promise<T> {
    const active = this.active.get(instanceId);
    if (active) {
      if (active.operation === operation) return await current();
      throw new InstanceBusyError(instanceId, active.operation, operation);
    }

    const lease = this.acquire(instanceId, operation);
    try {
      return await work(lease);
    } finally {
      this.release(lease);
    }
  }

  assertLease(
    lease: InstanceOperationLease,
    instanceId: string,
    allowed: readonly InstanceOperation[],
  ): void {
    if (
      typeof lease !== 'object'
      || lease === null
      || !issuedLeases.has(lease)
      || this.active.get(lease.instanceId) !== lease
    ) {
      throw new Error('instance operation lease is invalid or no longer active');
    }
    if (lease.instanceId !== instanceId) {
      throw new Error(
        `instance operation lease belongs to ${lease.instanceId}, not ${instanceId}`,
      );
    }
    if (!allowed.includes(lease.operation)) {
      throw new Error(
        `instance operation lease ${lease.operation} cannot authorize this operation`,
      );
    }
  }

  private acquire(instanceId: string, operation: InstanceOperation): InstanceOperationLease {
    const active = this.active.get(instanceId);
    if (active) throw new InstanceBusyError(instanceId, active.operation, operation);

    this.policy.assertAllowed(instanceId, operation);
    const lease: InstanceOperationLease = {
      [LEASE_BRAND]: true,
      instanceId,
      operation,
    };
    issuedLeases.add(lease);
    this.active.set(instanceId, lease);
    return lease;
  }

  private release(lease: InstanceOperationLease): void {
    if (this.active.get(lease.instanceId) === lease) this.active.delete(lease.instanceId);
  }
}
