/**
 * 实例元数据仓储。
 *
 * 端口分配遵循「用户自填、系统只推荐」：现场工程师通常已有既定端口规划，
 * 系统硬分配反而添乱。系统负责的是冲突检测与范围校验。
 */
import type { Db } from '../db.ts';
import { recordAudit } from '../db.ts';
import { encryptSecret, decryptSecret } from '../auth/crypto.ts';
import { redact } from '../diag/redact.ts';

export type NodeRuntimeMode = 'legacy' | 'npm';

export type NodeMigrationState =
  | 'idle'
  | 'preparing'
  | 'checkpointed'
  | 'staged'
  | 'cutover'
  | 'verifying'
  | 'pending_start_verification'
  | 'rolling_back'
  | 'committed'
  | 'rolled_back'
  | 'rolled_back_dirty'
  | 'manual_required';

type NodeMigrationPhase = Exclude<NodeMigrationState, 'idle'>;
type NodeMigrationOperationKind = 'bootstrap' | 'migration';

export interface InstanceNodeRuntime {
  mode: NodeRuntimeMode;
  platformVersion: string;
  migrationState: NodeMigrationState;
  migrationError: string;
}

export interface InstanceNodeMigrationJournal {
  instanceId: string;
  txId: string;
  operationKind: NodeMigrationOperationKind;
  phase: NodeMigrationPhase;
  originalRunning: boolean;
  stagedBefore: boolean;
  modeBefore: NodeRuntimeMode;
  imageIdBefore: string;
  targetIntegrity: string;
  checkpointDir: string;
  snapshotJson: string;
  actor: string;
  startedAt: string;
  updatedAt: string;
  error: string;
}

export interface BeginNodeMigrationInput {
  instanceId: string;
  txId: string;
  operationKind: NodeMigrationOperationKind;
  phase: NodeMigrationPhase;
  originalRunning: boolean;
  stagedBefore: boolean;
  modeBefore: NodeRuntimeMode;
  imageIdBefore: string;
  targetIntegrity: string;
  checkpointDir: string;
  snapshotJson: string;
  actor: string;
}

const NODE_RUNTIME_MODES = ['legacy', 'npm'] as const;
const NODE_MIGRATION_PHASES = [
  'preparing', 'checkpointed', 'staged', 'cutover', 'verifying',
  'pending_start_verification', 'rolling_back', 'committed',
  'rolled_back', 'rolled_back_dirty', 'manual_required',
] as const;
const NODE_MIGRATION_KINDS = ['bootstrap', 'migration'] as const;
const SNAPSHOT_HASH_KEYS = new Set([
  'settingsSha256', 'flowsSha256', 'credentialsSha256', 'packageSha256', 'lockSha256',
]);
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_MIGRATION_ERROR = 2_000;
const PROJECTION_MISMATCH_ERROR = '迁移日志与实例状态投影不一致，已停止自动恢复';

function requireEnum(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new RepoError(`${label} 无效：${value}`);
}

function requireSafeText(value: string, label: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new RepoError(`${label} 无效`);
  }
  if (redact(value) !== value) throw new RepoError(`${label} 不得包含凭据`);
}

function safeMigrationError(error: string): string {
  if (typeof error !== 'string') throw new RepoError('迁移错误必须是字符串');
  return redact(error).slice(0, MAX_MIGRATION_ERROR);
}

function safeSnapshotJson(snapshotJson: string): string {
  if (typeof snapshotJson !== 'string' || Buffer.byteLength(snapshotJson, 'utf8') > 2_048) {
    throw new RepoError('迁移快照无效');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    throw new RepoError('迁移快照必须是 JSON 对象');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new RepoError('迁移快照必须是 JSON 对象');
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SNAPSHOT_HASH_KEYS.has(key) || typeof value !== 'string' || !SHA256_HEX.test(value)) {
      throw new RepoError(`迁移快照字段无效：${key}`);
    }
  }
  return JSON.stringify(parsed);
}

