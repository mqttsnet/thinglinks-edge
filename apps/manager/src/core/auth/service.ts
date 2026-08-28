/**
 * 管理面鉴权 —— 账号、会话、首次强制改密。
 *
 * 上游 PoC 的三个致命缺陷在此处一并规避：
 *   口令明文写死在源码、WebSocket 完全无鉴权、containerId 未校验归属。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from './crypto.ts';
import { SettingsRepo } from './settings.ts';
import {
  generateSecret, verifyTotp, otpauthUrl, groupSecret,
  generateRecoveryCodes, hashRecoveryCode,
} from './totp.ts';

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
  /**
   * 全站强制两步验证、而这个人还没绑。
   *
   * 与 `mustChangePassword` 同一套处理方式：会话照发，但 guard 拦下除
   * 绑定接口以外的一切。不发会话是做不到的 —— 绑定本身就需要一个已登录的身份。
   */
  mustEnroll2fa: boolean;
  /** 这个账号自己有没有开两步验证。界面据此显示「已开启 / 去绑定」 */
  totpEnabled: boolean;
}

interface Session {
  username: string;
  createdAt: number;
  lastSeen: number;
  /**
   * 登录那一刻这个账号的口令哈希。
   *
   * 每次校验会话都拿它跟库里现在的值比一次：**口令一变，旧会话立刻作废**。
   * 不做成「改口令时顺手把会话删掉」是有原因的 —— 改口令的路径不止一条
   * （自己改、管理员重置、以后可能还有别的），漏掉任何一条都是一个
   * 「口令都换了，旧会话还能用」的洞，而这种洞不会有任何报错。
   * 放在校验侧就不需要每条路径都记得。
   */
  credential: string;
}

/**
 * 登录失败限速。
 *
 * 计数键是 **来源 IP + 用户名**，不是只按用户名：只按用户名的话，
 * 网络里任何人都能对着 `admin` 连输五次错口令，把真正的管理员锁在门外 ——
 * 那不是防护，那是一个谁都能按的拒绝服务按钮。分到 IP 上之后，
 * 攻击者锁住的只有他自己那一条路。
 *
 * 代价是分布式暴力破解每个 IP 还有五次机会。这是有意的取舍：
 * 口令最少 12 位，五次/IP 的成本远高于收益；而把现场管理员锁在门外的代价，
 * 是产线停在那儿等人打电话。
 *
 * ⚠ 部署在**不透传 `X-Forwarded-For`** 的反代后面时，所有请求看起来同源，
 * 这里会退化回按账号锁定（也就是上面那个 DoS 按钮又回来了）。
 * 那种部署必须在反代上开启 XFF —— Fastify 这边已经开了 trustProxy。
 */
/*
 * 这三个值现在由「系统设置」定（`system_setting` 表），默认值仍是这里的数。
 * 保留常量是因为 AuthService 在没有设置表的装配下也要能跑（老测试、诊断工具）。
 */
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
/** 没到阈值时计数的有效期：超过这么久没再失败就重新计 */
const FAILURE_WINDOW_MS = 15 * 60_000;
/**
 * 失败记录的条数上限。
 *
 * 这张表的键有一半来自请求（用户名随便填），不设上限就是一个
 * 「随便发请求就能把 Manager 内存吃穿」的口子 —— 边缘盒子常常只有 1~2G。
 */
const MAX_FAILURE_KEYS = 4096;
/**
 * 用户名不存在时拿来空跑一次校验的假哈希。
 *
 * 不空跑的话，「用户不存在」会比「口令错误」快一个 scrypt 的时间（几十毫秒），
 * 试探者据此就能枚举出哪些用户名是真的 —— 那正是下面那段注释想避免的事。
 */
const DUMMY_HASH = hashPassword('\u0000no-such-user');
const SESSION_IDLE_MS = 8 * 60 * 60_000;

interface Failure {
  count: number;
  /** 计数窗口到期时刻；到点后重新从 1 开始计 */
  resetAt: number;
  /** 锁定到期时刻；0 表示没锁 */
  lockedUntil: number;
}

