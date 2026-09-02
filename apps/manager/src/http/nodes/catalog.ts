/**
 * 节点管理的管理面接口（01 号文 5.7）。
 *
 * 四件事对应四组路由：
 *
 *   批准清单  /api/nodes/catalog     ——「允许装什么」
 *   离线包库  /api/nodes/store       ——「有什么可装」
 *   下发策略  /api/nodes/apply       —— 把清单写进实例并重启
 *   已装台账  /api/nodes/inventory   ——「实际装了什么」
 *
 * 前三个是全局资产（跨实例），走 node:view / node:manage，不过实例授权矩阵。
 * **台账不一样**：它暴露的是某台实例上的东西，必须按实例可见性过滤 ——
 * 否则「有节点查看权」就成了枚举全部实例的旁路。
 */
import type { FastifyInstance } from 'fastify';
import { recordAudit } from '../../core/db.ts';
import { NodePolicyError } from '../../core/nodes/policy.ts';
import { closureReport, type NodeStore } from '../../core/nodes/store.ts';
import { inventoryOf } from '../../core/nodes/inventory.ts';
import { installModule, AdminApiError } from '../../core/flows/admin-client.ts';
import { assertValidId } from '../../core/instance/container-spec.ts';
import {
  PlatformMigrationError,
  type PlatformMigrationService,
} from '../../core/nodes/platform-migration.ts';
import type { NodeMigrationErrorCode } from '../../core/instance/repo.ts';
import type { NodeCatalog } from '../../core/nodes/catalog.ts';
import type { NpmSourceRepo } from '../../core/nodes/sources.ts';
import type { UpstreamRegistry } from '../../core/nodes/upstream.ts';
import { targetFor } from '../instance/flows-target.ts';
import type { HttpContext } from '../context.ts';

/** 单个节点包的体积上限。超过基本就不是节点包了，先挡住再说 */
const MAX_TGZ_BYTES = 64 * 1024 * 1024;

export interface CatalogDeps {
  store: NodeStore;
  catalog: NodeCatalog;
  /** Task9 构造的唯一迁移服务；HTTP 层只转发显式请求，绝不自行重建。 */
  migrationService: PlatformMigrationService;
  /** 节点源清单。留空则不挂源管理与在线搜索（纯离线部署） */
  sources?: NpmSourceRepo | undefined;
  upstream?: UpstreamRegistry | undefined;
}

/**
 * inventoryOf 已按 Node-RED node set 聚合出模块来源和模块健康度；HTTP 响应再保留
 * 这台实例的整体健康与重复类型 owner。这里不看可选 file 字段，来源只来自已有聚合。
 */
function inventoryEvidence<T extends {
  ok: boolean;
  modules: Array<{ module: string; types: string[]; health: 'healthy' | 'conflict' | 'failed' }>;
}>(inventory: T): T & {
  health?: 'healthy' | 'conflict' | 'failed';
  conflicts: Array<{ type: string; owners: string[] }>;
} {
  if (!inventory.ok) return { ...inventory, conflicts: [] };
  const ownersByType = new Map<string, Set<string>>();
  for (const module of inventory.modules) {
    for (const type of module.types) {
      const owners = ownersByType.get(type) ?? new Set<string>();
      owners.add(module.module);
      ownersByType.set(type, owners);
    }
  }
  const conflicts = [...ownersByType.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([type, owners]) => ({ type, owners: [...owners].sort() }))
    .sort((left, right) => left.type.localeCompare(right.type));
  const health = inventory.modules.some((module) => module.health === 'failed') ? 'failed'
    : conflicts.length > 0 ? 'conflict' : 'healthy';
  return { ...inventory, health, conflicts };
}