function validateCheckpointDir(input: BeginNodeMigrationInput, snapshotJson: string): void {
  if (input.checkpointDir === '') {
    if (
      input.operationKind === 'bootstrap'
      && input.modeBefore === 'legacy'
      && input.originalRunning === false
      && input.stagedBefore === false
      && snapshotJson === '{}'
    ) return;
    throw new RepoError('只有尚无旧数据的 bootstrap 可使用空检查点路径');
  }
  if (!PATH_SEGMENT.test(input.instanceId)) throw new RepoError('实例 id 不能用于检查点路径');
  const expected = `.thinglinks-migration/${input.instanceId}/${input.txId}`;
  if (input.checkpointDir !== expected) {
    throw new RepoError(`检查点路径必须由 Manager 管理：${expected}`);
  }
}

export interface InstanceRecord {
  id: string;
  name: string;
  imageTag: string;
  memLimit: number;
  cpuLimit: number;
  adminRoot: string;
  credSecret: string;
  notes: string;
  /** 旧调用方不传时保持 legacy；Task 7 会让新建 npm 实例显式传入 */
  nodeRuntimeMode?: NodeRuntimeMode;
}

export interface PortRecord {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp: string;
  purpose: string;
}

export interface CredRecord {
  username: string;
  password: string;
  permissions: '*' | 'read';
}

export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoError';
  }
}

export class InstanceRepo {
  // 不用 TS 参数属性：node --experimental-strip-types 为纯剥离模式，不支持需要代码生成的语法
  private readonly db: Db;
  /** 备份要用它算 MASTER_KEY 指纹，故对外只读 */

  readonly key: Buffer;

  constructor(db: Db, key: Buffer) {
    this.db = db;
    this.key = key;
    this.reconcileNodeMigrationProjection();
  }

