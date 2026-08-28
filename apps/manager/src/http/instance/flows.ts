/**
 * 实例流程的导出与套用（T4.6）。
 *
 * 两条路由，都挂在 `/api/instances/:id/flows` 上：
 *   · `GET`  导出当前流程
 *   · `POST` 套用模板或直接给的流程
 *
 * **套用是破坏性的**：整体替换目标实例的全部流程，旧流程不再保留。
 * 因此它走 `instance:operate`（实例级、要过授权矩阵），而不是模板那两个全局权限
 * —— 有权管模板不等于有权动别人负责的产线。
 *
 * 模板本身的增删查改在 ./templates.ts。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { TemplateRepo } from '../../core/flows/repo.ts';
import { parseFlows, summarize } from '../../core/flows/parse.ts';
import { scanInlineSecrets } from '../../core/flows/scan.ts';
import { checkCompatibility, type CompatResult } from '../../core/flows/compat.ts';
import { getFlows, setFlows, getInstalledTypes } from '../../core/flows/admin-client.ts';
import type { HttpContext } from '../context.ts';
import { targetFor, failTemplate as fail } from './flows-target.ts';

export function registerFlows(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard } = ctx;
  const templates = new TemplateRepo(db);

  // ── 从实例导出 ────────────────────────────────────

  api.get(`${config.basePath}/api/instances/:id/flows`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: id })) return;

    const t = targetFor(ctx, id);
    if ('error' in t) return reply.code(t.code).send({ error: t.error });

    try {
      const flows = parseFlows(await getFlows(t));
      return reply.send({
        flows,
        ...summarize(flows),
        /*
         * 实测 5.0.4：GET /flows 不返回 credentials（它们单独存在加密的
         * flows_cred.json 里），所以按规范声明的凭据不会跟着导出。
         * 但 function 节点里硬编码的密钥会原样带出，扫出来在这儿讲清楚。
         */
        warnings: scanInlineSecrets(flows),
        note: '按规范声明的节点凭据不会被导出；但 function 节点里硬编码的密钥会，'
          + '分发模板前请先看 warnings。',
      });
    } catch (e) { return fail(reply, e); }
  });

  // ── 套用到实例 ────────────────────────────────────

  /**
   * 套用。**整体替换**目标实例的全部流程。
   *
   * `dryRun: true` 只做兼容性检查不部署 —— 现场套模板前先看一眼缺不缺节点，
   * 比套完发现一屏红叉再回滚划算得多。
   */
  api.post(`${config.basePath}/api/instances/:id/flows`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    const templateId = typeof b['templateId'] === 'string' ? b['templateId'] : '';
    const dryRun = b['dryRun'] === true;

    const t = targetFor(ctx, id);
    if ('error' in t) return reply.code(t.code).send({ error: t.error });

    try {
      let flows;
      let label: string;
      if (templateId !== '') {
        const tpl = templates.getWithContent(templateId);
        if (!tpl) return reply.code(404).send({ error: '模板不存在' });
        flows = tpl.flows;
        label = tpl.name;
      } else if (b['flows'] !== undefined) {
        flows = parseFlows(b['flows']);
        label = '直接提交的流程';
      } else {
        return reply.code(400).send({ error: '需要 templateId 或 flows 之一' });
      }

      const s = summarize(flows);
      /*
       * 兼容性检查取不到清单时不阻断部署：拿不到不等于不兼容，
       * 硬拦会让「实例的 /nodes 暂时不可达」变成「模板永远套不上」。
       *
       * 但**默认值必须标成 `checked: false`**：这时的 `ok: true` 是
       * 「没查」而不是「查过没问题」，两者混在一起，界面就会对着一次
       * 没做成的检查显示绿色的「节点齐全，可以套用」。
       */
      let compat: CompatResult = { ok: true, checked: false, missing: [] };
      try {
        compat = checkCompatibility(s.nodeTypes, await getInstalledTypes(t));
      } catch { /* 拿不到清单就跳过这一步，下面照常部署 */ }

      if (dryRun) {
        return reply.send({
          dryRun: true, ...s, compat,
          warnings: scanInlineSecrets(flows),
          note: !compat.checked
            ? '没能读到目标实例已装的节点清单，所以这次并没有确认过节点是否齐全。'
              + '可以继续套用，但万一缺节点，Node-RED 不会报错——流程会套上、就是不出数。'
            : compat.ok
              ? '目标实例已装齐所需节点，可以套用'
              : `目标实例缺少 ${compat.missing.length} 种节点，套上去这些节点会变成坏节点且不报错`,
        });
      }

      const before = await getFlows(t).catch(() => null);
      const { status } = await setFlows(t, flows);

      recordAudit(db, {
        actor: user.username, action: 'template-apply', target: id,
        detail: `套用「${label}」：${s.nodeCount} 节点 / ${s.tabCount} 标签页`
          + (compat.ok ? '' : ` · 缺节点 ${compat.missing.join(' ')}`),
        result: 'ok',
      });

      return reply.send({
        applied: true,
        deployStatus: status,      // 实测 5.0.4 是 204
        ...s,
        compat,
        replacedNodeCount: Array.isArray(before) ? before.length : null,
        note: !compat.checked
          ? '已整体替换并部署。没能读到目标实例的节点清单，未能确认节点是否齐全——'
            + '到实例编辑器里看一眼有没有标红的节点。'
          : compat.ok
            ? '已整体替换并部署'
            : `已部署，但目标实例缺少节点：${compat.missing.join('、')}——这些节点不会工作`,
      });
    } catch (e) {
      recordAudit(db, {
        actor: user.username, action: 'template-apply', target: id,
        detail: (e as Error).message, result: 'fail',
      });
      return fail(reply, e);
    }
  });
}
