/**
 * 单次连通性与时钟探测（T4.5）。
 *
 * 这一组就是「受控终端」的替代方案：**固定的、每次进审计的诊断动作**，
 * 覆盖现场真正要问的三件事 —— 域名解析得出来吗 / 端口通不通 / 时间对不对。
 * 全部用 node 标准库在进程内完成，一个外部命令都不执行。
 * 要执行任意命令请走宿主的正常运维通道，那条路径有它自己的审计与授权。
 *
 * 用于现场边改配置边看效果，不必每次导整包。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { probeEndpoint } from '../../core/diag/probe.ts';
import { readClock } from '../../core/diag/ntp.ts';
import type { HttpContext } from '../context.ts';
import { MAX_TARGETS, MAX_TIMEOUT_MS } from './secrets.ts';

export function registerDiagProbe(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, cloud } = ctx;

  /** 每次调用都记审计 —— 它能对任意地址发起连接，属于需要留痕的能力 */
  api.post(`${config.basePath}/api/diag/probe`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'diag:run' });
    if (!user) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(b['targets']) ? (b['targets'] as unknown[]).map(String) : [];
    const timeoutMs = Math.min(Number(b['timeoutMs'] ?? 5_000) || 5_000, MAX_TIMEOUT_MS);

    // 没给目标就探当前配置的云 broker —— 现场十次里有九次问的就是这个
    const fallback = cloud?.status().brokerUrl;
    const targets = (raw.length > 0 ? raw : fallback ? [fallback] : []).slice(0, MAX_TARGETS);
    if (targets.length === 0) {
      return reply.code(400).send({ error: '未指定探测目标，且当前未配置云对接' });
    }

    const probes = [];
    for (const t of targets) {
      try {
        probes.push(await probeEndpoint(t, timeoutMs));
      } catch (e) {
        probes.push({ target: t, dns: null, tcp: null, summary: (e as Error).message });
      }
    }
    const clock = await readClock(process.env['NTP_SERVER']?.trim() ?? '', timeoutMs);

    recordAudit(db, {
      actor: user.username, action: 'diag-probe', target: targets.join(' '),
      detail: probes.map((p) => p.summary).join('；'),
      result: probes.every((p) => 'tcp' in p && p.tcp?.ok) ? 'ok' : 'fail',
    });

    return reply.send({
      probes,
      clock,
      note: '「可达」只代表 TCP 握手成功。透明代理或运营商劫持会让这一步误报成功，'
        + '云平台是否真正可用请以对接页的链路状态为准。',
    });
  });
}