export function registerNodeCatalog(
  api: FastifyInstance, ctx: HttpContext, deps: CatalogDeps,
): void {
  const { config, db, guard, operationGate } = ctx;
  const { store, catalog, migrationService, sources, upstream } = deps;

  /*
   * 迁移失败信息不能直接回显：底层预检会接触实例环境、检查点和运行期凭据。
   * 状态中的 error 是持久化的受控枚举，下面的摘要同样只基于该枚举生成。
   */
  const migrationErrorSummary: Record<NodeMigrationErrorCode, string> = {
    none: '没有迁移错误',
    preflight: '迁移预检未通过，请检查实例状态后重试',
    checkpoint: '迁移检查点不可用，未继续执行',
    install: '平台节点包安装未完成，请刷新迁移状态',
    cutover: '节点运行模式切换未完成，请刷新迁移状态',
    verification: '迁移校验未通过，已保留受控状态',
    rollback: '迁移回滚未完全完成，需要按状态处理',
    compensation: '迁移补偿未完成，需要按状态处理',
    'state-inconsistent': '迁移状态不一致，需要人工确认',
  };

  const migrationInstanceId = (req: any, reply: any): string | undefined => {
    const id = String((req.params as { id?: unknown }).id ?? '');
    try {
      assertValidId(id);
      return id;
    } catch {
      reply.code(400).send({ error: '实例 ID 非法' });
      return undefined;
    }
  };

  /*
   * 节点包是二进制。只在本插件作用域内加这一个解析器 ——
   * 全局加会影响到反代给实例的请求体处理。
   */
  api.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_TGZ_BYTES },
    (_req, body, done) => { done(null, body); },
  );

  const fail = (reply: any, e: unknown) => {
    if (e instanceof NodePolicyError) return reply.code(400).send({ error: e.message });
    throw e;
  };

  // ── 批准清单 ──────────────────────────────────────

  api.get(`${config.basePath}/api/nodes/catalog`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'node:view' })) return;
    const entries = catalog.list();
    return reply.send({
      entries: entries.map((e) => ({
        ...e,
        /*
         * 顺带回「这个包在离线库里有没有」。批了但库里没有，
         * 在无外网现场就等于批了个装不上的东西 —— 界面要能一眼看出来，
         * 而不是等现场点了安装才发现。
         */
        inStore: store.versions(e.module).length > 0,
        storeVersions: store.versions(e.module),
      })),
    });
  });

  api.post(`${config.basePath}/api/nodes/catalog`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    const body = (req.body ?? {}) as { module?: string; version?: string; note?: string };
    if (typeof body.module !== 'string') {
      return reply.code(400).send({ error: '缺少 module' });
    }
    try {
      const entry = catalog.approve({
        module: body.module.trim(),
        version: typeof body.version === 'string' ? body.version : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
        actor: user.username,
      });
      recordAudit(db, {
        actor: user.username, action: 'approve-node', target: entry.module,
        result: 'ok', detail: entry.version ?? '不限版本',
      });

      /*
       * 顺手把包体拉进本地库（`download` 为真时）。
       *
       * 批准之后包仍不在库里的话，实例第一次安装还得联网 —— 而现场装节点
       * 常常正是在网络不稳的时候。批准时就拉下来，之后离线也装得上，
       * 打离线包时也直接带走。
       *
       * 拉失败**不影响批准**：批准是管理动作，已经成立；下载只是预热。
       * 但要如实告诉调用方，界面据此提示「已批准，但包体还没拉下来」。
       */
      let downloaded: string | undefined;
      let downloadError = '';
      const wantDownload = (req.body as { download?: unknown } | undefined)?.download === true;
      if (wantDownload && upstream?.enabled) {
        try {
          const vs = await upstream.versions(entry.module);
          const pick = vs[0]?.version;
          if (!pick) throw new Error('源里没有可用版本');
          if (!store.has(entry.module, pick)) {
            const body = await upstream.tarball(entry.module, pick);
            if (!body) throw new Error(`源里没有 ${entry.module}@${pick}`);
            store.add(body);
          }
          downloaded = pick;
          recordAudit(db, {
            actor: user.username, action: 'cache-node-package',
            target: `${entry.module}@${pick}`, result: 'ok', detail: '批准时预下载',
          });
        } catch (e) {
          downloadError = (e as Error).message;
          recordAudit(db, {
            actor: user.username, action: 'cache-node-package',
            target: entry.module, result: 'fail', detail: downloadError,
          });
        }
      }
      /*
       * 批准只改库，**不自动下发到实例** —— 下发要重启实例，
       * 那是会中断现场采集的动作，不能作为「点了保存」的副作用发生。
       * 界面据此提示「已批准，需下发后生效」。
       */
      return reply.send({ entry, applied: false, downloaded, downloadError });
    } catch (e) {
      return fail(reply, e);
    }
  });

  api.delete(`${config.basePath}/api/nodes/catalog/*`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    const module = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    if (!catalog.revoke(module)) {
      return reply.code(404).send({ error: `${module} 不在批准清单里` });
    }
    recordAudit(db, { actor: user.username, action: 'revoke-node', target: module, result: 'ok' });
    /*
     * 撤销同样不自动下发。而且要说清楚：**已经装上的节点不会因为撤销而消失**，
     * 撤销只让它「以后装不上」。想清掉已装的得去实例里卸载。
     */
    return reply.send({ ok: true, applied: false });
  });

  // ── 节点源 ────────────────────────────────────────
  //
  // 源的增删改必须在页面上完成 —— 现场加一个内网私服是常规运维动作，
  // 不该每次都改编排文件重启。环境变量只在全新安装时用作初始值。

  api.get(`${config.basePath}/api/nodes/sources`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'node:view' })) return;
    return reply.send({ sources: sources?.list() ?? [] });
  });

  api.post(`${config.basePath}/api/nodes/sources`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    if (!sources) return reply.code(400).send({ error: '本部署未启用节点源管理' });
    const b = (req.body ?? {}) as { name?: string; url?: string };
    if (typeof b.url !== 'string') return reply.code(400).send({ error: '缺少 url' });
    try {
      const src = sources.add({ name: String(b.name ?? ''), url: b.url, actor: user.username });
      recordAudit(db, {
        actor: user.username, action: 'add-node-source', target: src.url,
        result: 'ok', detail: src.name,
      });
      return reply.send({ source: src });
    } catch (e) { return fail(reply, e); }
  });

  api.post(`${config.basePath}/api/nodes/sources/:id/enabled`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    if (!sources) return reply.code(400).send({ error: '本部署未启用节点源管理' });
    const id = Number((req.params as { id: string }).id);
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled === true;
    if (!sources.setEnabled(id, enabled)) return reply.code(404).send({ error: '源不存在' });
    recordAudit(db, {
      actor: user.username, action: 'toggle-node-source', target: String(id),
      result: 'ok', detail: enabled ? '启用' : '停用',
    });
    return reply.send({ ok: true });
  });

  api.delete(`${config.basePath}/api/nodes/sources/:id`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    if (!sources) return reply.code(400).send({ error: '本部署未启用节点源管理' });
    const id = Number((req.params as { id: string }).id);
    if (!sources.remove(id)) return reply.code(404).send({ error: '源不存在' });
    recordAudit(db, { actor: user.username, action: 'remove-node-source', target: String(id), result: 'ok' });
    return reply.send({ ok: true });
  });

  // ── 在线搜索 ──────────────────────────────────────

  /**
   * 在启用的源里模糊搜索节点包。
   *
   * 搜索本身不改任何东西，所以只要 node:view —— 让运维能先看看有什么，
   * 再决定要不要找管理员批。
   */
  api.get(`${config.basePath}/api/nodes/search`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'node:view' })) return;
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (!upstream?.enabled) {
      return reply.send({ enabled: false, hits: [], reason: '未配置任何启用中的节点源' });
    }
    if (!q) return reply.send({ enabled: true, hits: [] });
    try {
      return reply.send({ enabled: true, hits: await upstream.search(q) });
    } catch (e) { return fail(reply, e); }
  });

  /** 某个包的可选版本，新的在前。批准对话框的版本下拉用它 */
  api.get(`${config.basePath}/api/nodes/versions`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'node:view' })) return;
    const module = String((req.query as { module?: string }).module ?? '').trim();
    if (!module) return reply.code(400).send({ error: '缺少 module' });
    if (!upstream?.enabled) return reply.send({ versions: [], local: store.versions(module) });
    try {
      return reply.send({
        versions: await upstream.versions(module),
        // 库里已有的版本要标出来：那些是离线也装得上的
        local: store.versions(module),
      });
    } catch (e) { return fail(reply, e); }
  });

  // ── 离线包库 ──────────────────────────────────────

  api.get(`${config.basePath}/api/nodes/store`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'node:view' })) return;
    const approved = catalog.names();
    const packages = [];
    for (const m of store.modules()) {
      const versions = store.versions(m);
      const latest = versions[versions.length - 1];
      if (latest === undefined) continue;
      const meta = store.meta(m, latest);
      if (!meta) continue;
      // 一次算完两种缺口：这一步要把闭包里每个包的 tgz 都读一遍，不便算两次
      const gaps = closureReport(store, m, latest);
      packages.push({
        module: m,
        versions,
        latest,
        description: meta.description,
        types: meta.types,
        isNodeRedNode: meta.isNodeRedNode,
        size: meta.size,
        updatedAt: meta.updatedAt,
        approved: approved.has(m),
        // 依赖没配齐的包在离线现场装不上，这里直接把缺口点出来
        missingDeps: gaps.missing,
        /*
         * 可选依赖的缺口分开报：缺了**不会**让安装失败，所以界面上
         * 不能和「装不上」同样对待；但也不能不说 —— modbus 的串口（RTU）
         * 支持就在 optionalDependencies 里，缺了是「装上了却少一半功能」。
         */
        missingOptionalDeps: gaps.missingOptional,
      });
    }
    return reply.send({ packages, root: store.root });
  });

  /**
   * 导入一个 .tgz。请求体就是文件本身（application/octet-stream）。
   *
   * 不用 multipart：为了一个「上传单个文件」的接口引 @fastify/multipart，
   * 收益抵不上多一个依赖。裸字节 POST 用 curl --data-binary 也更好写，
   * 而离线现场恰恰是拿 curl 干活的地方。
   */
  api.post(`${config.basePath}/api/nodes/store`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({
        error: '请求体必须是 .tgz 文件字节，且 content-type 为 application/octet-stream',
      });
    }
    try {
      const meta = store.add(body);
      recordAudit(db, {
        actor: user.username, action: 'import-node-package',
        target: `${meta.name}@${meta.version}`, result: 'ok',
        detail: meta.isNodeRedNode ? '节点包' : '依赖包',
      });
      const gaps = closureReport(store, meta.name, meta.version);
      return reply.send({
        package: meta,
        missingDeps: gaps.missing,
        missingOptionalDeps: gaps.missingOptional,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  api.delete(`${config.basePath}/api/nodes/store/*`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    const rest = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    const at = rest.lastIndexOf('@');
    // scope 包名自带一个前导 @，所以要找**最后**一个，且它不能在第 0 位
    if (at <= 0) return reply.code(400).send({ error: '路径应为 <module>@<version>' });
    try {
      const module = rest.slice(0, at);
      const version = rest.slice(at + 1);
      if (!store.remove(module, version)) {
        return reply.code(404).send({ error: `库里没有 ${rest}` });
      }
      recordAudit(db, {
        actor: user.username, action: 'remove-node-package', target: rest, result: 'ok',
      });
      return reply.send({ ok: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ── 下发策略 ──────────────────────────────────────

  /**
   * 把当前批准清单写进实例并重启。
   *
   * 逐台做且**不因为某台失败就中断** —— 现场常有停机或异常的实例，
   * 一台挡住其余全部，会让人只能一台台手工来。结果里逐台给出成败。
   */
  api.post(`${config.basePath}/api/nodes/apply`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'node:manage' });
    if (!user) return;
    const body = (req.body ?? {}) as { instances?: unknown };
    const all = ctx.repo.list().map((r) => r.id);
    const targets = Array.isArray(body.instances) && body.instances.length > 0
      ? all.filter((id) => (body.instances as unknown[]).includes(id))
      : all;

    const results = [];
    for (const id of targets) {
      try {
        const r = await ctx.service.applyNodePolicy(id, user.username);
        results.push({ instanceId: id, ok: true, restarted: r.restarted, error: '' });
      } catch (e) {
        results.push({
          instanceId: id, ok: false, restarted: false, error: (e as Error).message,
        });
      }
    }
    return reply.send({ results });
  });

  // ── 已装台账 ──────────────────────────────────────

  api.get(`${config.basePath}/api/nodes/inventory`, async (req, reply) => {
    const user = guard(req, reply, { csrf: false, need: 'node:view' });
    if (!user) return;
    const approved = catalog.names();
    // 只看得见自己有权限的实例 —— 见文件头
    const ids = ctx.visibleOnly(
      user, ctx.repo.list().map((r) => ({ instanceId: r.id })),
    ).map((x) => x.instanceId);

    const out = [];
    for (const id of ids) {
      const t = targetFor(ctx, id);
      if ('error' in t) {
        out.push({ instanceId: id, ok: false, reason: t.error, modules: [], unapproved: 0 });
        continue;
      }
      out.push(inventoryEvidence(await inventoryOf(id, t, approved)));
    }
    return reply.send({ instances: out });
  });

  /**
   * 把一个节点包装进指定实例（01 号文 5.7）。
   *
   * 路径按资源写成 `/api/instances/:id/nodes`，代码放在节点管理这个文件里 ——
   * 它属于节点管理这条业务线，与批准、下发、台账是一套。
   *
   * 权限用 `instance:operate`：这是往**那台实例**里装会执行的代码，
   * 必须过它的授权矩阵；只有全局的 node:view 是不够的。
   *
   * 走实例自己的 Admin API，**不绕过白名单** —— 绕过去就成了
   * 「面板装受管控、控制台装不受管控」，两套规则迟早出事。
   */
  api.post(`${config.basePath}/api/instances/:id/nodes`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;

    try {
      return await operationGate.run(id, 'install-node', async () => {
        const b = (req.body ?? {}) as { module?: string; version?: string };
        const module = String(b.module ?? '').trim();
        if (!module) return reply.code(400).send({ error: '缺少 module' });
        const version = String(b.version ?? '').trim() || undefined;

        const t = targetFor(ctx, id);
        if ('error' in t) return reply.code(t.code).send({ error: t.error });

        try {
          const r = await installModule(t, module, version);
          recordAudit(db, {
            actor: user.username, action: 'install-node', target: `${id}/${r.module}@${r.version}`,
            result: 'ok', detail: r.types.join(', '),
          });
          return reply.send(r);
        } catch (e) {
          recordAudit(db, {
            actor: user.username, action: 'install-node', target: `${id}/${module}`,
            result: 'fail', detail: (e as Error).message,
          });
          if (e instanceof AdminApiError) {
            // 实例说不行是 400（配置问题，现场能改）；连不上实例是 502（不是现场的错）
            return reply.code(e.status >= 400 && e.status < 500 ? 400 : 502)
              .send({ error: e.message });
          }
          return fail(reply, e);
        }
      });
    } catch (e) {
      return ctx.fail(reply, e);
    }
  });

  api.get(`${config.basePath}/api/nodes/inventory/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: id })) return;
    const t = targetFor(ctx, id);
    if ('error' in t) return reply.code(t.code).send({ error: t.error });
    return reply.send(inventoryEvidence(await inventoryOf(id, t, catalog.names())));
  });

  // ── 平台节点包迁移 ──────────────────────────────────
  //
  // 迁移是唯一会从 legacy raw nodes 切到受信任 npm 平台包的动作。搜索、批准、
  // 缓存与台账刷新都不能触发它；同一服务内部持有 operation gate 与事务幂等性。

  api.get(`${config.basePath}/api/instances/:id/nodes/thinglinks-migration`, async (req, reply) => {
    const id = migrationInstanceId(req, reply);
    if (!id) return;
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: id })) return;
    try {
      return reply.send(migrationService.status(id));
    } catch (error) {
      // 不存在是受控的 preflight；其余底层故障不能伪装成 404，也不能回显文本。
      if (error instanceof PlatformMigrationError) {
        return reply.code(404).send({ error: '实例不存在' });
      }
      return reply.code(500).send({ error: '迁移状态读取失败，请稍后重试' });
    }
  });

  api.post(`${config.basePath}/api/instances/:id/nodes/thinglinks-migration`, async (req, reply) => {
    const id = migrationInstanceId(req, reply);
    if (!id) return;
    const user = guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;
    try {
      // migrate() 已在 active/existing transaction 时返回当前状态，不能再套一层 gate。
      return reply.send(await migrationService.migrate(id, user.username));
    } catch (error) {
      if (error instanceof PlatformMigrationError) {
        return reply.code(409).send({
          error: migrationErrorSummary[error.code], code: error.code,
        });
      }
      return reply.code(500).send({ error: '迁移请求未完成，请刷新状态后重试' });
    }
  });
}
