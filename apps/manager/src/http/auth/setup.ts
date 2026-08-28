/**
 * 首次设置 —— 全新部署上由**用户自己**定第一个管理员账号。
 *
 * 取代了原先「随机生成口令、打进启动日志、让用户去 docker logs 里翻」那一套。
 * 日志那套的毛病不是不好用，是**口令会跟着日志跑**：进日志聚合、进备份、
 * 进随手截的一张图。诊断包的脱敏模块里专门为它留了一条规则，就是这个原因。
 *
 * 这条路是匿名的（还没有账号，也就无从鉴权），闸只有一道：
 * **只在一个账号都没有时放行**。有任何账号存在就一律拒绝 ——
 * 「重新认领」不是这条路该干的事，那是 `reset-admin` 的活。
 *
 * 曾经还有第二道「只在启动后 N 分钟内放行」，**默认已经去掉**，理由是它算错了账：
 *
 *   · 默认 `BIND_ADDR=127.0.0.1`，开箱只有宿主本机够得到。而能碰到宿主的人
 *     本来就能跑 `reset-admin`，限时挡不住他 —— 默认部署下这道闸几乎不保护任何东西。
 *   · 代价却是实打实的：装完机被叫走、回来窗口过了，人就进不去，
 *     还得找个有 shell 权限的人重启容器。现场装机被打断是常态，不是意外。
 *
 * 只有**主动把控制台暴露到厂区网或公网**的部署才真的面对「谁先打开谁是管理员」，
 * 那种情况下用 `SETUP_WINDOW_MIN` 显式开启限时。默认 0 = 不限时。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { AuthError } from '../../core/auth/service.ts';
import { SID, CSRF, type HttpContext } from '../context.ts';
import { randomBytes } from 'node:crypto';

/**
 * 认领窗口，分钟。**默认 0 = 不限时**。
 *
 * 只有把控制台暴露到宿主之外的部署才需要它 —— 见文件头。
 */
function windowMs(): number {
  const raw = (process.env['SETUP_WINDOW_MIN'] ?? '0').trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1440) {
    throw new Error(`SETUP_WINDOW_MIN 需为 0-1440 之间的数（0 表示不限时），收到 ${raw}`);
  }
  /*
   * 收小数不是为了让人填 2.5 分钟，是为了**过期这条分支能被测到**：
   * 只收整数分钟的话，验证它就得等一分钟或者去改系统时间，
   * 那样的测试没人会跑，于是这条最要紧的分支永远没人验。
   */
  return n * 60_000;
}

export function registerSetup(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, auth } = ctx;
  const startedAt = Date.now();
  const limit = windowMs();
  /** 0 = 不限时 */
  const expiresAt = limit === 0 ? 0 : startedAt + limit;
  const expired = () => expiresAt !== 0 && Date.now() > expiresAt;

  /**
   * 要不要做首次设置。**匿名可读** —— 登录页要拿它决定显示「登录」还是「创建管理员」，
   * 而这时本来就还没有任何身份可验。
   *
   * 回的东西刻意只有「要不要」和「还剩多久」：一个未认领的实例本身不是秘密
   * （谁都能从登录页看出来），但也不该顺带吐出版本、主机名之类的信息。
   */
  api.get(`${config.basePath}/api/setup`, async (_req, reply) => {
    const needed = auth.needsSetup();
    return reply.send({
      needed,
      expired: needed && expired(),
      /** 剩余秒数；0 表示不限时。界面用它提示「请在 x 分钟内完成」 */
      expiresInSec: expiresAt === 0 ? 0 : Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
    });
  });

  api.post(`${config.basePath}/api/setup`, async (req, reply) => {
    if (!auth.needsSetup()) {
      // 不区分「已设置」与其它错误：这条路对已认领的实例就该是一句话堵死
      return reply.code(409).send({ error: '这台设备已经完成过首次设置' });
    }
    if (expired()) {
      recordAudit(db, {
        actor: '-', action: 'setup', result: 'fail',
        detail: `认领窗口已过（${req.ip}）`,
      });
      return reply.code(403).send({
        error: '首次设置窗口已过期。请重启 Manager 后，在窗口时间内完成设置',
        code: 'SETUP_WINDOW_EXPIRED',
      });
    }

    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    try {
      auth.createFirstAdmin((username ?? '').trim(), password ?? '');
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: (e as Error).message });
      throw e;
    }

    const name = (username ?? '').trim();
    recordAudit(db, {
      actor: name, action: 'setup', target: name,
      detail: `首次设置完成，来源 ${req.ip}`, result: 'ok',
    });
    console.log(`[init] 首次设置完成，管理员账号 ${name}（来源 ${req.ip}）`);

    /*
     * 设置完直接登录，不让人再输一遍刚定好的口令。
     *
     * 走 auth.login 而不是自己发会话：限速、停用、两步验证那几条判断都在里面，
     * 绕过去就等于给这条路开了一个不走正门的入口。
     */
    const result = auth.login(name, password ?? '', req.ip);
    if ('mfa' in result) {
      // 新账号不可能已绑两步验证，走到这里说明上面的逻辑被改坏了
      return reply.code(500).send({ error: '首次设置异常，请重试' });
    }
    const csrf = randomBytes(16).toString('hex');
    return reply
      .setCookie(SID, result.sid, { httpOnly: true, path: '/', sameSite: 'lax', secure: config.cookieSecure })
      .setCookie(CSRF, csrf, { httpOnly: false, path: '/', sameSite: 'lax', secure: config.cookieSecure })
      .send({ user: result.user });
  });
}
