/**
 * 用户与实例授权矩阵的存取（T4.4）。
 *
 * 与 `AuthService` 分工：那边管**会话**（登录、CSRF、改密），这边管**账号与授权**。
 * 分开是因为会话是热路径、账号管理是低频操作，混在一起会让前者被后者的复杂度拖累。
 */
import { hashPassword, generatePassword } from './crypto.ts';
import type { Db } from './db.ts';
import { ROLES, type GrantLevel, type Role } from './authz.ts';

export interface UserRecord {
  username: string;
  role: string;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface GrantRecord {
  username: string;
  instanceId: string;
  level: GrantLevel;
  grantedBy: string;
  grantedAt: string;
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{2,31}$/;

export class UserRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(): UserRecord[] {
    const rows = this.db.prepare(
      'SELECT username, role, disabled, must_change_pwd, created_at FROM app_user ORDER BY username',
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      username: String(r['username']),
      role: String(r['role']),
      disabled: Number(r['disabled']) === 1,
      mustChangePassword: Number(r['must_change_pwd']) === 1,
      createdAt: String(r['created_at']),
    }));
  }

  get(username: string): UserRecord | undefined {
    return this.list().find((u) => u.username === username);
  }

  /** 新建用户，返回一次性初始口令。**口令只在这里出现一次**，不落库明文 */
  create(username: string, role: Role, actor: string): string {
    if (!USERNAME_RE.test(username)) {
      throw new UserError('用户名需 3~32 位，字母开头，仅含字母数字与 . _ -');
    }
    if (!ROLES.includes(role)) throw new UserError(`未知角色：${role}`);
    if (this.get(username)) throw new UserError(`用户 ${username} 已存在`);

    const password = generatePassword();
    const { hash, salt } = hashPassword(password);
    this.db.prepare(
      `INSERT INTO app_user (username, pwd_hash, pwd_salt, role, must_change_pwd, disabled)
       VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(username, hash, salt, role);
    void actor;
    return password;
  }

  setRole(username: string, role: Role): void {
    if (!ROLES.includes(role)) throw new UserError(`未知角色：${role}`);
    this.assertExists(username);
    this.#assertNotLastAdmin(username, role === 'admin');
    this.db.prepare('UPDATE app_user SET role = ? WHERE username = ?').run(role, username);
  }

  /**
   * 停用而不是删除：审计里记的是用户名，删掉之后那些记录就失去指向了。
   * 停用后立即登录不了，已有会话由 AuthService 在 resolve 时判掉。
   */
  setDisabled(username: string, disabled: boolean): void {
    this.assertExists(username);
    this.#assertNotLastAdmin(username, !disabled);
    this.db.prepare('UPDATE app_user SET disabled = ? WHERE username = ?')
      .run(disabled ? 1 : 0, username);
  }

  /** 重置口令，返回一次性新口令并强制下次登录改密 */
  resetPassword(username: string): string {
    this.assertExists(username);
    const password = generatePassword();
    const { hash, salt } = hashPassword(password);
    this.db.prepare(
      'UPDATE app_user SET pwd_hash = ?, pwd_salt = ?, must_change_pwd = 1 WHERE username = ?',
    ).run(hash, salt, username);
    return password;
  }

  /**
   * 不能把最后一个可用的 admin 降级或停用 —— 那会把所有人锁在门外，
   * 且没有任何补救入口（本平台没有「忘记密码」流程）。
   */
  #assertNotLastAdmin(username: string, stillAdminAfter: boolean): void {
    if (stillAdminAfter) return;
    const others = this.list().filter(
      (u) => u.role === 'admin' && !u.disabled && u.username !== username,
    );
    if (others.length === 0) {
      throw new UserError('这是最后一个可用的管理员，不能停用或降级 —— 否则无人能再登录');
    }
  }

  private assertExists(username: string): void {
    if (!this.get(username)) throw new UserError(`用户 ${username} 不存在`);
  }

  // ── 实例授权矩阵 ──────────────────────────────────────────

  grants(username: string): GrantRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM instance_grant WHERE username = ? ORDER BY instance_id',
    ).all(username) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      username: String(r['username']),
      instanceId: String(r['instance_id']),
      level: String(r['level']) as GrantLevel,
      grantedBy: String(r['granted_by']),
      grantedAt: String(r['granted_at']),
    }));
  }

  /** 单点查询，鉴权热路径用 */
  grantFor(username: string, instanceId: string): GrantLevel | undefined {
    const row = this.db.prepare(
      'SELECT level FROM instance_grant WHERE username = ? AND instance_id = ?',
    ).get(username, instanceId) as { level?: string } | undefined;
    return row?.level as GrantLevel | undefined;
  }

  grant(username: string, instanceId: string, level: GrantLevel, actor: string): void {
    if (level !== 'view' && level !== 'operate') throw new UserError(`未知授权档位：${level}`);
    this.assertExists(username);
    this.db.prepare(
      `INSERT INTO instance_grant (username, instance_id, level, granted_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(username, instance_id) DO UPDATE SET
         level = excluded.level, granted_by = excluded.granted_by, granted_at = datetime('now')`,
    ).run(username, instanceId, level, actor);
  }

  revoke(username: string, instanceId: string): void {
    this.db.prepare('DELETE FROM instance_grant WHERE username = ? AND instance_id = ?')
      .run(username, instanceId);
  }

  /** 授权矩阵全貌，控制台画表格用 */
  matrix(): GrantRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM instance_grant ORDER BY username, instance_id',
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      username: String(r['username']),
      instanceId: String(r['instance_id']),
      level: String(r['level']) as GrantLevel,
      grantedBy: String(r['granted_by']),
      grantedAt: String(r['granted_at']),
    }));
  }
}
