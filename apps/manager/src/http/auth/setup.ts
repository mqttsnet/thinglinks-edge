/**
 * 首次管理员认领仅在零账号时可用。浏览器模式必须额外提交部署方配置的
 * SETUP_INSTALL_TOKEN，包括回环请求：回环也可能是转发外网请求的本机代理。
 * Compose 默认 password 模式不走认领；已有账号不能通过此接口重置。
 * SETUP_WINDOW_MIN 可额外限制认领时长，0 表示不设时间窗口。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { AuthError } from '../../core/auth/service.ts';
import { SID, CSRF, type HttpContext } from '../context.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** No address is an installation credential. */
export function setupAccessAllowed(
  _remoteAddress: string | undefined, installToken: string | undefined, presentedToken: string | undefined,
): boolean {
  // 配置了安装口令后，所有来源（包括回环和反向代理）都必须提交它。
  // 否则反向代理落到 127.0.0.1 时会把“本机免口令”变成远程绕过。
  if (!installToken || !presentedToken || Buffer.byteLength(presentedToken, 'utf8') > 256) return false;
  const expected = Buffer.from(installToken, 'utf8');
  if (expected.length < 16 || expected.length > 256) return false;
  const actual = Buffer.from(presentedToken, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * 认领窗口，分钟。**默认 0 = 不限时**；来源门禁仍然始终生效。
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
  const installToken = process.env['SETUP_INSTALL_TOKEN']?.trim() || undefined;
  if (installToken && (Buffer.byteLength(installToken) < 16 || Buffer.byteLength(installToken) > 256)) {
    throw new Error('SETUP_INSTALL_TOKEN 需为 16–256 字节，请配置随机安装口令');
  }
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
      requiresInstallToken: needed,
      installTokenConfigured: needed && Boolean(installToken),
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

    const body = (req.body ?? {}) as { username?: string; password?: string; installToken?: unknown };
    const presentedToken = typeof body.installToken === 'string' ? body.installToken : undefined;
    if (!setupAccessAllowed(req.raw.socket.remoteAddress, installToken, presentedToken)) {
      return reply.code(403).send({ error: installToken ? '首次设置需要正确的安装口令' : '未配置安装口令。请由部署人员设置 SETUP_INSTALL_TOKEN，或使用初始管理员密码模式', code: 'SETUP_TRUST_REQUIRED' });
    }
    if (typeof body.username !== 'string' || typeof body.password !== 'string') return reply.code(400).send({ error: '用户名和口令必须是文本' });
    const { username, password } = body;
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
