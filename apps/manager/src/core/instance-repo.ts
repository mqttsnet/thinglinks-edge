/**
 * 实例元数据仓储。
 *
 * 端口分配遵循「用户自填、系统只推荐」：现场工程师通常已有既定端口规划，
 * 系统硬分配反而添乱。系统负责的是冲突检测与范围校验。
 */
import type { Db } from './db.ts';
import { encryptSecret, decryptSecret } from './crypto.ts';

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
  private readonly key: Buffer;

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
