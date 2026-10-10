import type { Db } from '../../db.ts';
import { DiagnosticError, type DiagnosticFailure, type ModbusDiagnosticConnection, type ProtocolDiagnosticTask } from './types.ts';
export interface DiagnosticRecord extends ProtocolDiagnosticTask {
  readerId: string;
  generation: string;
  runtimeId: string;
  flowId: string;
  fingerprint: string;
  nodeIds: string[];
  deployAttempted: boolean;
  deployVerified: boolean;
  outcome: '' | 'succeeded' | 'failed' | 'cancelled';
  outcomeError?: DiagnosticFailure;
  leaseHash: string;
  leaseDeadline: number;
  claimAt: number;
}
type NewRecord = Pick<DiagnosticRecord, 'id' | 'instanceId' | 'readerId' | 'generation' | 'deadline' | 'fingerprint' | 'nodeIds'> & {
  connection: ModbusDiagnosticConnection;
};
export class ProtocolDiagnosticStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly maxOutstanding: number;
  private readonly historyLimit: number;
  constructor(db: Db, options: {
    now?: () => number;
    maxOutstanding?: number;
    historyLimit?: number;
  } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.maxOutstanding = options.maxOutstanding ?? 4;
    this.historyLimit = options.historyLimit ?? 1000;
  }
  create(input: NewRecord): DiagnosticRecord {
    return this.db.transaction(() => {
      const count = this.db.prepare("SELECT COUNT(*) n FROM protocol_diagnostic WHERE cleanup != 'done'").get() as {
        n: number;
      };
      if (count.n >= this.maxOutstanding || this.unfinished().some(row => row.instanceId === input.instanceId))
        throw new DiagnosticError('DIAGNOSTIC_BUSY', '仍有试读或未清理连接，请等待完成或先重试清理。', 409);
      const record: DiagnosticRecord = { ...input, protocol: 'modbus-tcp', state: 'preparing', cleanup: 'pending', createdAt: this.now(), runtimeId: '', flowId: '', deployAttempted: false, deployVerified: false, outcome: '', leaseHash: '', leaseDeadline: 0, claimAt: 0 };
      this.db.prepare('INSERT INTO protocol_diagnostic(id,instance_id,cleanup,created_at,record_json) VALUES(?,?,?,?,?)').run(record.id, record.instanceId, record.cleanup, record.createdAt, JSON.stringify(record));
      this.db.prepare("DELETE FROM protocol_diagnostic WHERE cleanup='done' AND id NOT IN (SELECT id FROM protocol_diagnostic WHERE cleanup='done' ORDER BY created_at DESC LIMIT ?)").run(this.historyLimit);
      return record;
    })();
  }
  get(id: string): DiagnosticRecord | undefined {
    const row = this.db.prepare('SELECT record_json FROM protocol_diagnostic WHERE id=?').get(id) as {
      record_json: string;
    } | undefined;
    return row ? JSON.parse(row.record_json) as DiagnosticRecord : undefined;
  }
  update(id: string, patch: Partial<Omit<DiagnosticRecord, 'id' | 'instanceId'>>): DiagnosticRecord {
    const current = this.get(id);
    if (!current)
      throw new DiagnosticError('TASK_NOT_FOUND', '试读任务不存在。', 404);
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE protocol_diagnostic SET cleanup=?,record_json=? WHERE id=?').run(next.cleanup, JSON.stringify(next), id);
    return next;
  }
  unfinished(): DiagnosticRecord[] {
    return (this.db.prepare("SELECT record_json FROM protocol_diagnostic WHERE cleanup != 'done' ORDER BY created_at").all() as {
      record_json: string;
    }[]).map(row => JSON.parse(row.record_json) as DiagnosticRecord);
  }
  dto(id: string): ProtocolDiagnosticTask {
    const row = this.get(id);
    if (!row)
      throw new DiagnosticError('TASK_NOT_FOUND', '试读任务不存在。', 404);
    return { id: row.id, instanceId: row.instanceId, protocol: row.protocol, connection: row.connection, state: row.state, cleanup: row.cleanup, deadline: row.deadline, createdAt: row.createdAt, ...(row.finishedAt === undefined ? {} : { finishedAt: row.finishedAt }), ...(row.result ? { result: row.result } : {}), ...(row.error ? { error: row.error } : {}) };
  }
  /** Called only after the trusted removal adapter proves all owned resources absent. */
  settlePurgedInstance(instanceId: string): void {
    this.db.transaction(() => {
      for (const row of this.unfinished().filter(task => task.instanceId === instanceId)) {
        this.update(row.id, { state: 'cancelled', outcome: 'cancelled', cleanup: 'done', finishedAt: this.now(), error: undefined });
      }
    })();
  }
  list(instanceId: string): ProtocolDiagnosticTask[] {
    return (this.db.prepare("SELECT id FROM protocol_diagnostic WHERE instance_id=? ORDER BY CASE WHEN cleanup='done' THEN 1 ELSE 0 END, created_at DESC,rowid DESC LIMIT 20").all(instanceId) as {
      id: string;
    }[]).map(row => this.dto(row.id));
  }
}
