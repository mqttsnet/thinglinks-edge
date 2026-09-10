/**
 * 实例流程的导出与套用（T4.6）。
 *
 * 两条路由，都挂在 `/api/instances/:id/flows` 上：
 *   · `GET`  导出当前流程
 *   · `POST` 套用模板或直接给的流程
 *
 * 支持安全追加与显式替换；旧客户端省略 mode 时保持整体替换。
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
import { getFlows, AdminApiError } from '../../core/flows/admin-client.ts';
import { prepareFlowDeployment, deployPreparedFlows } from '../../core/flows/deployment.ts';
import { isBuiltinTemplateId, getBuiltinTemplate, renderBuiltinTemplate } from '../../core/flows/templates/catalog.ts';
import { checkCachedTemplateModelMappings } from '../../core/flows/templates/model-mapping.ts';
import { TemplateRevisionError, type FlowTemplateWithContent } from '../../core/flows/types.ts';
import type { HttpContext } from '../context.ts';
import { targetFor, failTemplate as fail } from './flows-target.ts';

/** Reconfigure server-owned recipe copies; ordinary uploaded flows never reach this path. */
function reconfigureCopy(saved: FlowTemplateWithContent, input: unknown): FlowTemplateWithContent {
  const lineage = saved.derivedFrom!;
  const current = getBuiltinTemplate(lineage.templateId);
  if (!current || current.revision !== lineage.revision) {
    throw new TemplateRevisionError('来源内置模板版本已变化或不可用，不能按新版本静默重建；请使用已保存快照或创建新版副本');
  }
  // Scalar fields override saved values; a provided table replaces that entire table.
  const values = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? { ...saved.parameterValues, ...input }
    : input;
  const rendered = renderBuiltinTemplate(lineage.templateId, values);
  if (!rendered) throw new TemplateRevisionError('来源内置模板不可用');
  const versions = new Map((rendered.requirements ?? []).map(requirement => [requirement.module, requirement.version]));
  if (saved.requirements?.some(requirement => versions.has(requirement.module) && versions.get(requirement.module) !== requirement.version)) {
    throw new TemplateRevisionError('副本归档的组件版本与当前内置模板不一致，请创建新版副本后再配置');
  }
  return {
    ...saved, ...summarize(rendered.flows), flows: rendered.flows,
    requirements: rendered.requirements ?? [], parameters: rendered.parameters ?? [],
    parameterValues: rendered.parameterValues ?? {},
  };
}

export function registerFlows(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, operationGate } = ctx;
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
   * 内置模板默认追加，旧客户端省略 mode 时仍整体替换。
   *
   * `dryRun: true` 只做兼容性检查不部署 —— 现场套模板前先看一眼缺不缺节点，
   * 比套完发现一屏红叉再回滚划算得多。
   */
  api.post(`${config.basePath}/api/instances/:id/flows`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;

    try {
      return await operationGate.run(id, 'flow-write', async () => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const templateId = typeof b['templateId'] === 'string' ? b['templateId'] : '';
        const dryRun = b['dryRun'] === true;
        const t = targetFor(ctx, id);
        if ('error' in t) return reply.code(t.code).send({ error: t.error });

        try {
          let flows;
          let label: string;
          let template: FlowTemplateWithContent | undefined;
          let snapshotNote = '';
          const builtin = isBuiltinTemplateId(templateId);
          if (templateId !== '') {
            template = builtin
              ? renderBuiltinTemplate(templateId, b['parameters'])
              : templates.getWithContent(templateId);
            if (!template) return reply.code(404).send({ error: '模板不存在' });
            if (!builtin && template.derivedFrom) {
              if (template.parameterValues && b['parameters'] !== undefined) {
                template = reconfigureCopy(template, b['parameters']);
              } else {
                snapshotNote = template.parameterValues
                  ? '本次按已保存的固定流程快照处理。'
                  : '该旧副本没有参数档案，本次使用固定流程快照。';
              }
            }
            flows = template.flows;
            label = template.name;
          } else if (b['flows'] !== undefined) {
            flows = parseFlows(b['flows']);
            label = '直接提交的流程';
          } else {
            return reply.code(400).send({ error: '需要 templateId 或 flows 之一' });
          }

          const modelChecked = template?.parameterValues
            ? checkCachedTemplateModelMappings(template.parameterValues, template.parameters ?? [],
              (product, version) => ctx.cloud?.getCachedModel(product, version))
            : false;
          const prepared = await prepareFlowDeployment(t, {
            flows, builtin, mode: b['mode'], expectedRevision: b['expectedRevision'],
            ...(template?.requirements ? { requirements: template.requirements } : {}),
          });
          if (snapshotNote) prepared.note = snapshotNote + prepared.note;
          const { flowsToDeploy: _flows, ...preview } = prepared;
          if (dryRun) return reply.send({ dryRun: true, ...preview, modelChecked });
          if (!prepared.deployable) return reply.code(409).send({ error: prepared.note, ...preview, modelChecked });

          const { status } = await deployPreparedFlows(t, prepared);
          recordAudit(db, {
            actor: user.username, action: 'template-apply', target: id,
            detail: `${prepared.mode === 'append' ? '追加' : '替换'}「${label}」：${prepared.nodeCount} 节点 / ${prepared.tabCount} 标签页`
              + (prepared.compat.ok ? '' : ` · 缺节点 ${prepared.compat.missing.join(' ')}`),
            result: 'ok',
          });
          return reply.send({
            applied: true, deployStatus: status, ...preview, modelChecked,
            note: `${prepared.mode === 'append' ? '已追加并部署' : '已整体替换并部署'}。${prepared.note}`,
          });
        } catch (e) {
          recordAudit(db, {
            actor: user.username, action: 'template-apply', target: id,
            detail: (e as Error).message, result: 'fail',
          });
          if (e instanceof TemplateRevisionError || e instanceof AdminApiError && e.status === 409) return reply.code(409).send({ error: e.message });
          return fail(reply, e);
        }
      });
    } catch (e) {
      return ctx.fail(reply, e);
    }
  });
}
