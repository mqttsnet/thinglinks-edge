/**
 * 系统设置 —— 单行表，只装**运行期可改**的那几项。
 *
 * 什么该进来、什么不该，是这个模块唯一需要想清楚的事：
 *
 *   进来：会话空闲上限、登录锁定阈值、是否强制两步验证、升级检查开关。
 *         这些是**运维策略**，会随现场情况变（换了值班方式、接了等保要求），
 *         改一次要重打镜像是荒谬的。
 *
 *   不进来：EXTERNAL_URL、MASTER_KEY、数据根、断网缓存写满策略。
 *         前两个从 Web 改能把自己锁在外面（所有跳转与 Cookie 策略都由
 *         EXTERNAL_URL 派生）；写满策略是替客户做数据取舍，`index.ts` 里
 *         写着「配错了宁可拒绝启动」。它们留在 compose 里，
 *         改动有文件、有版本、有人 review —— 那正是这类设置该有的分量。
 *
 * 默认值全部等于改动前写死在代码里的常量，升上来行为不变。
 */
import type { Db } from '../db.ts';

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface SystemSettings {
  /** 会话空闲多久失效，分钟 */
  sessionIdleMin: number;
  /** 同一「来源 IP + 用户名」连续失败多少次后锁定 */
  loginMaxFailures: number;
  loginLockMin: number;
  /** 全员强制两步验证。开启后没绑定的人登录即被要求先绑 */
  require2fa: boolean;
  /** 关掉后不再向外发起版本检查请求（工业现场对设备外连很敏感） */
  updateCheckEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_SETTINGS: Omit<SystemSettings, 'updatedAt' | 'updatedBy'> = {
  sessionIdleMin: 480,
  loginMaxFailures: 5,
  loginLockMin: 5,
  require2fa: false,
  updateCheckEnabled: true,
};

interface Row {
  session_idle_min: number;
  login_max_failures: number;
  login_lock_min: number;
  require_2fa: number;
  update_check_enabled: number;
  updated_at: string;
  updated_by: string;
}

function assertInt(v: number, name: string, min: number, max: number, unit: string): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new SettingsError(`${name}要是 ${min}—${max} ${unit}之间的整数，收到 ${String(v)}`);
  }
}

export class SettingsRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 读取。**每次都读库**，不做进程内缓存 ——
   * 改了设置要立刻生效，缓存会让「改完没反应」变成一个说不清的现象。
   * SQLite 单行读是内存级开销，这里省不出什么。
   */
  get(): SystemSettings {
    const r = this.#db.prepare('SELECT * FROM system_setting WHERE id = 1').get() as Row | undefined;
    // 迁移里已经插了这一行；真丢了也不该让全站起不来，回默认值继续跑
    if (!r) return { ...DEFAULT_SETTINGS, updatedAt: '', updatedBy: '' };
    return {
      sessionIdleMin: r.session_idle_min,
      loginMaxFailures: r.login_max_failures,
      loginLockMin: r.login_lock_min,
      require2fa: r.require_2fa === 1,
      updateCheckEnabled: r.update_check_enabled === 1,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    };
  }

  /**
   * 保存。逐字段「没传就不改」，与云对接那边同一套语义。
   *
   * 范围不是拍脑袋定的：会话上限压到 5 分钟以下，现场人员点两下就被踢出去；
   * 放到 30 天以上，一台没锁屏的工控机等于长期敞着。锁定阈值低于 3 次，
   * 手滑两下就进不去；高于 20 次，限速也就名存实亡了。
   */
  save(input: Partial<SystemSettings>, actor: string): SystemSettings {
    const prev = this.get();
    const next = { ...prev, ...input };

    assertInt(next.sessionIdleMin, '会话空闲上限', 5, 43_200, '分钟');
    assertInt(next.loginMaxFailures, '登录失败锁定次数', 3, 20, '次');
    assertInt(next.loginLockMin, '锁定时长', 1, 1_440, '分钟');

    this.#db.prepare(`
      UPDATE system_setting SET
        session_idle_min = ?, login_max_failures = ?, login_lock_min = ?,
        require_2fa = ?, update_check_enabled = ?,
        updated_at = datetime('now'), updated_by = ?
      WHERE id = 1
    `).run(
      next.sessionIdleMin, next.loginMaxFailures, next.loginLockMin,
      next.require2fa ? 1 : 0, next.updateCheckEnabled ? 1 : 0, actor,
    );
    return this.get();
  }
}
