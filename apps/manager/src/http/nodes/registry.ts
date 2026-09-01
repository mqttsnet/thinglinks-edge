/**
 * 私有 npm 源的只读端点（01 号文 5.7「内置私有 npm registry」）。
 *
 * 服务两类完全不同的客户端，**它们看到的地址不一样**，这是本文件最容易搞错的地方：
 *
 *   · 实例容器里的 **npm**  → `http://<manager 容器名>:19100<basePath>/npm/`
 *     由 NPM_CONFIG_REGISTRY 注入（见 core/nodes/policy.ts）
 *   · 现场浏览器里的**编辑器前端** → `<basePath>/npm/-/catalogue.json`
 *     由实例 settings.js 的 editorTheme.palette.catalogues 注入
 *
 * 编辑器是 Manager 反代出去的，所以对浏览器而言两者同源，catalogue 用相对路径即可；
 * 而 npm 在容器里，只能靠 docker 网络的容器名解析。把其中一个填成另一个的地址，
 * 症状分别是「面板一直转圈」和「装包报连不上」——两次都指不到根因。
 *
 * ## 为什么不鉴权
 *
 * npm 取包时的鉴权只能靠 .npmrc 里的 `_authToken`，而**装包前那次
 * `npm info` 读不到实例的 .npmrc**（cwd 不是 /data，见 policy.ts 的实测）。
 * 也就是说加了鉴权，恰恰是开启白名单之后的版本预检会 401 —— 又一个
 * 「配得越严越用不了」的陷阱。
 *
 * 权衡后放开只读：这里的内容是**已批准的公开 npm 包**，不含任何机密；
 * 能访问到它的前提是已经在 Manager 的网络里（宿主端口默认只发布到回环）。
 * 写入口（导入包、改批准清单）在 ./catalog.ts，全部要 node:manage。
 */
import type { FastifyInstance } from 'fastify';
import { buildPackument, buildCatalogue } from '../../core/nodes/packument.ts';
import { assertModuleName } from '../../core/nodes/policy.ts';
import type { NodeStore } from '../../core/nodes/store.ts';
import type { NodeCatalog } from '../../core/nodes/catalog.ts';
import { tarballUrl } from '../../core/nodes/packument.ts';
import type { UpstreamRegistry } from '../../core/nodes/upstream.ts';
import { recordAudit } from '../../core/db.ts';
import type { HttpContext } from '../context.ts';
import {
  isPlatformPackageName,
  type PlatformRegistryVerifier,
  type VerifiedPlatformPackage,
} from '../../core/nodes/platform-package.ts';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from '../../core/nodes/platform-contract.ts';

export interface RegistryDeps {
  store: NodeStore;
  catalog: NodeCatalog;
  /** npm 视角的源地址，用于生成 packument 里的 tarball URL */
  internalBase: string;
  /**
   * 上游回源。留空或未启用时，库里没有的包一律 404（纯离线现场就是这个形态）。
   * 启用后库里没有的包会转发上游并**在取包体时入库**，之后即离线可用。
   */
  upstream?: UpstreamRegistry | undefined;
  /**
   * Task 3 从启动装配注入同一个 PlatformPackageService 单例。过渡期留空时，
   * 固定包请求必须失败关闭，绝不能退回未经校验的通用 store 路径。
   */
  platformPackages?: PlatformRegistryVerifier | undefined;
}

function platformPin(name: string) {
  if (name === PLATFORM_NODE_PACKAGE.name) return PLATFORM_NODE_PACKAGE;
  if (name === PLATFORM_COMMON_PACKAGE.name) return PLATFORM_COMMON_PACKAGE;
  return undefined;
}

function buildPlatformPackument(snapshot: VerifiedPlatformPackage, base: string) {
  const { meta } = snapshot;
  return {
    _id: meta.name,
    name: meta.name,
    description: meta.description,
    'dist-tags': { latest: meta.version },
    versions: {
      [meta.version]: {
        name: meta.name,
        version: meta.version,
        description: meta.description,
        keywords: meta.keywords,
        dependencies: meta.dependencies,
        optionalDependencies: meta.optionalDependencies,
        peerDependencies: meta.peerDependencies,
        peerDependenciesMeta: meta.peerDependenciesMeta,
        engines: meta.engines,
        dist: {
          tarball: tarballUrl(base, meta.name, meta.version),
          shasum: meta.shasum,
          integrity: meta.integrity,
        },
      },
    },
    time: { [meta.version]: meta.updatedAt },
  };
}

