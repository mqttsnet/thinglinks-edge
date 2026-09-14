import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ManagedFlowResponseTooLargeError, type InstalledModule, type SingleFlowConfig } from '../../flows/admin-client.ts';
import { diagnosticFlowReadReservation, assertDiagnosticGraphCapacity } from './flow-capacity.ts';
import type { FlowNode } from '../../flows/types.ts';
import { InstanceBusyError, type InstanceOperationGate } from '../../instance/operation-gate.ts';
import { buildModbusDiagnosticFlow, modbusDiagnosticFingerprint } from './modbus-flow.ts';
import { ProtocolDiagnosticStore, type DiagnosticRecord } from './store.ts';
import { DiagnosticError, DIAGNOSTIC_FAILURES, diagnosticFailure, type DiagnosticFailureCode, type ProtocolDiagnosticTask } from './types.ts';
import { validateConnection } from './validation.ts';
export interface DiagnosticAdminPort {
  readModules(instanceId: string): Promise<InstalledModule[]>;
  listFlows(instanceId: string, reservedBytes?: number): Promise<FlowNode[]>;
  getFlow(instanceId: string, flowId: string): Promise<SingleFlowConfig>;
  addFlow(instanceId: string, flow: SingleFlowConfig): Promise<{
    id: string;
  }>;
  deleteFlow(instanceId: string, flowId: string): Promise<void>;
}
export interface DiagnosticRuntimePort {
  inspect(instanceId: string): Promise<{
    runtimeId: string;
    generation: string;
    running: boolean;
    callbackReady: boolean;
  } | undefined>;
  exists(runtimeId: string): Promise<boolean>;
}
interface Options {
  store: ProtocolDiagnosticStore;
  gate: InstanceOperationGate;
  admin: DiagnosticAdminPort;
  runtime: DiagnosticRuntimePort;
  generationFor: (instanceId: string) => string | undefined;
  now?: () => number;
  taskId?: () => string;
  readerId?: () => string;
}
interface Job {
  done: Promise<void>;
  wake: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as {
  status?: number;
  statusCode?: number;
})?.status === 404 || (error as {
  statusCode?: number;
})?.statusCode === 404;
const failure = (code: DiagnosticFailureCode) => new DiagnosticError(code, diagnosticFailure(code).message, 409);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DiagnosticError('INVALID_CALLBACK', '试读回报格式无效。');
  return value as Record<string, unknown>;
}
function containsReference(value: unknown, ids: Set<string>): boolean {
  if (typeof value === 'string')
    return ids.has(value);
  if (Array.isArray(value))
    return value.some(v => containsReference(v, ids));
  return !!value && typeof value === 'object' && Object.values(value).some(v => containsReference(v, ids));
}
function assertModules(modules: InstalledModule[]): void {
  const module = modules.find(m => m.module === 'node-red-contrib-modbus');
  if (!module || module.version !== '5.60.2' || module.health !== 'healthy' || module.enabled === false || module.errors.length || module.observedVersions.length !== 1 || module.observedVersions[0] !== '5.60.2')
    throw failure('COMPONENT_UNAVAILABLE');
  for (const type of ['modbus-client', 'modbus-getter']) {
    const sets = modules.flatMap(m => m.nodeSets).filter(set => set.types.includes(type));
    if (sets.length !== 1 || sets[0]!.module !== module.module || sets[0]!.version !== '5.60.2' || !sets[0]!.enabled || sets[0]!.enabledKnown === false || sets[0]!.err)
      throw failure('COMPONENT_UNAVAILABLE');
  }
}
/** Owns only temporary tabs. The gate excludes Edge editor writes for the whole read/cleanup interval. */
export class ProtocolDiagnosticService {
  private readonly options: Options;
  private readonly store: ProtocolDiagnosticStore;
  private readonly now: () => number;
  private readonly jobs = new Map<string, Job>();
  private closing = false;
  private readonly restoredTasks: Set<string>;
  constructor(options: Options) { this.options = options; this.store = options.store; this.now = options.now ?? Date.now; this.restoredTasks = new Set(this.store.unfinished().map(row => row.id)); }
  get(instanceId: string, id: string): ProtocolDiagnosticTask { this.record(instanceId, id); return this.store.dto(id); }
  list(instanceId: string): ProtocolDiagnosticTask[] { return this.store.list(instanceId); }
  private record(instanceId: string, id: string): DiagnosticRecord {
    const row = this.store.get(id);
    if (!row || row.instanceId !== instanceId)
      throw new DiagnosticError('TASK_NOT_FOUND', '试读任务不存在。', 404);
    return row;
  }
  async start(instanceId: string, input: unknown, _actor: string): Promise<ProtocolDiagnosticTask> {
    if (this.closing)
      throw new DiagnosticError('DIAGNOSTIC_CLOSED', '试读服务正在关闭。', 503);
    const connection = validateConnection(input);
    const generation = this.options.generationFor(instanceId);
    if (!generation)
      throw failure('INSTANCE_UNAVAILABLE');
    const id = this.options.taskId?.() ?? randomUUID();
    const readerId = this.options.readerId?.() ?? `tld-reader-${randomUUID()}`;
    const deadline = this.now() + Math.min(125000, Math.max(10000, connection.reconnectTimeout + 2000) + connection.clientTimeout + 3000);
    const built = buildModbusDiagnosticFlow({ taskId: id, readerId, ...connection, expiresAt: deadline });
    let resolveAdmission!: (task: ProtocolDiagnosticTask) => void;
    let rejectAdmission!: (error: unknown) => void;
    const admission = new Promise<ProtocolDiagnosticTask>((resolve, reject) => { resolveAdmission = resolve; rejectAdmission = reject; });
    const job: Job = { done: Promise.resolve(), wake: () => { } };
    this.jobs.set(id, job);
    job.done = this.options.gate.run(instanceId, 'protocol-read', async () => {
      this.store.create({ id, instanceId, readerId, generation, connection, deadline, fingerprint: built.fingerprint, nodeIds: built.nodeIds });
      resolveAdmission(this.store.dto(id));
      try {
        const runtime = await this.options.runtime.inspect(instanceId);
        if (!runtime?.running || runtime.generation !== generation)
          throw failure('INSTANCE_UNAVAILABLE');
        if (!runtime.callbackReady)
          throw failure('CALLBACK_UNAVAILABLE');
        this.store.update(id, { runtimeId: runtime.runtimeId });
        assertModules(await this.options.admin.readModules(instanceId));
        if (this.shouldFinish(id))
          return;
        // Preflight the whole existing graph under the same lease. A read-only
        // capacity failure must never leave a temporary reconnecting client behind.
        try {
          const reservedBytes = diagnosticFlowReadReservation(built.flow);
          const existing = await this.options.admin.listFlows(instanceId, reservedBytes);
          assertDiagnosticGraphCapacity(existing, reservedBytes);
        } catch (error) {
          if (error instanceof DiagnosticError) throw error;
          throw failure(error instanceof ManagedFlowResponseTooLargeError ? 'FLOW_GRAPH_TOO_LARGE' : 'FLOW_GRAPH_UNREADABLE');
        }
        if (this.shouldFinish(id)) return;
        this.store.update(id, { deployAttempted: true });
        const created = await this.options.admin.addFlow(instanceId, built.flow);
        this.store.update(id, { flowId: created.id });
        const actual = await this.options.admin.getFlow(instanceId, created.id);
        if (modbusDiagnosticFingerprint(actual) !== built.fingerprint)
          throw failure('FLOW_CHANGED');
        this.store.update(id, { deployVerified: true, state: 'connecting' });
        while (!this.shouldFinish(id)) {
          await new Promise<void>(resolve => { job.wake = resolve; job.timer = setTimeout(resolve, Math.max(1, Math.min(1000, deadline - this.now()))); });
          if (job.timer)
            clearTimeout(job.timer);
        }
      }
      catch (error) {
        const row = this.store.get(id)!;
        if (!row.outcome)
          this.store.update(id, { outcome: 'failed', outcomeError: diagnosticFailure(error instanceof DiagnosticError && Object.hasOwn(DIAGNOSTIC_FAILURES, error.code) ? error.code as DiagnosticFailureCode : 'FLOW_DEPLOY_FAILED') });
      }
      finally {
        if (job.timer)
          clearTimeout(job.timer);
        await this.cleanup(id);
      }
    }).catch(error => { rejectAdmission(error instanceof InstanceBusyError ? new DiagnosticError('DIAGNOSTIC_BUSY', '实例正在执行其他操作，请稍后试读。', 409) : error); }).finally(() => { this.jobs.delete(id); });
    return admission;
  }
  private shouldFinish(id: string): boolean {
    const row = this.store.get(id)!;
    if (row.outcome)
      return true;
    if (this.closing || this.now() >= (row.leaseDeadline ? Math.min(row.deadline, row.leaseDeadline) : row.deadline)) {
      this.store.update(id, { outcome: 'failed', outcomeError: diagnosticFailure(this.closing ? 'INTERRUPTED' : row.claimAt ? 'READ_TIMEOUT' : 'CONNECT_FAILED') });
      return true;
    }
    return false;
  }
  claim(instanceId: string, id: string, input: unknown): {
    leaseToken: string;
    deadline: number;
  } {
    const body = object(input);
    const row = this.record(instanceId, id);
    if (Object.keys(body).some(k => k !== 'readerId') || body.readerId !== row.readerId)
      throw new DiagnosticError('READER_MISMATCH', '试读读取端不匹配。', 403);
    if (this.options.generationFor(instanceId) !== row.generation)
      throw failure('INSTANCE_CHANGED');
    if (this.closing || this.restoredTasks.has(id) || row.outcome || row.cleanup !== 'pending' || row.leaseHash || this.now() >= row.deadline)
      throw new DiagnosticError('CLAIM_CLOSED', '本次试读已领取或已结束。', 409);
    if (!row.deployVerified)
      throw new DiagnosticError('NOT_READY', '临时试读流程尚未就绪。', 503);
    const deadline = Math.min(row.deadline, this.now() + row.connection.clientTimeout + 2500);
    if (deadline - this.now() < row.connection.clientTimeout + 2000)
      throw new DiagnosticError('CLAIM_EXPIRED', '剩余时间不足，不能开始新的读取。', 409);
    const leaseToken = randomBytes(32).toString('base64url');
    this.store.update(id, { state: 'reading', leaseHash: hash(leaseToken), leaseDeadline: deadline, claimAt: this.now() });
    return { leaseToken, deadline };
  }
  complete(instanceId: string, id: string, input: unknown): ProtocolDiagnosticTask {
    const body = object(input);
    const row = this.record(instanceId, id);
    if (Object.keys(body).some(k => !['readerId', 'leaseToken', 'durationMs', 'registers', 'errorCode'].includes(k)))
      throw new DiagnosticError('INVALID_CALLBACK', '试读回报格式无效。');
    if (body.readerId !== row.readerId || typeof body.leaseToken !== 'string' || body.leaseToken.length > 128 || !row.leaseHash || !timingSafeEqual(Buffer.from(hash(body.leaseToken), 'hex'), Buffer.from(row.leaseHash, 'hex')))
      throw new DiagnosticError('LEASE_MISMATCH', '试读租约不匹配。', 403);
    if (this.options.generationFor(instanceId) !== row.generation)
      throw failure('INSTANCE_CHANGED');
    if (this.closing || this.restoredTasks.has(id) || row.outcome || row.cleanup !== 'pending' || this.now() >= Math.min(row.deadline, row.leaseDeadline))
      throw new DiagnosticError('RESULT_CLOSED', '本次试读已结束或租约已过期。', 409);
    if (typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0 || body.durationMs > row.leaseDeadline - row.claimAt)
      throw new DiagnosticError('INVALID_CALLBACK', '试读耗时无效。');
    if (body.errorCode !== undefined) {
      if (body.registers !== undefined || !['CONNECT_FAILED', 'READ_TIMEOUT', 'READ_FAILED', 'INVALID_RESPONSE'].includes(String(body.errorCode)))
        throw new DiagnosticError('INVALID_CALLBACK', '试读错误类型无效。');
      this.store.update(id, { outcome: 'failed', outcomeError: diagnosticFailure(body.errorCode as DiagnosticFailureCode) });
    }
    else {
      if (!Array.isArray(body.registers) || body.registers.length !== row.connection.quantity || body.registers.some(v => !Number.isInteger(v) || v < 0 || v > 65535))
        throw new DiagnosticError('INVALID_CALLBACK', '寄存器数据与本次读取范围不一致。');
      const registers = body.registers as number[];
      this.store.update(id, { outcome: 'succeeded', result: { registers, hex: registers.map(v => v.toString(16).padStart(4, '0').toUpperCase()).join(' '), durationMs: body.durationMs } });
    }
    // Let the callback response flush before deleting the flow containing its HTTP request node.
    setImmediate(() => this.jobs.get(id)?.wake());
    return this.store.dto(id);
  }
  async cancel(instanceId: string, id: string): Promise<ProtocolDiagnosticTask> {
    const row = this.record(instanceId, id);
    if (row.cleanup === 'done')
      return this.store.dto(id);
    if (!row.outcome)
      this.store.update(id, { outcome: 'cancelled' });
    const job = this.jobs.get(id);
    if (job) {
      job.wake();
      await job.done;
    }
    else
      await this.options.gate.run(instanceId, 'protocol-read', () => this.cleanup(id));
    return this.store.dto(id);
  }
  private async cleanup(id: string): Promise<void> {
    const row = this.store.get(id)!;
    try {
      if (row.deployAttempted) {
        if (!row.runtimeId)
          throw failure('INSTANCE_CHANGED');
        // Container replacement preserves /data. An old runtime 404 is never proof
        // that this task's persisted tab disappeared from its replacement.
        const originalExists = await this.options.runtime.exists(row.runtimeId);
        const current = await this.options.runtime.inspect(row.instanceId);
        if (!current?.running || current.generation !== row.generation
          || this.options.generationFor(row.instanceId) !== row.generation
          || (originalExists && current.runtimeId !== row.runtimeId)) {
          throw failure('INSTANCE_CHANGED');
        }
        const snapshot = await this.options.admin.listFlows(row.instanceId);
        const ids = new Set(row.nodeIds);
        const owned = snapshot.filter(node => ids.has(node.id));
        let flowId = row.flowId;
        if (!flowId) {
          const tabs = new Set(owned.map(node => node.z).filter((v): v is string => typeof v === 'string' && !!v));
          if (tabs.size !== 1)
            throw failure('CLEANUP_FAILED');
          flowId = [...tabs][0]!;
          this.store.update(id, { flowId });
        }
        if (snapshot.some(node => node.id !== flowId && node.z !== flowId && containsReference(node, ids)))
          throw failure('FLOW_CHANGED');
        let actual: SingleFlowConfig | undefined;
        try {
          actual = await this.options.admin.getFlow(row.instanceId, flowId);
        }
        catch (error) {
          if (!missing(error))
            throw error;
        }
        if (actual) {
          if (modbusDiagnosticFingerprint(actual) !== row.fingerprint || owned.length !== ids.size)
            throw failure('FLOW_CHANGED');
          await this.options.admin.deleteFlow(row.instanceId, flowId);
          try {
            await this.options.admin.getFlow(row.instanceId, flowId);
            throw failure('CLEANUP_FAILED');
          }
          catch (error) {
            if (!missing(error))
              throw error;
          }
        }
        const after = await this.options.admin.listFlows(row.instanceId);
        if (after.some(node => node.id === flowId || containsReference(node, ids)))
          throw failure('FLOW_CHANGED');
      }
      const latest = this.store.get(id)!;
      const error = latest.outcomeError;
      this.store.update(id, { cleanup: 'done', state: latest.outcome || 'failed', finishedAt: this.now(), ...(error ? { error } : { error: undefined }) });
    }
    catch (error) {
      this.store.update(id, { cleanup: 'failed', state: 'cleanup-required', error: diagnosticFailure(error instanceof DiagnosticError && ['FLOW_CHANGED', 'INSTANCE_CHANGED'].includes(error.code) ? error.code as DiagnosticFailureCode : 'CLEANUP_FAILED') });
    }
  }
  async recover(): Promise<void> {
    for (const row of this.store.unfinished()) {
      if (this.jobs.has(row.id))
        continue;
      if (!row.outcome)
        this.store.update(row.id, { outcome: 'failed', outcomeError: diagnosticFailure('INTERRUPTED') });
      try {
        await this.options.gate.run(row.instanceId, 'protocol-read', () => this.cleanup(row.id));
      }
      catch {
        this.store.update(row.id, { cleanup: 'failed', state: 'cleanup-required', error: diagnosticFailure('CLEANUP_FAILED') });
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [id, job] of this.jobs) {
      const row = this.store.get(id);
      if (row && !row.outcome)
        this.store.update(id, { outcome: 'failed', outcomeError: diagnosticFailure('INTERRUPTED') });
      job.wake();
    }
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
