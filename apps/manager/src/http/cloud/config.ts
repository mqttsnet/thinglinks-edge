/**
 * 云平台对接的配置与状态接口。
 *
 * 两个原则贯穿全部路由：
 *
 *   1. **响应里永远没有明文凭据**。读接口回的是 `getRedacted()`，只说某个密文
 *      字段「设没设」。这不是洁癖：控制台的响应会进浏览器缓存、进反代日志、
 *      进用户随手截的图。
 *   2. **改配置立刻生效**，不要求重启 Manager。现场调参数往往要试好几轮，
 *      每轮重启会把正在跑的实例一并带断。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { CloudConfigError, type CloudConfigInput } from '../../core/cloud/config-repo.ts';
import type { HttpContext } from '../context.ts';
import type { CipherFlag } from '../../core/cloud/envelope.ts';
import type { TlsConfigInput, TlsMode } from '../../core/cloud/tls.ts';
import type { ConnectionOptions } from '../../core/cloud/connection.ts';

/** 请求体里可能缺字段，逐个取而不是整体断言，缺什么就报什么 */
function readInput(body: unknown): CloudConfigInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = b[k];
    if (typeof v !== 'string') throw new CloudConfigError(`缺少字段或类型不对：${k}`);
    return v;
  };
  /** 密文字段：缺省表示「不改」，所以 undefined 与空串必须区分开 */
  const secret = (k: string): string | undefined => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new CloudConfigError(`字段类型不对：${k}`);
    return v;
  };

  const cipherFlag = Number(b['cipherFlag'] ?? 0);
  const qosRaw = b['qos'];

  /*
   * TLS 整块缺省 = 沿用库里已有的设置。
   *
   * 刻意不是「缺省即 system」：那样一来，任何一个不认识 tls 字段的老客户端
   * 存一次配置，就会把现场的证书悄悄清空、把链路降级成系统根证书校验。
   * 要改证书就得显式传 tls。
   */
  const tlsRaw = b['tls'];
  let tls: TlsConfigInput | undefined;
  if (tlsRaw !== undefined && tlsRaw !== null) {
    if (typeof tlsRaw !== 'object') throw new CloudConfigError('字段类型不对：tls');
    const t = tlsRaw as Record<string, unknown>;
    const text = (k: string): string | undefined => {
      const v = t[k];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string') throw new CloudConfigError(`字段类型不对：tls.${k}`);
      return v;
    };
    tls = {
      mode: t['mode'] === undefined ? undefined : (String(t['mode']) as TlsMode),
      ca: text('ca'),
      cert: text('cert'),
      // 私钥与口令同一套语义：undefined 表示不改，空串才是清空
      key: text('key'),
      rejectUnauthorized: t['rejectUnauthorized'] === undefined
        ? undefined : t['rejectUnauthorized'] !== false,
      servername: text('servername'),
    };
  }

  /*
   * 连接参数同样是「整块不传 = 一个字段都不改」。
   *
   * 逐个字段取而不是整体断言：漏一个字段就沿用旧值，而不是被 NaN 顶掉 ——
   * `Number(undefined)` 是 NaN，直接塞进去会让校验报一句「收到 NaN」，
   * 看的人根本对不上是哪个字段没填。
   */
  const connRaw = b['connection'];
  let connection: Partial<ConnectionOptions> | undefined;
  if (connRaw !== undefined && connRaw !== null) {
    if (typeof connRaw !== 'object') throw new CloudConfigError('字段类型不对：connection');
    const c = connRaw as Record<string, unknown>;
    const num = (k: string): number | undefined => {
      const v = c[k];
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new CloudConfigError(`字段类型不对：connection.${k}`);
      return n;
    };
    connection = {
      ...(num('mqttVersion') === undefined ? {} : { mqttVersion: num('mqttVersion') as 3 | 4 | 5 }),
      ...(num('keepaliveSec') === undefined ? {} : { keepaliveSec: num('keepaliveSec')! }),
      ...(num('connectTimeoutSec') === undefined ? {} : { connectTimeoutSec: num('connectTimeoutSec')! }),
      ...(c['autoReconnect'] === undefined ? {} : { autoReconnect: c['autoReconnect'] !== false }),
      ...(num('reconnectPeriodMs') === undefined ? {} : { reconnectPeriodMs: num('reconnectPeriodMs')! }),
    };
  }

  return {
    enabled: b['enabled'] !== false,
    brokerUrl: str('brokerUrl'),
    clientId: str('clientId'),
    deviceIdentification: str('deviceIdentification'),
    username: typeof b['username'] === 'string' ? b['username'] : '',
    password: secret('password'),
    cipherFlag: cipherFlag as CipherFlag,
    signKey: secret('signKey'),
    encryptKey: secret('encryptKey'),
    encryptVector: secret('encryptVector'),
    tls,
    connection,
    protocolVersion: typeof b['protocolVersion'] === 'string' ? b['protocolVersion'] : undefined,
    qos: qosRaw === undefined ? undefined : (Number(qosRaw) as 0 | 1 | 2),
  };
}

