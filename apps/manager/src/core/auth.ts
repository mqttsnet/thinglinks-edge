/**
 * 管理面鉴权 —— 账号、会话、首次强制改密。
 *
 * 上游 PoC 的三个致命缺陷在此处一并规避：
 *   口令明文写死在源码、WebSocket 完全无鉴权、containerId 未校验归属。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { hashPassword, verifyPassword } from './crypto.ts';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SessionUser {
  username: string;
  role: string;
  mustChangePassword: boolean;
}

interface Session {
  username: string;
  createdAt: number;
  lastSeen: number;
}

/** 登录失败限速：同一账号短时间内多次失败即锁定 */
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
const SESSION_IDLE_MS = 8 * 60 * 60_000;

export class AuthService {
  private readonly db: Db;
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(db: Db) {
    this.db = db;
  }

  /** 首次启动创建初始账号，标记必须改密 */
  ensureInitialUser(username: string, password: string): boolean {
    const exists = this.db.prepare('SELECT 1 FROM app_user LIMIT 1').get();
    if (exists) return false;
    const { hash, salt } = hashPassword(password);
    this.db.prepare(
      'INSERT INTO app_user (username, pwd_hash, pwd_salt, role, must_change_pwd) VALUES (?, ?, ?, ?, 1)',
    ).run(username, hash, salt, 'admin');
    return true;
  }

  private lockRemaining(username: string): number {
    const f = this.failures.get(username);
    if (!f || f.count < MAX_FAILURES) return 0;
    return Math.max(0, f.until - Date.now());
  }

  login(username: string, password: string): { sid: string; user: SessionUser } {
    const remaining = this.lockRemaining(username);
    if (remaining > 0) {
      throw new AuthError(`账号已锁定，请 ${Math.ceil(remaining / 1000)} 秒后重试`);
    }

    const row = this.db.prepare('SELECT * FROM app_user WHERE username = ?').get(username) as
      Record<string, unknown> | undefined;

    /*
     * 停用的账号一律按「用户名或口令错误」处理，**不单独提示「账号已停用」** ——
     * 那等于告诉试探者这个用户名存在。口令校验照跑，避免响应时间上的差异泄漏。
     */
    const disabled = row !== undefined && Number(row['disabled'] ?? 0) === 1;
    const passwordOk = row !== undefined &&
      verifyPassword(password, { hash: row['pwd_hash'] as string, salt: row['pwd_salt'] as string });
    const ok = passwordOk && !disabled;

    if (!ok) {
      const f = this.failures.get(username) ?? { count: 0, until: 0 };
      f.count += 1;
      f.until = Date.now() + LOCK_MS;
      this.failures.set(username, f);
      throw new AuthError('用户名或口令错误');
    }

    this.failures.delete(username);
    const sid = randomBytes(24).toString('hex');
    const now = Date.now();
    this.sessions.set(sid, { username, createdAt: now, lastSeen: now });
    return {
      sid,
      user: {
        username,
        role: row['role'] as string,
        mustChangePassword: row['must_change_pwd'] === 1,
      },
    };
  }

  /** 会话校验；空闲超时即失效 */
  resolve(sid: string | undefined): SessionUser | undefined {
    if (!sid) return undefined;
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
      this.sessions.delete(sid);
      return undefined;
    }
    s.lastSeen = Date.now();
    const row = this.db.prepare(
      'SELECT role, must_change_pwd, disabled FROM app_user WHERE username = ?',
    ).get(s.username) as { role: string; must_change_pwd: number; disabled: number } | undefined;
    // 停用要**立即**生效，不能等会话自然过期 —— 否则「已停用」在现场是句空话
    if (row && Number(row.disabled) === 1) return undefined;
    if (!row) return undefined;
    return { username: s.username, role: row.role, mustChangePassword: row.must_change_pwd === 1 };
  }

  /** 登出：服务端销毁会话，而不只是让浏览器删 Cookie */
  logout(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
  }

  changePassword(username: string, oldPassword: string, newPassword: string): void {
    if (newPassword.length < 12) {
      throw new AuthError('新口令至少 12 位');
    }
    const row = this.db.prepare('SELECT pwd_hash, pwd_salt FROM app_user WHERE username = ?')
      .get(username) as { pwd_hash: string; pwd_salt: string } | undefined;
    if (!row || !verifyPassword(oldPassword, { hash: row.pwd_hash, salt: row.pwd_salt })) {
      throw new AuthError('原口令不正确');
    }
    const { hash, salt } = hashPassword(newPassword);
    this.db.prepare('UPDATE app_user SET pwd_hash = ?, pwd_salt = ?, must_change_pwd = 0 WHERE username = ?')
      .run(hash, salt, username);
    // 改密后一律踢下线，避免旧会话继续可用
    for (const [sid, s] of this.sessions) if (s.username === username) this.sessions.delete(sid);
  }

  /**
   * Origin 校验 —— 浏览器不对 WebSocket 施加同源策略，
   * 仅靠 Cookie 会被跨站 WebSocket 劫持（CSWSH）。
   */
  static originAllowed(origin: string | undefined, allowed: string[]): boolean {
    if (!origin) return true; // 非浏览器发起（如脚本、探针）不带 Origin
    return allowed.includes(origin);
  }

  /** CSRF：比对双提交令牌，定长比较避免时序泄漏 */
  static csrfOk(headerToken: string | undefined, cookieToken: string | undefined): boolean {
    if (!headerToken || !cookieToken) return false;
    const a = Buffer.from(headerToken);
    const b = Buffer.from(cookieToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
