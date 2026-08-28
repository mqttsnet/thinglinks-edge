/**
 * 系统设置与两步验证的接口。
 *
 * 两条贯穿始终的规矩：
 *
 *   1. **设置只装运行期可改的**。部署期的东西（EXTERNAL_URL、MASTER_KEY、
 *      数据根、缓存写满策略）不在这里，理由见 `core/auth/settings.ts` 的文件头。
 *   2. **绑定相关的路由要放行「未绑定」的会话**（`allowEnroll`），否则强制两步验证
 *      一开就是死循环：要绑定得先能调接口，能调接口又得先绑定。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { SettingsError } from '../../core/auth/settings.ts';
import { AuthError } from '../../core/auth/service.ts';
import type { HttpContext } from '../context.ts';

export function registerSettings(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, auth, settings, users } = ctx;

  const bad = (reply: any, e: unknown) => {
    if (e instanceof SettingsError || e instanceof AuthError) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    throw e;
  };

  /**
   * 读设置。**任何登录用户都能读** —— 会话超时是多久、要不要两步验证，
   * 这些是每个人都该知道的规则，藏起来只会让人对着「怎么突然被踢出去了」发懵。
   * 改才要 `system:manage`。
   */
  api.get(`${config.basePath}/api/settings`, async (req, reply) => {
    const user = ctx.guard(req, reply, { csrf: false, need: 'system:view', allowEnroll: true });
    if (!user) return;
    return reply.send({
      settings: settings.get(),
      /*
       * 服务端当前时间，给界面算时钟偏差用。
       *
       * TOTP 完全靠时钟：边缘盒子没对时的话，验证码会周期性地全部对不上，
       * 而错误信息只会说「验证码不正确」。绑定前把偏差摆出来，
       * 比事后猜是手机的问题还是盒子的问题省事得多。
       */
      serverTime: new Date().toISOString(),
      canManage: ctx.can(user, 'system:manage'),
    });
  });

  api.put(`${config.basePath}/api/settings`, async (req, reply) => {
    const user = ctx.guard(req, reply, { csrf: true, need: 'system:manage' });
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const num = (k: string): number | undefined => {
      const v = b[k];
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new SettingsError(`字段类型不对：${k}`);
      return n;
    };
    try {
      const saved = settings.save({
        ...(num('sessionIdleMin') === undefined ? {} : { sessionIdleMin: num('sessionIdleMin')! }),
        ...(num('loginMaxFailures') === undefined ? {} : { loginMaxFailures: num('loginMaxFailures')! }),
        ...(num('loginLockMin') === undefined ? {} : { loginLockMin: num('loginLockMin')! }),
        ...(b['require2fa'] === undefined ? {} : { require2fa: b['require2fa'] !== false }),
        ...(b['updateCheckEnabled'] === undefined
          ? {} : { updateCheckEnabled: b['updateCheckEnabled'] !== false }),
      }, user.username);
      recordAudit(db, {
        actor: user.username, action: 'settings', target: 'system',
        detail: `会话${saved.sessionIdleMin}分 锁定${saved.loginMaxFailures}次/${saved.loginLockMin}分 `
          + `强制两步验证=${saved.require2fa} 升级检查=${saved.updateCheckEnabled}`,
        result: 'ok',
      });
      return reply.send({ settings: saved });
    } catch (e) { return bad(reply, e); }
  });

  // ── 自己的两步验证 ────────────────────────────────────

  /** 我的绑定状态。恢复码只报剩余条数，不回内容 */
  api.get(`${config.basePath}/api/me/totp`, async (req, reply) => {
    const user = ctx.guard(req, reply, { csrf: false, need: 'system:view', allowEnroll: true });
    if (!user) return;
    return reply.send({
      enabled: user.totpEnabled,
      required: settings.get().require2fa,
      recoveryLeft: user.totpEnabled ? auth.recoveryCodesLeft(user.username) : 0,
    });
  });

  /**
   * 取密钥开始绑定。**这一步不启用** —— 先证明能算出正确的码，再启用，
   * 否则扫码失败的人当场就把自己关在门外了。
   */
  api.post(`${config.basePath}/api/me/totp/setup`, async (req, reply) => {
    const user = ctx.guard(req, reply, { csrf: true, need: 'system:view', allowEnroll: true });
    if (!user) return;
    try {
      const { secret, grouped, otpauth } = auth.beginTotpEnroll(user.username);
      recordAudit(db, { actor: user.username, action: 'totp-setup', result: 'ok' });
      // 密钥本身必须回给界面（要手输/扫码），这是绑定流程绕不开的一次明文暴露；
      // 之后库里是密文，接口再也不回它
      return reply.send({ secret, grouped, otpauth });
    } catch (e) { return bad(reply, e); }
  });

  /** 确认绑定。通过才启用，并**一次性**返回恢复码 */
  api.post(`${config.basePath}/api/me/totp/confirm`, async (req, reply) => {
    const user = ctx.guard(req, reply, { csrf: true, need: 'system:view', allowEnroll: true });
    if (!user) return;
    const { code } = (req.body ?? {}) as { code?: string };
    try {
      const codes = auth.confirmTotpEnroll(user.username, code ?? '');
      recordAudit(db, { actor: user.username, action: 'totp-enable', result: 'ok' });
      return reply.send({ codes });
    } catch (e) {
      recordAudit(db, {
        actor: user.username, action: 'totp-enable', result: 'fail', detail: (e as Error).message,
      });
      return bad(reply, e);
    }
  });

  /** 自己解绑。要口令 —— 只凭一个已登录的会话就能关掉，这层防护就形同虚设 */
  api.delete(`${config.basePath}/api/me/totp`, async (req, reply) => {
    const user = ctx.guard(req, reply, { csrf: true, need: 'system:view' });
    if (!user) return;
    const { password } = (req.body ?? {}) as { password?: string };
    try {
      auth.disableTotp(user.username, password ?? '');
      recordAudit(db, { actor: user.username, action: 'totp-disable', result: 'ok' });
      return reply.code(204).send();
    } catch (e) { return bad(reply, e); }
  });

  /**
   * 管理员强制解绑别人。
   *
   * 「手机丢了、恢复码也没了」这条路必须存在，否则一台设备丢失
   * 就等于一个账号永久锁死。解绑会同时踢掉那个人的全部会话。
   */
  api.post(`${config.basePath}/api/users/:username/totp/reset`, async (req, reply) => {
    const actor = ctx.guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username } = req.params as { username: string };
    if (!users.get(username)) return reply.code(404).send({ error: '账号不存在' });
    auth.clearTotp(username);
    recordAudit(db, {
      actor: actor.username, action: 'totp-reset', target: username,
      detail: '管理员强制解绑两步验证并踢下线', result: 'ok',
    });
    return reply.code(204).send();
  });
}