export function registerCloud(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, cloud, cloudConfig, spool, drainer, outages } = ctx;

  /** 这个部署没装云配置能力时，路由如实回 501 而不是假装成功 */
  const unavailable = (reply: any) =>
    reply.code(501).send({ error: '该部署未启用云对接配置' });

  api.get(`${config.basePath}/api/cloud`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'cloud:view' })) return;
    if (!cloudConfig || !cloud) return unavailable(reply);
    const m = spool ? await spool.metrics() : null;
    return reply.send({
      config: cloudConfig.getRedacted() ?? null,
      status: cloud.status(),
      spool: m,
      /*
       * 补传进度与预计完成（08 号文第 8 节）。
       * 算不出来时 etaSec 是 null 并由 reason 说明为什么 —— **不编数**：
       * 现场看到「预计 3 分钟」然后等了半小时，下次就再也不信这个读数了。
       */
      replay: drainer && m ? drainer.progress(m.pending) : null,
      /** 最近断网记录：起止、时长、峰值积压、补传结果。事后追溯全靠它 */
      outages: outages ? outages.recent(10) : null,
    });
  });

  /**
   * 保存并立即应用。
   *
   * 返回里带上应用后的状态，且**等一小会儿**再回 —— 用户按下保存最想知道的就是
   * 「连上了没有」。等不到也不报错：后台仍在重试，界面轮询会跟上。
   */
  api.put(`${config.basePath}/api/cloud`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'cloud:manage' });
    if (!user) return;
    if (!cloudConfig || !cloud) return unavailable(reply);

    let saved;
    try {
      saved = cloudConfig.save(readInput(req.body), user.username);
    } catch (e) {
      if (e instanceof CloudConfigError) {
        recordAudit(db, {
          actor: user.username, action: 'cloud-config', target: 'cloud',
          detail: (e as Error).message, result: 'fail',
        });
        return reply.code(400).send({ error: (e as Error).message });
      }
      throw e;
    }

    await cloud.apply(saved);
    const state = await cloud.waitSettled(8_000);

    /*
     * 审计只记「谁在什么时候改了、改到哪个 broker」，不记任何密钥材料。
     * 审计表本身是排障时最常被导出的东西，往里塞凭据等于多开一个泄漏口。
     */
    recordAudit(db, {
      actor: user.username, action: 'cloud-config', target: saved.brokerUrl,
      detail: `enabled=${saved.enabled} device=${saved.deviceIdentification} ` +
        `cipherFlag=${saved.cipher.cipherFlag} mqtt=${saved.connection.mqttVersion} ` +
        `tls=${saved.tls.mode}` +
        // 关掉证书校验是一次安全降级，审计里必须留下痕迹，而不是只在界面上闪一下
        `${saved.tls.rejectUnauthorized ? '' : '(已关闭证书校验)'} → ${state}`,
      result: 'ok',
    });

    return reply.send({
      config: cloudConfig.getRedacted(),
      status: cloud.status(),
    });
  });

  /**
   * 重连。用于「云侧刚开通/网络刚恢复，不想等下一次自动重试」。
   *
   * 复用当前落库的配置重新 apply，而不是加一条独立的重连通道 ——
   * 独立通道意味着「界面上的配置」和「实际在用的配置」可能不是同一份。
   */
  api.post(`${config.basePath}/api/cloud/reconnect`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'cloud:manage' });
    if (!user) return;
    if (!cloudConfig || !cloud) return unavailable(reply);

    const current = cloudConfig.get();
    if (!current) return reply.code(400).send({ error: '尚未配置云对接' });

    await cloud.apply(current);
    const state = await cloud.waitSettled(8_000);
    recordAudit(db, {
      actor: user.username, action: 'cloud-reconnect', target: current.brokerUrl,
      detail: `重连结果 ${state}`, result: state === 'online' ? 'ok' : 'fail',
    });
    return reply.send({ status: cloud.status() });
  });

  /** 解除对接。清配置并拆连接 —— 比留一份禁用配置干净，也避免凭据继续留在库里 */
  api.delete(`${config.basePath}/api/cloud`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'cloud:manage' });
    if (!user) return;
    if (!cloudConfig || !cloud) return unavailable(reply);

    cloudConfig.clear();
    await cloud.apply(undefined);
    recordAudit(db, {
      actor: user.username, action: 'cloud-config', target: 'cleared',
      detail: '已解除云平台对接并清除接入凭据', result: 'ok',
    });
    return reply.send({ status: cloud.status() });
  });
}
