/**
 * 诊断包导出（T4.5）。
 *
 * **刻意不提供「受控终端」。** 需求里写了这一项，但在本架构下实现它意味着
 * 要在受限 docker 代理上重新放开 `exec` —— 那正是 A4 关掉的东西，
 * 一旦放开，「Manager 不能在任意容器里起进程」这条安全属性就作废了，
 * 而它是整个隔离模型的支点。替代方案见 ./probe.ts 那组固定的诊断动作。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { collectDiagnostics } from '../../core/diag/collect.ts';
import type { HttpContext } from '../context.ts';
import { collectSecrets, MAX_TARGETS } from './secrets.ts';

export function registerDiagBundle(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, service, cloud, spool } = ctx;

  /*
   * 用 POST 而不是 GET：包里即便脱敏过也含现场拓扑与日志，
   * 走 CSRF 校验的写通道更稳妥，也不会被浏览器预取或缓存。
   * 与备份接口同一条理由。
   */
  api.post(`${config.basePath}/api/diag/bundle`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'diag:run' });
    if (!user) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    const targets = Array.isArray(b['probeTargets'])
      ? (b['probeTargets'] as unknown[]).map(String).slice(0, MAX_TARGETS)
      : undefined;

    try {
      const { archive, manifest } = await collectDiagnostics(
        {
          config,
          db,
          instances: () => service.list(),
          health: () => service.healthAll(),
          hostStats: () => service.hostStats(),
          logs: (id, tail) => service.logs(id, tail),
          cloudStatus: () => (cloud ? cloud.status() : null),
          spoolMetrics: async () => (spool ? await spool.metrics() : null),
          secrets: () => collectSecrets(ctx),
        },
        {
          actor: user.username,
          ...(targets ? { probeTargets: targets } : {}),
          ntpServer: process.env['NTP_SERVER']?.trim() ?? '',
          ...(typeof b['logTail'] === 'number' ? { logTail: Math.min(b['logTail'], 5_000) } : {}),
        },
      );

      const name = `thinglinks-edge-diag-${
        new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.tar`;
      recordAudit(db, {
        actor: user.username, action: 'diag-bundle', target: name,
        detail: `${archive.length} 字节 · ${manifest.files.length} 个文件`
          + (manifest.failures.length ? ` · ${manifest.failures.length} 项未收集` : ''),
        result: 'ok',
      });
      return reply
        .header('content-type', 'application/x-tar')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(archive);
    } catch (e) {
      /*
       * 自检不通过会走到这里。**必须当成失败**，不能降级成「导出一个删减版」——
       * 那样调用方拿到的仍是一个可能含凭据的包，只是自己不知道。
       */
      const msg = (e as Error).message;
      recordAudit(db, {
        actor: user.username, action: 'diag-bundle', target: 'refused',
        detail: msg, result: 'fail',
      });
      return reply.code(500).send({
        error: `诊断包导出被拒绝：${msg}`,
        hint: '这是导出前自检拦下的。请检查最近新增的字段是否把凭据带进了诊断内容，修好再导。',
      });
    }
  });
}
