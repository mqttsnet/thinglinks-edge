/**
 * 实例元数据仓储。
 *
 * 端口分配遵循「用户自填、系统只推荐」：现场工程师通常已有既定端口规划，
 * 系统硬分配反而添乱。系统负责的是冲突检测与范围校验。
 */
import type { Db } from '../db.ts';
import { encryptSecret, decryptSecret } from '../auth/crypto.ts';

export interface InstanceRecord {
  id: string;
  name: string;
  imageTag: string;
  memLimit: number;
  cpuLimit: number;
  adminRoot: string;
  credSecret: string;
  notes: string;
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
  }

  create(rec: InstanceRecord, ports: PortRecord[], creds: CredRecord[]): void {
    if (creds.length === 0) throw new RepoError('至少需要一个实例账号');

    this.db.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM instance WHERE id = ?').get(rec.id);
      if (exists) throw new RepoError(`实例 ${rec.id} 已存在`);

      this.db.prepare(
        `INSERT INTO instance (id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(rec.id, rec.name, rec.imageTag, rec.memLimit, rec.cpuLimit, rec.adminRoot, rec.credSecret, rec.notes);

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
}
