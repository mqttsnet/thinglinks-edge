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
import { FieldRegistry } from '../../core/edge/registry.ts';
import { BatchOverflowError, MicroBatcher, type UplinkPoint } from '../../core/cloud/batch.ts';
import { probeFlows } from '../../core/edge/southbound.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SpoolDrainer } from '../../core/spool/drainer.ts';
import type { HttpContext } from '../context.ts';

/** 单次上报的条数上限，防止一条请求把内存吃穿 */
const MAX_BATCH = 1000;

export function registerIngest(api: FastifyInstance, ctx: HttpContext): void {
  const { config, repo, db, guard, cloudSink, spool, cloud } = ctx;

  /*
   * 台账类接口的鉴权（T4.4）。
   *
   * 指名了实例就按**实例级**判，落到授权矩阵上；没指名是聚合查询，
   * 按 `field:view` 放行再逐条过滤 —— 这两条缺一不可：
   * 只判 field:view 的话，任何登录用户都能读到别人那台实例的设备清单、
   * 点位当前值，乃至 flows.json 反推出来的设备 IP 与寄存器地址。
   */
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
  const metrics = { batches: 0, points: 0, failures: 0, spooled: 0, rejected: 0, lastError: '' };

  /*
   * 补传由 `SpoolDrainer` 统一调度（core/spool/drainer.ts）。
   *
   * 这里只保留「发送成功之后捅一下」这一个触发口 —— 链路刚证明可用，
   * 趁势追欠账，实时数据天然优先（它先发），补传拿的是剩下的余量。
   * 另外两个触发口（链路恢复、定时兜底）在 index.ts 里挂，
   * 因为只有那儿拿得到 CloudRuntime 的状态事件。
   */
  /*
   * 没装 drainer 时**就地兜一个**，而不是让补传静默失效。
   *
   * 这是被回归咬出来的：把 `drain()` 直接换成 `drainer?.trigger()` 之后，
   * 所有不带 drainer 装配服务的地方（验证脚本、单用途测试装配）补传全停了，
   * 而接口一切正常、没有任何报错 —— 正是这次审查要消灭的那类静默失效。
   *
   * 兜底的这个**不启定时器**：定时兜底的生命周期归 index.ts 管，
   * 这里只恢复「发送成功后补一轮」这一个原有行为。
   */
  const localDrainer = ctx.drainer ?? (spool && cloudSink
    ? new SpoolDrainer({ spool, send: cloudSink, ready: cloudReady })
    : undefined);
  const drain = () => { void localDrainer?.trigger('after-send'); };

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
       * 上行队列满了就当场回 503，**不收下再说**。
       *
       * 微批是全平台共用的一条队列：云端卡住（TCP 不回，不是断开）时，
       * 一个狂灌点位的实例能把队列撑到几百兆，把同机其它实例一起拖垮。
       *
       * 台账照常记 —— 那是本地库、有界的，而且现场看当前值靠的就是它；
       * 只有送云的部分明确拒收，让节点自己决定缓存还是降采样。
       * `accepted` 如实回落库条数，不是 0：数据确实收下了。
       */
      if (batcher.saturated) {
        metrics.rejected += values.length;
        metrics.lastError = '上行队列已满，已拒收';
        return reply.code(503).header('retry-after', '5').send({
          error: '上行队列已满，云端发送跟不上，请稍后重试',
          accepted, cloud: 'saturated',
        });
      }

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
    } catch (e) {
      // 队列在收点的中途满了：同样是「稍后再来」，不是「这条数据有问题」
      if (e instanceof BatchOverflowError) {
        metrics.rejected += values.length;
        metrics.lastError = e.message;
        return reply.code(503).header('retry-after', '5')
          .send({ error: e.message, accepted: 0, cloud: 'saturated' });
      }
      return fail(reply, e);
    }
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
        // 队列水位与拒收数要看得见：现场「数据少了一段」时，
        // 这两个数字是区分「云端慢」和「节点没发」的唯一依据
        queued: batcher.queued,
        queuedBytes: batcher.queuedBytes,
        saturated: batcher.saturated,
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
    if (!localDrainer) return reply.code(503).send({ error: '补传调度未装配' });
    /*
     * 走 drainer 而不是直接调 spool.replay —— 必须与自动补传共用同一个单飞闸门。
     * 早先这里直接调，与后台补传并发时两边从同一个进度开始读，
     * 会重复发送并把 pending 计数搞乱。
     * 限速放宽是有意的：这是人盯着的排障操作，不是后台任务。
     */
    const r = await localDrainer.trigger('manual', { ratePerSec: 200, maxRecords: 1000 });
    return reply.send({ ...r, running: localDrainer.running });
  });
}