  create(rec: InstanceRecord, ports: PortRecord[], creds: CredRecord[]): void {
    if (creds.length === 0) throw new RepoError('至少需要一个实例账号');
    const nodeRuntimeMode = rec.nodeRuntimeMode ?? 'legacy';
    requireEnum(nodeRuntimeMode, NODE_RUNTIME_MODES, '节点运行模式');

    this.db.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM instance WHERE id = ?').get(rec.id);
      if (exists) throw new RepoError(`实例 ${rec.id} 已存在`);

      this.db.prepare(
        `INSERT INTO instance
          (id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret, notes, node_runtime_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rec.id, rec.name, rec.imageTag, rec.memLimit, rec.cpuLimit, rec.adminRoot,
        rec.credSecret, rec.notes, nodeRuntimeMode,
      );

      for (const p of ports) this.bindPort(rec.id, p);
      for (const c of creds) {
        this.db.prepare(
          'INSERT INTO instance_cred (instance_id, username, pwd_enc, permissions) VALUES (?, ?, ?, ?)',
        ).run(rec.id, c.username, encryptSecret(c.password, this.key), c.permissions);
      }
    })();
  }

  get(id: string): InstanceRecord | undefined {
    const r = this.db.prepare('SELECT * FROM instance WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      name: r['name'] as string,
      imageTag: r['image_tag'] as string,
      memLimit: r['mem_limit'] as number,
      cpuLimit: r['cpu_limit'] as number,
      adminRoot: r['admin_root'] as string,
      credSecret: r['cred_secret'] as string,
      notes: r['notes'] as string,
    };
  }

  list(): InstanceRecord[] {
    const rows = this.db.prepare('SELECT id FROM instance ORDER BY created_at').all() as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!).filter(Boolean);
  }

  remove(id: string): void {
    const info = this.db.prepare('DELETE FROM instance WHERE id = ?').run(id);
    if (info.changes === 0) throw new RepoError(`实例 ${id} 不存在`);
  }

  // ── 端口 ────────────────────────────────────────────────

  /** 绑定端口；宿主端口全局唯一，冲突时报出占用方便于排查 */
  /**
   * 换镜像版本。只改这一个字段 —— 端口、凭据、adminRoot、credSecret 一概不动，
   * 因为升级的定义就是「换个版本继续跑同一台实例」，其余任何改动都是别的操作。
   */
  setImageTag(instanceId: string, imageTag: string): void {
    const info = this.db.prepare('UPDATE instance SET image_tag = ? WHERE id = ?')
      .run(imageTag, instanceId);
    if (info.changes === 0) throw new RepoError(`实例 ${instanceId} 不存在`);
  }

  bindPort(instanceId: string, p: PortRecord): void {
    const owner = this.db.prepare(
      'SELECT instance_id FROM port_map WHERE host_port = ?',
    ).get(p.hostPort) as { instance_id: string } | undefined;
    if (owner) {
      throw new RepoError(`宿主端口 ${p.hostPort} 已被实例 ${owner.instance_id} 占用`);
    }
    this.db.prepare(
      `INSERT INTO port_map (instance_id, host_port, container_port, protocol, host_ip, purpose)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(instanceId, p.hostPort, p.containerPort, p.protocol, p.hostIp, p.purpose);
  }

  ports(instanceId: string): PortRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM port_map WHERE instance_id = ? ORDER BY host_port',
    ).all(instanceId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      hostPort: r['host_port'] as number,
      containerPort: r['container_port'] as number,
      protocol: r['protocol'] as 'tcp' | 'udp',
      hostIp: r['host_ip'] as string,
      purpose: r['purpose'] as string,
    }));
  }

  usedPorts(): Map<number, string> {
    const rows = this.db.prepare('SELECT host_port, instance_id FROM port_map').all() as
      Array<{ host_port: number; instance_id: string }>;
    return new Map(rows.map((r) => [r.host_port, r.instance_id]));
  }

  // ── 凭据 ────────────────────────────────────────────────

  /** 取出实例账号明文 —— 免密跳转要用它向 Node-RED 换 access_token */
  /**
   * 设置实例的接入令牌（`@thinglinks` 节点回报台账时用）。
   *
   * 与 Node-RED 管理口令分开：那个是给人用的、会被重置；这个是给节点用的、
   * 随实例生命周期。加密存储，因为容器重建时要能重新注入。
   */
  setIngestToken(instanceId: string, token: string): void {
    this.db.prepare('UPDATE instance SET ingest_token_enc = ? WHERE id = ?')
      .run(encryptSecret(token, this.key), instanceId);
  }

  ingestToken(instanceId: string): string | undefined {
    const row = this.db.prepare('SELECT ingest_token_enc FROM instance WHERE id = ?')
      .get(instanceId) as { ingest_token_enc?: string } | undefined;
    if (!row?.ingest_token_enc) return undefined;
    return decryptSecret(row.ingest_token_enc, this.key);
  }

  /**
   * 令牌 → 实例 id 的全表映射，供接入鉴权建缓存。
   *
   * 不在每次请求时逐条解密比对：点位值上报是高频路径，
   * 每条都做 N 次 AES 是白扔 CPU。
   */
  allIngestTokens(): Map<string, string> {
    const rows = this.db.prepare(
      "SELECT id, ingest_token_enc FROM instance WHERE ingest_token_enc != ''",
    ).all() as Array<{ id: string; ingest_token_enc: string }>;
    const out = new Map<string, string>();
    for (const r of rows) out.set(decryptSecret(r.ingest_token_enc, this.key), r.id);
    return out;
  }

  credentials(instanceId: string): CredRecord[] {
    const rows = this.db.prepare(
      'SELECT username, pwd_enc, permissions FROM instance_cred WHERE instance_id = ? ORDER BY id',
    ).all(instanceId) as Array<{ username: string; pwd_enc: string; permissions: string }>;
    return rows.map((r) => ({
      username: r.username,
      password: decryptSecret(r.pwd_enc, this.key),
      permissions: r.permissions as '*' | 'read',
    }));
  }

  resetCredential(instanceId: string, username: string, password: string): void {
    const info = this.db.prepare(
      'UPDATE instance_cred SET pwd_enc = ? WHERE instance_id = ? AND username = ?',
    ).run(encryptSecret(password, this.key), instanceId, username);
    if (info.changes === 0) throw new RepoError(`实例 ${instanceId} 下没有账号 ${username}`);
  }

  // ── Node-RED 平台节点运行模式与迁移日志 ───────────────────

  nodeRuntime(instanceId: string): InstanceNodeRuntime | undefined {
    const row = this.db.prepare(
      `SELECT node_runtime_mode, platform_node_version,
              node_migration_state, node_migration_error
       FROM instance WHERE id = ?`,
    ).get(instanceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      mode: row['node_runtime_mode'] as NodeRuntimeMode,
      platformVersion: row['platform_node_version'] as string,
      migrationState: row['node_migration_state'] as NodeMigrationState,
      migrationError: row['node_migration_error'] as string,
    };
  }

  beginNodeMigration(input: BeginNodeMigrationInput): void {
    requireEnum(input.operationKind, NODE_MIGRATION_KINDS, '迁移操作类型');
    requireEnum(input.phase, NODE_MIGRATION_PHASES, '迁移阶段');
    requireEnum(input.modeBefore, NODE_RUNTIME_MODES, '迁移前运行模式');
    if (!TX_ID.test(input.txId)) throw new RepoError('迁移事务 id 无效');
    if (typeof input.originalRunning !== 'boolean' || typeof input.stagedBefore !== 'boolean') {
      throw new RepoError('迁移运行状态必须是布尔值');
    }
    requireSafeText(input.imageIdBefore, '迁移前镜像 id', 256);
    if (!SHA512_INTEGRITY.test(input.targetIntegrity)) throw new RepoError('目标包完整性无效');
    requireSafeText(input.actor, '操作人', 128);
    const snapshotJson = safeSnapshotJson(input.snapshotJson);
    validateCheckpointDir(input, snapshotJson);

    this.db.transaction(() => {
      const instance = this.db.prepare('SELECT 1 FROM instance WHERE id = ?').get(input.instanceId);
      if (!instance) throw new RepoError(`实例 ${input.instanceId} 不存在`);
      const existing = this.db.prepare(
        'SELECT 1 FROM instance_node_migration WHERE instance_id = ?',
      ).get(input.instanceId);
      if (existing) throw new RepoError(`实例 ${input.instanceId} 已有迁移日志`);

      // 日志是恢复依据，必须先落库，再在同一事务内推进 UI 投影。
      this.db.prepare(
        `INSERT INTO instance_node_migration
          (instance_id, tx_id, operation_kind, phase, original_running, staged_before,
           mode_before, image_id_before, target_integrity, checkpoint_dir,
           snapshot_json, actor, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      ).run(
        input.instanceId, input.txId, input.operationKind, input.phase,
        input.originalRunning ? 1 : 0, input.stagedBefore ? 1 : 0,
        input.modeBefore, input.imageIdBefore, input.targetIntegrity,
        input.checkpointDir, snapshotJson, input.actor,
      );
      this.db.prepare(
        `UPDATE instance
         SET node_migration_state = ?, node_migration_error = ''
         WHERE id = ?`,
      ).run(input.phase, input.instanceId);
    })();
  }

  updateNodeMigration(instanceId: string, phase: NodeMigrationPhase, error = ''): void {
    requireEnum(phase, NODE_MIGRATION_PHASES, '迁移阶段');
    if (phase === 'committed') throw new RepoError('committed 必须通过最终提交事务写入');
    const safeError = safeMigrationError(error);
    this.db.transaction(() => {
      const journal = this.db.prepare(
        `UPDATE instance_node_migration
         SET phase = ?, error = ?, updated_at = datetime('now')
         WHERE instance_id = ?`,
      ).run(phase, safeError, instanceId);
      if (journal.changes === 0) throw new RepoError(`实例 ${instanceId} 没有迁移日志`);
      const projection = this.db.prepare(
        `UPDATE instance
         SET node_migration_state = ?, node_migration_error = ?
         WHERE id = ?`,
      ).run(phase, safeError, instanceId);
      if (projection.changes === 0) throw new RepoError(`实例 ${instanceId} 不存在`);
    })();
  }

  commitNodeMigration(instanceId: string, platformVersion: string, actor: string): void {
    requireSafeText(platformVersion, '平台节点版本', 128);
    requireSafeText(actor, '操作人', 128);
    this.db.transaction(() => {
      const journal = this.db.prepare(
        `UPDATE instance_node_migration
         SET phase = 'committed', error = '', updated_at = datetime('now')
         WHERE instance_id = ?`,
      ).run(instanceId);
      if (journal.changes === 0) throw new RepoError(`实例 ${instanceId} 没有迁移日志`);
      const projection = this.db.prepare(
        `UPDATE instance
         SET node_runtime_mode = 'npm', platform_node_version = ?,
             node_migration_state = 'committed', node_migration_error = ''
         WHERE id = ?`,
      ).run(platformVersion, instanceId);
      if (projection.changes === 0) throw new RepoError(`实例 ${instanceId} 不存在`);
      recordAudit(this.db, {
        actor,
        action: 'commit-node-migration',
        target: instanceId,
        detail: `platformVersion=${platformVersion}`,
        result: 'ok',
      });
    })();
  }

  nodeMigration(instanceId: string): InstanceNodeMigrationJournal | undefined {
    const row = this.db.prepare(
      'SELECT * FROM instance_node_migration WHERE instance_id = ?',
    ).get(instanceId) as Record<string, unknown> | undefined;
    return row ? this.mapNodeMigration(row) : undefined;
  }

  interruptedNodeMigrations(): InstanceNodeMigrationJournal[] {
    const rows = this.db.prepare(
      `SELECT * FROM instance_node_migration
       WHERE phase NOT IN ('committed', 'rolled_back')
       ORDER BY started_at, instance_id`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapNodeMigration(row));
  }

  private mapNodeMigration(row: Record<string, unknown>): InstanceNodeMigrationJournal {
    return {
      instanceId: row['instance_id'] as string,
      txId: row['tx_id'] as string,
      operationKind: row['operation_kind'] as NodeMigrationOperationKind,
      phase: row['phase'] as NodeMigrationPhase,
      originalRunning: row['original_running'] === 1,
      stagedBefore: row['staged_before'] === 1,
      modeBefore: row['mode_before'] as NodeRuntimeMode,
      imageIdBefore: row['image_id_before'] as string,
      targetIntegrity: row['target_integrity'] as string,
      checkpointDir: row['checkpoint_dir'] as string,
      snapshotJson: row['snapshot_json'] as string,
      actor: row['actor'] as string,
      startedAt: row['started_at'] as string,
      updatedAt: row['updated_at'] as string,
      error: row['error'] as string,
    };
  }

  private reconcileNodeMigrationProjection(): void {
    const mismatches = this.db.prepare(
      `SELECT m.instance_id
       FROM instance_node_migration m
       JOIN instance i ON i.id = m.instance_id
       WHERE i.node_migration_state != m.phase OR i.node_migration_error != m.error`,
    ).all() as Array<{ instance_id: string }>;
    if (mismatches.length === 0) return;

    this.db.transaction(() => {
      const updateJournal = this.db.prepare(
        `UPDATE instance_node_migration
         SET phase = 'manual_required', error = ?, updated_at = datetime('now')
         WHERE instance_id = ?`,
      );
      const updateProjection = this.db.prepare(
        `UPDATE instance
         SET node_migration_state = 'manual_required', node_migration_error = ?
         WHERE id = ?`,
      );
      for (const row of mismatches) {
        updateJournal.run(PROJECTION_MISMATCH_ERROR, row.instance_id);
        updateProjection.run(PROJECTION_MISMATCH_ERROR, row.instance_id);
      }
    })();
  }
}
