/**
 * `@thinglinks` 节点集的接入通道。
 *
 * 实例里的节点把设备、点位、点位值回报到这里，平台据此建立**可信台账**
 * （`06-功能可行性审视.md` 方案 B）。用原生 modbus/opcua 节点采的部分不会出现在这里，
 * 界面必须如实标注「未纳管」。
 *
 * 鉴权用**每实例独立的令牌**，不用管理会话：
 *   · 实例是长期运行的自动化流程，没有「登录」这一说
 *   · 实例 id **只从令牌反查**，绝不取自请求体 —— 否则实例 A 可以冒充实例 B 写台账
 */
import type { FastifyInstance } from 'fastify';
import { FieldRegistry } from '../core/edge/registry.ts';
import { MicroBatcher, type UplinkPoint } from '../core/cloud/batch.ts';
import { probeFlows } from '../core/edge/southbound.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpContext } from './context.ts';

/** 单次上报的条数上限，防止一条请求把内存吃穿 */
const MAX_BATCH = 1000;

export function registerIngest(api: FastifyInstance, ctx: HttpContext): void {
  const { config, repo, db, guard, cloudSink, spool, cloud, visibleOnly } = ctx;

  /*
   * 台账类接口的鉴权（T4.4）。
   *
   * 指名了实例就按**实例级**判，落到授权矩阵上；没指名是聚合查询，
   * 按 `field:view` 放行再逐条过滤 —— 这两条缺一不可：
   * 只判 field:view 的话，任何登录用户都能读到别人那台实例的设备清单、
   * 点位当前值，乃至 flows.json 反推出来的设备 IP 与寄存器地址。
   */
  const fieldGuard = (req: any, reply: any, instanceId: string | undefined) =>
    (instanceId === undefined
      ? guard(req, reply, { csrf: false, need: 'field:view' })
      : guard(req, reply, { csrf: false, need: 'instance:view', instance: instanceId }));

  /*
   * 「云连接配没配」以运行期为准。
   *
   * 不能看 cloudSink 在不在：接上 CloudRuntime 之后它是一个恒定的转发闭包，
   * 永远为真，于是「未配置」这个状态就再也报不出来了 —— 界面会显示
   * 「已配置」而数据其实一条都发不出去。没有运行期时（单测直接注入 sink）
   * 才退回看 sink。
   */
  const cloudReady = () => (cloud ? cloud.configured : Boolean(cloudSink));
  const registry = new FieldRegistry(db);

  /*
   * 微批。1.4k 点/秒的现场负载聚合后约 5 条消息/秒（08 号文第 2 节）。
   * 没配云连接时 flush 直接抛错并计数 —— 不能假装发出去了。
   */
  const metrics = { batches: 0, points: 0, failures: 0, spooled: 0, lastError: '' };

  /*
   * 补传搭在**成功发送之后**：链路刚证明可用，才去追欠账。
   * 这样实时数据天然优先（它先发），补传拿的是剩下的余量 —— 08 号文第 6 节
   * 要的优先级关系由顺序保证，不需要额外的调度器。
   * 限速与单轮条数都设了上限，避免一次性把积压全冲出去压垮云端。
   */
  let draining = false;
  const drain = async () => {
    if (!spool || !cloudSink || !cloudReady() || draining) return;
    draining = true;
    try {
      await spool.replay(async (p) => { await cloudSink(p); },
                         { ratePerSec: 50, maxRecords: 200 });
    } finally {
      draining = false;
    }
  };

  const batcher = new MicroBatcher({
    flush: async (payload, points) => {
      if (!cloudSink) throw new Error('云连接未配置');
      try {
        await cloudSink(payload);
      } catch (e) {
        // 发不出去就落缓存，**不静默丢**。缓存也没有时才计为失败
        if (spool) {
          const r = await spool.enqueue(payload);
          metrics.spooled += 1;
          if (r !== 'stored') metrics.lastError = `缓存写满：${r}`;
          return;
        }
        throw e;
      }
      metrics.batches += 1;
      metrics.points += points.length;
      void drain();
    },
    onFlushError: (e, points) => {
      metrics.failures += points.length;
      metrics.lastError = e.message;
    },
  });

  /*
   * 令牌缓存。点位值是高频路径，每次请求都全表解密是白扔 CPU。
   * 未命中时刷新一次再判 —— 新建实例不必重启 Manager 就能开始回报。
   */
  let tokens = repo.allIngestTokens();
  const instanceOf = (token: string): string | undefined => {
    let id = tokens.get(token);
    if (id === undefined) {
      tokens = repo.allIngestTokens();
      id = tokens.get(token);
    }
    return id;
  };

  /** 取令牌并反查实例。失败时就地回 401 并返回 undefined */
  const authed = (req: any, reply: any): string | undefined => {
    const raw = String(req.headers['authorization'] ?? '');
    const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
    if (token === '') {
      reply.code(401).send({ error: '缺少接入令牌' });
      return undefined;
    }
    const id = instanceOf(token);
    if (id === undefined) {
      // 定长比较对 Map 查找没有意义，这里的防护来自令牌本身是 32 字节随机值
      reply.code(401).send({ error: '接入令牌无效' });
      return undefined;
    }
    return id;
  };

  const asArray = <T>(body: unknown, key: string): T[] => {
    const b = (body ?? {}) as Record<string, unknown>;
    const v = b[key];
    if (Array.isArray(v)) return v as T[];
    if (v && typeof v === 'object') return [v as T];
    // 也接受直接把单个对象作为请求体，节点侧写起来更自然
    if (Object.keys(b).length > 0 && !(key in b)) return [b as T];
    return [];
  };

  const fail = (reply: any, e: unknown) =>
    reply.code(400).send({ error: (e as Error).message });

  // ── 上报：设备 ────────────────────────────────────────────
  api.post(`${config.basePath}/api/edge/devices`, async (req, reply) => {
    const instanceId = authed(req, reply);
    if (!instanceId) return;
    const items = asArray<{ nodeId: string; name: string }>(req.body, 'devices');
    if (items.length === 0) return reply.code(400).send({ error: '没有可注册的设备' });
    if (items.length > MAX_BATCH) return reply.code(413).send({ error: `单次上限 ${MAX_BATCH} 条` });
    try {
      for (const d of items) registry.upsertDevice(instanceId, d);
      return reply.send({ accepted: items.length });
    } catch (e) { return fail(reply, e); }
  });

  // ── 上报：设备在线状态 ────────────────────────────────────
  api.post(`${config.basePath}/api/edge/devices/:nodeId/status`, async (req, reply) => {
    const instanceId = authed(req, reply);
    if (!instanceId) return;
    const { nodeId } = req.params as { nodeId: string };
    const { online } = (req.body ?? {}) as { online?: boolean };
    try {
      registry.setDeviceOnline(instanceId, nodeId, online === true);
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  // ── 上报：点位定义 ────────────────────────────────────────
  api.post(`${config.basePath}/api/edge/tags`, async (req, reply) => {
    const instanceId = authed(req, reply);
    if (!instanceId) return;
    const items = asArray<{ nodeId: string; tagId: string }>(req.body, 'tags');
    if (items.length === 0) return reply.code(400).send({ error: '没有可定义的点位' });
    if (items.length > MAX_BATCH) return reply.code(413).send({ error: `单次上限 ${MAX_BATCH} 条` });
    try {
      for (const t of items) registry.upsertTag(instanceId, t);
      return reply.send({ accepted: items.length });
    } catch (e) { return fail(reply, e); }
  });

  // ── 上报：点位值 ──────────────────────────────────────────
  api.post(`${config.basePath}/api/edge/values`, async (req, reply) => {
    const instanceId = authed(req, reply);
    if (!instanceId) return;
    const items = asArray<{ nodeId: string; tagId: string; value: unknown }>(req.body, 'values');
    if (items.length === 0) return reply.code(400).send({ error: '没有可记录的值' });
    if (items.length > MAX_BATCH) return reply.code(413).send({ error: `单次上限 ${MAX_BATCH} 条` });
    try {
      return reply.send({ accepted: registry.recordValues(instanceId, items) });
    } catch (e) { return fail(reply, e); }
  });

  /*
   * ── 上行入口 ──
   *
   * `tl-uplink` 是上行的唯一出口（07 号文 6.2）：断网缓存、微批聚合、协议信封
   * 都需要一个汇聚点，散在各 flow 的 `mqtt out` 里这三件事全都落空。
   *
   * 收下后落进台账，同时进微批；攒够一批由 cloudSink 送云，送不出去落断网缓存。
   * 没配云连接时明确回 `cloud: "not-configured"` —— **不假装已经发出去了**。
   */
  api.post(`${config.basePath}/api/edge/uplink`, async (req, reply) => {
    const instanceId = authed(req, reply);
    if (!instanceId) return;
    const b = (req.body ?? {}) as { serviceId?: string; nodeId?: string; data?: unknown };
    if (b.data === undefined || b.data === null) {
      return reply.code(400).send({ error: '缺少 data' });
    }

    // data 是对象时，其每个键当作一个点位；否则整体作为单点
    const nodeId = (b.nodeId ?? '').trim() || '_gateway';
    const values = (typeof b.data === 'object' && !Array.isArray(b.data))
      ? Object.entries(b.data as Record<string, unknown>)
          .map(([tagId, value]) => ({ nodeId, tagId, value }))
      : [{ nodeId, tagId: b.serviceId || 'value', value: b.data }];

    try {
      const accepted = registry.recordValues(instanceId, values);

      /*
       * 时间戳在**入队时**打，不是发送时（08 号文第 5 节）。
       * 发送时才打的话，断网补传的数据会带上补传那一刻的时间，
       * 云侧按 eventTime 排出来的顺序就是错的。
       */
      const eventTime = Date.now();
      const serviceCode = (b.serviceId ?? '').trim() || 'default';
      for (const v of values) {
        batcher.add({
          deviceId: v.nodeId, serviceCode, eventTime,
          data: { [v.tagId]: v.value },
        } as UplinkPoint);
      }

      return reply.code(202).send({
        accepted,
        batched: batcher.pending,
        cloud: cloudReady() ? 'queued' : 'not-configured',
      });
    } catch (e) { return fail(reply, e); }
  });

  /** 数据面指标（08 号文第 8 节要求控制台可见） */
  api.get(`${config.basePath}/api/edge/metrics`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'field:view' })) return;
    return reply.send({
      cloud: cloudReady() ? 'configured' : 'not-configured',
      // 连接明细只有装了运行期才有；没装时如实给 null，不编一个假状态
      cloudStatus: cloud ? cloud.status() : null,
      batch: {
        limits: batcher.limits,
        pending: batcher.pending,
        pendingBytes: batcher.pendingBytes,
        ...metrics,
      },
      spool: spool ? await spool.metrics() : null,
    });
  });

  /** 手动触发一轮补传。正常情况下由每次成功发送自动带动，这个口子是给现场排障用的 */
  api.post(`${config.basePath}/api/edge/replay`, async (req, reply) => {
    if (!guard(req, reply, { csrf: true, need: 'replay:run' })) return;
    if (!spool) return reply.code(400).send({ error: '未配置断网缓存' });
    if (!cloudSink || !cloudReady()) return reply.code(503).send({ error: '云连接未配置，无法补传' });
    const r = await spool.replay(async (p) => { await cloudSink(p); },
                                 { ratePerSec: 200, maxRecords: 1000 });
    return reply.send(r);
  });

  // ── 控制台读取（走管理会话，不是接入令牌）────────────────
  api.get(`${config.basePath}/api/field/devices`, async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    const user = fieldGuard(req, reply, instanceId);
    if (!user) return;
    return reply.send({ devices: visibleOnly(user, registry.devices(instanceId)) });
  });

  api.get(`${config.basePath}/api/field/tags`, async (req, reply) => {
    const { instanceId, nodeId } = req.query as { instanceId?: string; nodeId?: string };
    const user = fieldGuard(req, reply, instanceId);
    if (!user) return;
    return reply.send({ tags: visibleOnly(user, registry.tags(instanceId, nodeId)) });
  });

  /*
   * 南向探测（06 号文方案 A）。解析实例的 flows.json 反推用户用原生
   * modbus / OPC UA / S7 节点接的设备 —— **尽力而为，不是可靠台账**。
   *
   * 结果恒带 `managed: false`，并把「认不出的节点类型」一并返回。
   * 界面必须标「未纳管」，且不能把这些数字和真实台账加在一起显示 ——
   * 让用户以为看到的是全部，是诚信问题（06 号文原话）。
   */
  api.get(`${config.basePath}/api/field/southbound`, async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    // 这条**必须**指名实例：它读的是那台实例的 flows.json，
    // 里面是设备 IP 与寄存器地址，比台账更敏感
    if (!instanceId) {
      if (!guard(req, reply, { csrf: false, need: 'field:view' })) return;
      return reply.code(400).send({ error: '缺少 instanceId' });
    }
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: instanceId })) return;

    const flowsPath = join(config.instanceDataRoot, instanceId, 'flows.json');
    const raw = await readFile(flowsPath, 'utf8').catch(() => undefined);
    if (raw === undefined) {
      // 实例还没部署过流程时没有这个文件，属正常，不是错误
      return reply.send({ ...probeFlows(null), reason: '该实例尚无 flows.json（未部署过流程）' });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      return reply.send({ ...probeFlows(null), reason: 'flows.json 不是合法 JSON，无法探测' });
    }
    return reply.send(probeFlows(parsed));
  });

  api.get(`${config.basePath}/api/field/summary`, async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    const user = fieldGuard(req, reply, instanceId);
    if (!user) return;
    /*
     * 两类数字**必须分开返回**，不能相加：
     * `managed` 是节点集回报的可信台账（有当前值、有质量码）；
     * `probed` 是从 flows.json 反推的尽力探测（没有运行时数据，可能漏）。
     * 加在一起显示会让用户以为那是同一种东西。
     */
    // 汇总数字同样只能覆盖看得见的实例，否则「全厂多少台设备」会被越权读出来
    const devices = visibleOnly(user, registry.devices(instanceId));
    const tags = visibleOnly(user, registry.tags(instanceId));
    return reply.send({
      managed: {
        devices: devices.length,
        online: devices.filter((d) => d.online).length,
        tags: tags.length,
      },
      note: '「已纳管」来自 @thinglinks 节点主动回报，含当前值与质量码；'
          + '用原生 modbus/opcua/s7 节点采集的部分请看 /api/field/southbound，那是尽力探测，未纳管',
    });
  });
}
