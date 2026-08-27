/**
 * 资源指标历史接口 —— 健康监测的趋势曲线取这里的数据。
 *
 * 与 `/api/health` 的分工：那边是**此刻**的三层探针（每次调用现探），
 * 这边是后台采样器攒下来的**时间序列**（纯内存读，不碰 docker）。
 * 分开的好处是页面刷曲线不会把探针压力翻倍。
 */
import type { FastifyInstance } from 'fastify';
import type { HttpContext } from './context.ts';

/**
 * 允许的窗口。做成白名单而不是自由秒数：
 * 一是防着有人拿 `range=99999999` 把整个环形缓冲翻出来，
 * 二是界面上本就只有这几个按钮，多出来的自由度没人用、只会成为攻击面。
 */
const RANGES: Record<string, number> = {
  '10m': 600,
  '1h': 3600,
  '6h': 21_600,
  '24h': 86_400,
};

export function registerMetrics(api: FastifyInstance, ctx: HttpContext): void {
  const { config, guard, metrics } = ctx;

  api.get(`${config.basePath}/api/metrics`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;

    const key = (req.query as { range?: string }).range ?? '1h';
    const rangeSec = RANGES[key];
    if (rangeSec === undefined) {
      return reply.code(400).send({ error: `range 只能是 ${Object.keys(RANGES).join(' / ')}` });
    }

    /*
     * 没配采样器时如实回 enabled:false，而不是 404 或空数组了事 ——
     * 「没开采样」和「刚启动还没攒到数据」在界面上要说成两句不同的话，
     * 混在一起用户会以为系统坏了。
     */
    if (!metrics) {
      return reply.send({
        enabled: false, range: key, rangeSec, stepSec: 0, intervalSec: 0,
        from: Date.now() - rangeSec * 1000, to: Date.now(),
        firstSampleAt: null, points: [], instanceIds: [],
      });
    }

    return reply.send({
      enabled: true,
      range: key,
      rangeSec,
      intervalSec: metrics.fineStepSec,
      ...metrics.query(rangeSec),
    });
  });
}