/**
 * 从 `/npm/` 之后的路径里解出包名与可选的 tarball 文件名。
 *
 * 要处理的形状：
 *
 *     node-red-contrib-modbus                     普通包
 *     @scope/pkg  或  @scope%2fpkg                 带 scope（npm 两种写法都会发）
 *     node-red-contrib-modbus/-/xxx-5.7.0.tgz     包体下载
 */
export function parseNpmPath(rest: string):
  { module: string; tarball?: string } | undefined {
  const path = decodeURIComponent(rest.replace(/^\/+/, ''));
  if (path === '') return undefined;

  const marker = path.indexOf('/-/');
  if (marker >= 0) {
    const module = path.slice(0, marker);
    const tarball = path.slice(marker + 3);
    // 文件名里出现路径分隔符一律拒绝：它只该是个纯文件名
    if (tarball === '' || tarball.includes('/')) return undefined;
    return { module, tarball };
  }
  return { module: path };
}

/**
 * 从 tarball 文件名里取版本。
 *
 * 文件名形如 `<basename>-<version>.tgz`，而 basename 自己也含连字符，
 * 所以从**右边**找最后一个连字符 —— 版本号里不会有连字符之外的分隔，
 * 有预发布标记时（1.0.0-beta.1）才会，那种情况下按包名长度切更可靠。
 */
export function versionFromTarball(module: string, file: string): string | undefined {
  if (!file.endsWith('.tgz')) return undefined;
  const base = module.split('/').pop() ?? module;
  const stem = file.slice(0, -4);
  if (!stem.startsWith(`${base}-`)) return undefined;
  const version = stem.slice(base.length + 1);
  return version === '' ? undefined : version;
}