/**
 * 口令过了、但还差第二因子时发的临时票据。
 *
 * 存在的理由：第二步得知道「刚才是谁通过了口令」，而这时**还不能发会话** ——
 * 发了就等于一步登录，第二因子成了摆设。票据一次性、五分钟过期、
 * 只能换一个会话，换完即焚。
 */
interface Pending {
  username: string;
  expiresAt: number;
}

/** 第二因子的等待时长。太短会让手忙脚乱的人反复重来，太长等于把口令这一关的成果挂着 */
const PENDING_TTL_MS = 5 * 60_000;

export type LoginResult =
  | { sid: string; user: SessionUser }
  /** 口令对了，但这个账号开了两步验证。拿 ticket 去 `verifySecondFactor` */
  | { mfa: true; ticket: string };

export class AuthService {
  private readonly db: Db;
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, Failure>();
  private readonly pending = new Map<string, Pending>();
  private readonly settings: SettingsRepo;
  /**
   * 主密钥。只用来加密 TOTP 密钥，与实例凭据、云端 signKey 同一套。
   *
   * 可缺省是为了让不碰两步验证的装配（老单测、诊断工具）不必造一把密钥；
   * `index.ts` always 传，所以生产上一定有。缺了就一律拒绝启用两步验证，
   * 而不是悄悄用一个明文密钥顶上。
   */
  private readonly key: Buffer | undefined;

  constructor(db: Db, key?: Buffer) {
    this.db = db;
    this.key = key;
    this.settings = new SettingsRepo(db);
  }

