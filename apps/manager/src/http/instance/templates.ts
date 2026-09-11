/**
 * 流程模板的增删查改（T4.6）。
 *
 * 模板是**跨实例、跨项目复用的资产**，所以走全局的 `template:view` /
 * `template:manage`，不过实例授权矩阵。但「从某台实例现导一份模板」
 * 属于读那台实例的流程，仍要过它的矩阵 —— 否则「有模板管理权」
 * 就成了读取任意实例流程的旁路。
 *
 * 把模板套到实例上在 ./flows.ts，那是实例级破坏性操作。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { TemplateRepo } from '../../core/flows/repo.ts';
import { normalizeTemplateMetadata } from '../../core/flows/metadata.ts';
import { listBuiltinTemplates, getBuiltinTemplate, renderBuiltinTemplate, isBuiltinTemplateId } from '../../core/flows/templates/catalog.ts';
import { getFlows } from '../../core/flows/admin-client.ts';
import { checkCachedTemplateModelMappings } from '../../core/flows/templates/model-mapping.ts';
import type { FlowTemplateWithContent } from '../../core/flows/types.ts';
import type { HttpContext } from '../context.ts';
import { targetFor, failTemplate as fail } from './flows-target.ts';

export function registerTemplates(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard } = ctx;
  const templates = new TemplateRepo(db);

  // ── 模板增删查改 ──────────────────────────────────

  api.get(`${config.basePath}/api/templates`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'template:view' })) return;
    return reply.send({ templates: [...listBuiltinTemplates(), ...templates.list()] });
  });

  api.get(`${config.basePath}/api/templates/:tid`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'template:view' })) return;
    const { tid } = req.params as { tid: string };
    const t = getBuiltinTemplate(tid) ?? templates.getWithContent(tid);
    if (!t) return reply.code(404).send({ error: '模板不存在' });
    return reply.send({ template: t });
  });

  /** Pure render: authentication/CSRF still apply, but no asset or instance is mutated. */
  api.post(`${config.basePath}/api/templates/:tid/render`, async (req, reply) => {
    if (!guard(req, reply, { csrf: true, need: 'template:view' })) return;
    const { tid } = req.params as { tid: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const template = renderBuiltinTemplate(tid, body['parameters']);
      if (!template) return reply.code(404).send({ error: '内置模板不存在' });
      const modelChecked = checkCachedTemplateModelMappings(template.parameterValues, template.parameters ?? [],
        (product, version) => ctx.cloud?.getCachedModel(product, version));
      return reply.send({ template, modelChecked });
    } catch (error) { return fail(reply, error); }
  });

  /** 下载成文件，便于跨项目复用 —— 这正是「模板」这个东西存在的理由 */
  api.get(`${config.basePath}/api/templates/:tid/download`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'template:view' })) return;
    const { tid } = req.params as { tid: string };
    const t = getBuiltinTemplate(tid) ?? templates.getWithContent(tid);
    if (!t) return reply.code(404).send({ error: '模板不存在' });

    /*
     * 文件名要过两道处理，缺一不可：
     *
     *   1. 只留安全字符 —— 模板名是用户输入，引号和换行直接拼进 header 会被注入
     *   2. **非 ASCII 必须走 RFC 5987 的 `filename*`** —— HTTP 头是 ByteString，
     *      中文模板名直接塞进去会让 Headers 当场抛错（实测：`Cannot convert
     *      argument to a ByteString`），整个下载接口 500。备份接口没踩到这个坑，
     *      只是因为它的文件名是纯 ASCII 时间戳。
     *
     * 两个字段一起给：老客户端读 `filename`（ASCII 兜底名），
     * 认得 RFC 5987 的读 `filename*` 拿到原名。
     */
    const clean = t.name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40) || 'template';
    const ascii = clean.replace(/[^\w-]/g, '_') || 'template';
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="flows_${ascii}.json"; `
          + `filename*=UTF-8''${encodeURIComponent(`flows_${clean}.json`)}`,
      )
      .send(JSON.stringify(t.flows, null, 2));
  });

  /**
   * 建模板。上传/实例导出保留旧接口；内置副本必须由服务端渲染并保留依赖。
   *   · `builtinTemplateId` + `parameters` —— 配置后保存为自定义副本
   * 其他来源：
   *   · `instanceId` —— 从运行中的实例现导
   *   · `content`    —— 直接给流程 JSON（上传的文件、别处拷来的）
   */
  api.post(`${config.basePath}/api/templates`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'template:manage' });
    if (!user) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b['name'] === 'string' ? b['name'] : '';
    const description = typeof b['description'] === 'string' ? b['description'] : '';
    const instanceId = typeof b['instanceId'] === 'string' ? b['instanceId'] : '';

    try {
      let content: unknown = b['content'];
      let source = 'upload';
      let configured: FlowTemplateWithContent | undefined;
      let modelChecked = false;
      if (b['builtinTemplateId'] !== undefined) {
        if (typeof b['builtinTemplateId'] !== 'string' || !b['builtinTemplateId']
            || b['content'] !== undefined || b['instanceId'] !== undefined) {
          return reply.code(400).send({ error: 'builtinTemplateId 必须是内置模板 ID，且不能与 content 或 instanceId 同时使用' });
        }
        configured = renderBuiltinTemplate(b['builtinTemplateId'], b['parameters']);
        if (!configured) return reply.code(404).send({ error: '内置模板不存在' });
        modelChecked = checkCachedTemplateModelMappings(configured.parameterValues, configured.parameters ?? [],
          (product, version) => ctx.cloud?.getCachedModel(product, version));
      }

      if (instanceId !== '') {
        /*
         * 从实例导出属于读那台实例的流程，必须过它的授权矩阵 ——
         * 否则「有模板管理权」就成了读取任意实例流程的旁路。
         */
        if (!guard(req, reply, { csrf: true, need: 'instance:view', instance: instanceId })) return;
        const t = targetFor(ctx, instanceId);
        if ('error' in t) return reply.code(t.code).send({ error: t.error });
        content = await getFlows(t);
        source = instanceId;
      }
      if (content === undefined && !configured) {
        return reply.code(400).send({ error: '需要 content、instanceId 或 builtinTemplateId 之一' });
      }

      const metadata = normalizeTemplateMetadata({ category: b['category'], protocols: b['protocols'] }, configured);
      const saved = configured
        ? templates.saveConfiguredBuiltin(configured, { name, description, ...metadata }, user.username)
        : templates.save({ name, description, content, source, ...metadata }, user.username);
      recordAudit(db, {
        actor: user.username, action: 'template-create', target: saved.name,
        detail: `${saved.nodeCount} 节点 · 来源 ${saved.source}`
          + (saved.warnings.length ? ` · ${saved.warnings.length} 处疑似内联凭据` : ''),
        result: 'ok',
      });
      return reply.code(201).send({ template: saved, modelChecked });
    } catch (e) { return fail(reply, e); }
  });

  api.patch(`${config.basePath}/api/templates/:tid`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'template:manage' });
    if (!user) return;
    const { tid } = req.params as { tid: string };
    if (isBuiltinTemplateId(tid)) return reply.code(403).send({ error: '内置模板不可修改，请创建配置副本' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const t = templates.rename(
        tid,
        typeof b['name'] === 'string' ? b['name'] : '',
        typeof b['description'] === 'string' ? b['description'] : '',
        { category: b['category'], protocols: b['protocols'] },
      );
      if (!t) return reply.code(404).send({ error: '模板不存在' });
      recordAudit(db, { actor: user.username, action: 'template-rename', target: t.name, result: 'ok' });
      return reply.send({ template: t });
    } catch (e) { return fail(reply, e); }
  });

  api.delete(`${config.basePath}/api/templates/:tid`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'template:manage' });
    if (!user) return;
    const { tid } = req.params as { tid: string };
    if (isBuiltinTemplateId(tid)) return reply.code(403).send({ error: '内置模板不可删除，请管理自定义副本' });
    const existing = templates.get(tid);
    if (!templates.remove(tid)) return reply.code(404).send({ error: '模板不存在' });
    recordAudit(db, {
      actor: user.username, action: 'template-delete',
      target: existing?.name ?? tid, result: 'ok',
    });
    return reply.code(204).send();
  });
}