export function registerNpmRegistry(
  api: FastifyInstance, ctx: HttpContext, deps: RegistryDeps,
): void {
  const { config } = ctx;
  const { store, catalog, internalBase, upstream, platformPackages } = deps;

  /**
   * 编辑器节点目录。
   *
   * 路径放在 `/-/` 下：npm 的包名不允许以 `-` 开头，所以这个前缀
   * 永远不会和某个真实包撞上。
   */
  api.get(`${config.basePath}/npm/-/catalogue.json`, async (_req, reply) =>
    reply
      // 编辑器每次打开面板都会带缓存破坏参数重取，明确禁缓存免得中间层自作主张
      .header('cache-control', 'no-store')
      .send(buildCatalogue(store, {
        name: 'ThingLinks Edge Community catalogue',
        approved: catalog.names(),
      })));

  /**
   * packument 与包体。
   *
   * 用通配路由而不是 `:module` 参数，因为包名可能自带一层 `@scope/`，
   * 而 Fastify 的具名参数不跨斜杠。
   */
  api.get(`${config.basePath}/npm/*`, async (req, reply) => {
    const rest = (req.params as { '*': string })['*'] ?? '';
    const parsed = parseNpmPath(rest);
    if (!parsed) return reply.code(404).send({ error: 'not found' });

    try {
      assertModuleName(parsed.module);
    } catch {
      // 包名非法一律回 404 而不是 400：npm 对 404 有明确处理，
      // 对 400 会打出一大段无关的排障建议
      return reply.code(404).send({ error: 'not found' });
    }

    /*
     * 官方包名永远先进入固定信任边界。即使 store 里有人塞了同名其它版本，
     * 也不能通过通用 packument 暴露出去。
     */
    if (isPlatformPackageName(parsed.module)) {
      const pin = platformPin(parsed.module)!;
      if (!platformPackages) {
        return reply.code(503).send({ error: 'platform package verifier unavailable' });
      }
      if (parsed.tarball !== undefined) {
        const version = versionFromTarball(parsed.module, parsed.tarball);
        if (version !== pin.version) return reply.code(404).send({ error: 'not found' });
        try {
          const snapshot = platformPackages.snapshotForRegistry(pin.name, pin.version);
          if (!snapshot) return reply.code(404).send({ error: 'not found' });
          return reply
            .header('content-type', 'application/octet-stream')
            .header('content-length', String(snapshot.buffer.length))
            .send(snapshot.buffer);
        } catch (e) {
          req.log.warn(`[npm] 平台包校验失败 ${pin.name}@${pin.version}：${(e as Error).message}`);
          return reply.code(503).send({ error: 'platform package verification failed' });
        }
      }
      try {
        const snapshot = platformPackages.snapshotForRegistry(pin.name, pin.version);
        if (!snapshot) return reply.code(404).send({ error: 'not found' });
        return reply.header('cache-control', 'no-store')
          .send(buildPlatformPackument(snapshot, internalBase));
      } catch (e) {
        req.log.warn(`[npm] 平台包校验失败 ${pin.name}@${pin.version}：${(e as Error).message}`);
        return reply.code(503).send({ error: 'platform package verification failed' });
      }
    }

    if (parsed.tarball !== undefined) {
      const version = versionFromTarball(parsed.module, parsed.tarball);
      let body = version ? store.tarball(parsed.module, version) : undefined;

      /*
       * 库里没有就回源下载，**下完入库**。
       *
       * 入库只发生在这里、不发生在 packument 那条分支：Node-RED 校验白名单
       * **之前**会先 `npm info` 一次，那次会问到未批准的包；按包体入库才能保证
       * 库里留下的都是真正装过的东西。详见 core/nodes/upstream.ts 文件头。
       */
      if (!body && version && upstream?.enabled) {
        try {
          const fetched = await upstream.tarball(parsed.module, version);
          if (fetched) {
            const meta = store.add(fetched);        // add 内部会再解析一次并校验形状
            body = fetched;
            recordAudit(ctx.db, {
              actor: 'system', action: 'cache-node-package',
              target: `${meta.name}@${meta.version}`,
              detail: `自上游源下载并入库（${upstream.urls.join(' / ')}）`, result: 'ok',
            });
          }
        } catch (e) {
          // 回源失败要留痕：现场看到的只是「装不上」，得有地方查到底是网络还是校验
          recordAudit(ctx.db, {
            actor: 'system', action: 'cache-node-package',
            target: `${parsed.module}@${version}`,
            detail: (e as Error).message, result: 'fail',
          });
          req.log.warn(`[npm] 回源失败 ${parsed.module}@${version}：${(e as Error).message}`);
        }
      }

      if (!body) return reply.code(404).send({ error: 'not found' });
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(body.length))
        .send(body);
    }

    const local = buildPackument(store, parsed.module, internalBase);
    if (local) return reply.header('cache-control', 'no-store').send(local);

    /*
     * 库里没有 → 回源取 packument。**不入库**（见上面包体分支的说明）。
     *
     * 关键一步是把每个版本的 `dist.tarball` 改写成指向我们自己 ——
     * 不改写的话 npm 会直接去上游下载，包体永远不会经过我们，
     * 也就永远进不了本地库，「装过一次之后离线可用」这件事就不成立了。
     */
    if (upstream?.enabled) {
      try {
        const up = await upstream.packument(parsed.module);
        if (up) {
          const versions: Record<string, unknown> = {};
          for (const [v, manifest] of Object.entries(up.versions ?? {})) {
            versions[v] = {
              ...manifest,
              dist: {
                ...(manifest.dist ?? {}),
                tarball: tarballUrl(internalBase, parsed.module, v),
              },
            };
          }
          return reply.header('cache-control', 'no-store').send({ ...up, versions });
        }
      } catch (e) {
        req.log.warn(`[npm] 上游 packument 失败 ${parsed.module}：${(e as Error).message}`);
        /*
         * 回源出错时回 502 而不是 404：404 会让 Node-RED 报「模块不存在」，
         * 而真实原因是上游连不上 —— 现场会照着「是不是名字打错了」查半天。
         */
        return reply.code(502).send({ error: `上游源不可用：${(e as Error).message}` });
      }
    }

    const doc = local;
    if (!doc) {
      /*
       * npm 把「404 且响应体带 error 字段」认成「这个包不存在」，
       * 从而给出 E404 —— 那正是我们要的语义（Node-RED 会把它翻成
       * 「Module not found」）。回空体的话 npm 会报解析失败，
       * 现场看到的是一句莫名其妙的 JSON 错误。
       */
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.header('cache-control', 'no-store').send(doc);
  });
}