  /** 主密钥缺失时不让启用两步验证 —— 密钥明文落库比不开两步验证更糟 */
  private requireKey(): Buffer {
    if (!this.key) {
      throw new AuthError('本部署未提供主密钥，无法启用两步验证');
    }
    return this.key;
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

  /** 计数键：同一个用户名从不同来源来的失败互不牵连 */
  private static failureKey(username: string, client: string): string {
    return `${client}\u0000${username}`;
  }

  /**
   * 清掉过期记录，并把表压回上限以内。
   *
   * 淘汰时**先丢没锁的**：不然攻击者只要灌满 4096 个随机用户名，
   * 就能把自己刚被锁上的那条记录挤掉，锁定形同虚设。
   */
  private sweepFailures(now: number): void {
    for (const [k, f] of this.failures) {
      if (f.lockedUntil <= now && f.resetAt <= now) this.failures.delete(k);
    }
    if (this.failures.size < MAX_FAILURE_KEYS) return;
    for (const [k, f] of this.failures) {
      if (this.failures.size < MAX_FAILURE_KEYS) break;
      if (f.lockedUntil <= now) this.failures.delete(k);
    }
  }

  private lockRemaining(key: string, now: number): number {
    const f = this.failures.get(key);
    if (!f) return 0;
    return Math.max(0, f.lockedUntil - now);
  }

  /**
   * 记一次失败。
   *
   * 锁定期内再失败**不顺延**锁定时间 —— 顺延的话，一个每隔几分钟试一次的脚本
   * 就能让账号永远解不开锁，那正是上面要避免的那个拒绝服务按钮。
   */
  private noteFailure(key: string, now: number): void {
    this.sweepFailures(now);
    const f = this.failures.get(key);
    if (!f || now >= f.resetAt) {
      if (this.failures.size >= MAX_FAILURE_KEYS) return; // 表满且全在锁定中，不再新增
      this.failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS, lockedUntil: 0 });
      return;
    }
    if (f.lockedUntil > now) return;
    const { loginMaxFailures, loginLockMin } = this.settings.get();
    f.count += 1;
    if (f.count >= loginMaxFailures) {
      f.lockedUntil = now + loginLockMin * 60_000;
      // 锁一到期，计数一并清零：重新给满五次，而不是解锁后一次失败又锁上
      f.resetAt = f.lockedUntil;
    }
  }

  /**
   * 登录。
   *
   * `client` 是来源标识（通常是对端 IP），用于把失败计数分摊到来源上，
   * 见 MAX_FAILURES 处的说明。取不到时退回 `unknown`，行为等同于旧的按用户名计数。
   */
  login(username: string, password: string, client = 'unknown'): LoginResult {
    const now = Date.now();
    const key = AuthService.failureKey(username, client);
    const remaining = this.lockRemaining(key, now);
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
    // 用户不存在时空跑一次校验：不跑的话，「查无此人」会比「口令错误」
    // 快一个 scrypt 的时间，响应时间本身就成了一个用户名枚举接口
    if (row === undefined) verifyPassword(password, DUMMY_HASH);
    const passwordOk = row !== undefined &&
      verifyPassword(password, { hash: row['pwd_hash'] as string, salt: row['pwd_salt'] as string });
    const ok = passwordOk && !disabled;

    if (!ok) {
      this.noteFailure(key, now);
      throw new AuthError('用户名或口令错误');
    }

    this.failures.delete(key);

    /*
     * 开了两步验证就到此为止，**不发会话**，只发一张一次性票据。
     *
     * 这里是两步验证成立与否的分界：只要在这一步把 sid 发出去，
     * 后面那一步验不验都无所谓了 —— 拿着 Cookie 直接调接口就行。
     */
    if (Number(row['totp_enabled'] ?? 0) === 1) {
      return { mfa: true, ticket: this.issuePending(username, now) };
    }

    return this.issueSession(username, row, now);
  }

  /** 发会话。登录与第二因子两条路都汇到这里，凭据快照只在这一处取 */
  private issueSession(username: string, row: Record<string, unknown>, now: number):
  { sid: string; user: SessionUser } {
    const sid = randomBytes(24).toString('hex');
    this.sessions.set(sid, {
      username, createdAt: now, lastSeen: now,
      credential: String(row['pwd_hash'] ?? ''),
    });
    const totpEnabled = Number(row['totp_enabled'] ?? 0) === 1;
    return {
      sid,
      user: {
        username,
        role: row['role'] as string,
        mustChangePassword: row['must_change_pwd'] === 1,
        mustEnroll2fa: this.settings.get().require2fa && !totpEnabled,
        totpEnabled,
      },
    };
  }

  private issuePending(username: string, now: number): string {
    // 顺手清掉过期票据。数量本来就少，不值得单起一个定时器
    for (const [t, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(t);
    const ticket = randomBytes(24).toString('hex');
    this.pending.set(ticket, { username, expiresAt: now + PENDING_TTL_MS });
    return ticket;
  }

  /**
   * 第二因子。验证码或恢复码都收。
   *
   * 失败同样计入登录限速 —— 只挡口令不挡验证码的话，六位数字就成了
   * 一个可以无限次尝试的接口，一百万种组合撑不了多久。
   */
  verifySecondFactor(ticket: string, code: string, client = 'unknown'): { sid: string; user: SessionUser } {
    const now = Date.now();
    const p = this.pending.get(ticket);
    if (!p || p.expiresAt <= now) {
      this.pending.delete(ticket);
      throw new AuthError('验证已超时，请重新登录');
    }

    const key = AuthService.failureKey(p.username, client);
    const remaining = this.lockRemaining(key, now);
    if (remaining > 0) {
      throw new AuthError(`账号已锁定，请 ${Math.ceil(remaining / 1000)} 秒后重试`);
    }

    const row = this.db.prepare('SELECT * FROM app_user WHERE username = ?').get(p.username) as
      Record<string, unknown> | undefined;
    if (!row || Number(row['disabled'] ?? 0) === 1) {
      this.pending.delete(ticket);
      throw new AuthError('用户名或口令错误');
    }

    const secret = this.readSecret(row);
    const trimmed = code.trim();
    const result = verifyTotp(secret, trimmed, {
      lastStep: Number(row['totp_last_step'] ?? 0),
    });

    let ok = result.ok;
    if (ok) {
      // 记下用过的时间步，同一个码再提交一次就不认了
      this.db.prepare('UPDATE app_user SET totp_last_step = ? WHERE username = ?')
        .run(result.step, p.username);
    } else {
      ok = this.consumeRecoveryCode(p.username, trimmed);
    }

    if (!ok) {
      this.noteFailure(key, now);
      throw new AuthError('验证码不正确');
    }

    // 票据一次性：换到会话就作废，截到也重放不了
    this.pending.delete(ticket);
    this.failures.delete(key);
    return this.issueSession(p.username, row, now);
  }

  /** 会话校验；空闲超时即失效 */
  resolve(sid: string | undefined): SessionUser | undefined {
    if (!sid) return undefined;
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    const idleMs = this.settings.get().sessionIdleMin * 60_000;
    if (Date.now() - s.lastSeen > idleMs) {
      this.sessions.delete(sid);
      return undefined;
    }
    s.lastSeen = Date.now();
    const row = this.db.prepare(
      'SELECT role, must_change_pwd, disabled, pwd_hash, totp_enabled FROM app_user WHERE username = ?',
    ).get(s.username) as
      { role: string; must_change_pwd: number; disabled: number; pwd_hash: string;
        totp_enabled: number } | undefined;
    if (!row) { this.sessions.delete(sid); return undefined; }
    // 停用要**立即**生效，不能等会话自然过期 —— 否则「已停用」在现场是句空话
    if (Number(row.disabled) === 1) return undefined;
    /*
     * 口令变了就作废旧会话。管理员重置某人口令之后，那个人手上的会话
     * 必须当场失效 —— 重置口令的场景往往就是「这个人不该再进来了」或
     * 「他的凭据可能泄漏了」，旧会话还活着的话，重置这个动作等于没做。
     */
    if (row.pwd_hash !== s.credential) { this.sessions.delete(sid); return undefined; }
    const totpEnabled = row.totp_enabled === 1;
    return {
      username: s.username,
      role: row.role,
      mustChangePassword: row.must_change_pwd === 1,
      // 每次都重算：管理员刚打开「强制两步验证」，在线的人下一个请求就该被拦去绑定
      mustEnroll2fa: this.settings.get().require2fa && !totpEnabled,
      totpEnabled,
    };
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
    // 改密后一律踢下线，避免旧会话继续可用。
    // resolve 里的凭据比对已经能兜住，这里主动删是为了立刻释放内存
    this.revokeUser(username);
  }

  /** 踢掉某个账号的全部会话。管理员重置口令、停用账号时调 */
  revokeUser(username: string): number {
    let n = 0;
    for (const [sid, s] of this.sessions) {
      if (s.username === username) { this.sessions.delete(sid); n += 1; }
    }
    // 半路的第二因子票据一并作废：会话都踢了，留着票据等于留了一扇后门
    for (const [t, p] of this.pending) if (p.username === username) this.pending.delete(t);
    return n;
  }

  // ── 两步验证 ──────────────────────────────────────────

  private readSecret(row: Record<string, unknown>): string {
    const enc = String(row['totp_secret_enc'] ?? '');
    if (enc === '' || !this.key) return '';
    try {
      return decryptSecret(enc, this.key);
    } catch {
      // 主密钥换过、或者库被改坏。回空串让验证失败，而不是把异常抛到登录路径上
      return '';
    }
  }

  /**
   * 开始绑定：生成密钥并**暂存**，但不启用。
   *
   * 分两步是必须的 —— 直接启用的话，用户的验证器要是没扫成功（扫错、时钟不对、
   * 中途关掉），账号立刻就进不去了。必须先证明他能算出正确的码，再启用。
   *
   * 重复调用会换一把新密钥，之前扫的那个二维码随即失效。这是有意的：
   * 「我重新来一遍」是最自然的补救动作，不该还认着上一次的密钥。
   */
  beginTotpEnroll(username: string, issuer = 'ThingLinks Edge'):
  { secret: string; grouped: string; otpauth: string } {
    const key = this.requireKey();
    const row = this.db.prepare('SELECT totp_enabled FROM app_user WHERE username = ?')
      .get(username) as { totp_enabled: number } | undefined;
    if (!row) throw new AuthError('账号不存在');
    if (row.totp_enabled === 1) throw new AuthError('已经绑定过两步验证，请先解绑再重新绑定');

    const secret = generateSecret();
    this.db.prepare('UPDATE app_user SET totp_secret_enc = ?, totp_last_step = 0 WHERE username = ?')
      .run(encryptSecret(secret, key), username);
    return {
      secret,
      grouped: groupSecret(secret),
      otpauth: otpauthUrl({ issuer, account: username, secret }),
    };
  }

  /**
   * 确认绑定：验一次码，通过才真正启用，并一次性给出恢复码。
   *
   * 恢复码**只在这一刻给一次**，之后库里只有哈希。这不是苛刻 ——
   * 能随时再看一遍的恢复码，和把它写在便签上贴屏幕没有区别。
   */
  confirmTotpEnroll(username: string, code: string): string[] {
    this.requireKey();
    const row = this.db.prepare('SELECT * FROM app_user WHERE username = ?').get(username) as
      Record<string, unknown> | undefined;
    if (!row) throw new AuthError('账号不存在');
    if (Number(row['totp_enabled'] ?? 0) === 1) throw new AuthError('已经绑定过两步验证');

    const secret = this.readSecret(row);
    if (secret === '') throw new AuthError('还没有开始绑定，请先获取密钥');

    const result = verifyTotp(secret, code.trim(), { lastStep: Number(row['totp_last_step'] ?? 0) });
    if (!result.ok) throw new AuthError('验证码不正确，请确认手机时间准确后重试');

    const codes = generateRecoveryCodes();
    const insert = this.db.prepare('INSERT INTO recovery_code (username, code_hash) VALUES (?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM recovery_code WHERE username = ?').run(username);
      for (const c of codes) insert.run(username, hashRecoveryCode(c));
      this.db.prepare('UPDATE app_user SET totp_enabled = 1, totp_last_step = ? WHERE username = ?')
        .run(result.step, username);
    })();
    return codes;
  }

  /**
   * 自己解绑。要口令 —— 会话可能是别人趁人离座时用的，
   * 只凭一个已登录的会话就能关掉两步验证，那这层防护形同虚设。
   */
  disableTotp(username: string, password: string): void {
    const row = this.db.prepare('SELECT pwd_hash, pwd_salt FROM app_user WHERE username = ?')
      .get(username) as { pwd_hash: string; pwd_salt: string } | undefined;
    if (!row || !verifyPassword(password, { hash: row.pwd_hash, salt: row.pwd_salt })) {
      throw new AuthError('口令不正确');
    }
    if (this.settings.get().require2fa) {
      throw new AuthError('系统已要求全员启用两步验证，不能自行解绑');
    }
    this.clearTotp(username);
  }

  /**
   * 管理员强制解绑。用于「验证器丢了、恢复码也没了」——
   * 这条路必须存在，否则一台手机丢失就意味着一个账号永久锁死。
   */
  clearTotp(username: string): void {
    this.db.transaction(() => {
      this.db.prepare(
        'UPDATE app_user SET totp_secret_enc = \'\', totp_enabled = 0, totp_last_step = 0 WHERE username = ?',
      ).run(username);
      this.db.prepare('DELETE FROM recovery_code WHERE username = ?').run(username);
    })();
    this.revokeUser(username);
  }

  /** 还剩几条没用过的恢复码。界面要能提醒「只剩两条了」 */
  recoveryCodesLeft(username: string): number {
    const r = this.db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_code WHERE username = ? AND used_at IS NULL',
    ).get(username) as { n: number };
    return r.n;
  }

  /**
   * 核销一条恢复码。
   *
   * 用掉即作废（标 `used_at` 而不是删行）—— 留着痕迹，管理员事后能看出
   * 「这个账号是靠恢复码进来的」，那往往意味着某人的验证器出了问题。
   */
  private consumeRecoveryCode(username: string, code: string): boolean {
    const hash = hashRecoveryCode(code);
    const info = this.db.prepare(
      'UPDATE recovery_code SET used_at = datetime(\'now\') WHERE username = ? AND code_hash = ? AND used_at IS NULL',
    ).run(username, hash);
    return info.changes > 0;
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
