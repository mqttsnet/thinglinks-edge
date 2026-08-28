/**
 * 安装自检的 HTTP 入口（T6.2）。
 *
 * 自检的主战场是**装之前**（CLI 子命令 `preflight`），那时候服务还没起来。
 * 这个接口是装完之后的补充用途：环境会漂移 —— 磁盘会满、证书会过期、
 * 时钟会跑偏、别的服务会来抢端口。装的那天全绿不代表半年后还全绿。
 *
 * 走 `diag:run` 权限，与诊断包同一档：它读的是环境事实，不改任何状态。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { runPreflight, renderReport, adaptDocker } from '../../core/preflight/run.ts';
import { readHostStats } from '../../core/health/host-stats.ts';
import type { HttpContext } from '../context.ts';

export function registerPreflight(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, service } = ctx;

  api.post(`${config.basePath}/api/diag/preflight`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'diag:run' });
    if (!user) return;

    const raw = service.dockerHandle;
    const report = await runPreflight({
      externalUrl: config.externalUrl,
      listenAddr: config.listenAddr,
      listenPort: config.listenPort,
      dataDir: config.dataDir,
      portRange: config.portRange,
      images: (process.env['ALLOWED_IMAGE_TAGS'] ?? '5.0.4-24-minimal,4.1.13-22-minimal')
        .split(',').map((t) => `nodered/node-red:${t.trim()}`).filter(Boolean),
      corporateCidrs: (process.env['CORPORATE_CIDRS'] ?? '')
        .split(',').map((c) => c.trim()).filter(Boolean),
      ntpServer: process.env['NTP_SERVER']?.trim() ?? '',
      internalHosts: {
        managerContainer: process.env['MANAGER_CONTAINER']?.trim() ?? '',
        instancePrefix: 'tle-nr-',
        network: process.env['INSTANCE_NETWORK'] ?? 'thinglinks-edge',
      },
      cloudConfigured: ctx.cloud?.configured === true,
      ...(raw ? { docker: adaptDocker(raw) } : {}),
      hostStats: () => readHostStats(config.dataDir),
    });

    recordAudit(db, {
      actor: user.username, action: 'diag-preflight',
      target: report.ok ? 'ok' : 'blocked',
      detail: `阻断 ${report.blocking} · 告警 ${report.warnings} · 未检查 ${report.skipped}`,
      result: report.ok ? 'ok' : 'fail',
    });

    /*
     * **有阻断也回 200。** 自检跑成功了，「结论是不该装」是它的正常输出，
     * 不是接口错误。用 4xx/5xx 表达业务结论会让前端把它当调用失败处理，
     * 那时候用户看到的是「请求失败」而不是那份写得很清楚的报告。
     */
    return reply.send({ report, text: renderReport(report) });
  });
}
