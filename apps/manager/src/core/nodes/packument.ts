/**
 * 把本地 tgz 库渲染成 npm 客户端认得的两种文档。
 *
 * **为什么自己实现而不是跑一个 verdaccio 兄弟容器**：
 *
 *   · 实例各在自己的 docker 网络里（见 docker-client 的 ensureNetwork），
 *     Manager 已经被接进每一张网 —— 由它兼任私有源，网络上零成本；
 *     换成独立容器就要给每张实例网都接一次，多一处会漂移的编排
 *   · 离线包少一个镜像（verdaccio 镜像上百 MB，而现场是拷 U 盘进去的）
 *   · 私有源只服务**已批准**的包，本身就是白名单的第二道闸 ——
 *     即使实例侧配置被改坏，源里也没有别的东西可给
 *
 * 代价是只实现了只读的那一小块协议（packument + tarball 下载）。
 * 发布、登录、搜索一律没有 —— 这个源不接受写入，写入口是管理台的导入。
 *
 * npm 装包只需要这两个请求，实测覆盖：
 *
 *     GET /<module>                      → packument
 *     GET /<module>/-/<file>.tgz         → 包体
 */
import type { NodeStore, PackageMeta } from './store.ts';

/** packument 里的单版本清单。字段名是 npm 协议规定的，不能改 */
interface VersionManifest {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  engines: Record<string, string>;
  dist: { tarball: string; shasum: string; integrity: string };
}

/**
 * 这条依赖声明是不是**指向注册表之外**的东西。
 *
 * ## 为什么要管这个（实测，别照直觉改）
 *
 * `node-red-contrib-modbus@5.60.2` 是这样声明依赖的：
 *
 *     "@openp4nr/modbus-serial":
 *       "https://dl.cloudsmith.io/public/.../openp4nr-modbus-serial-8.4.0.tgz"
 *
 * 也就是说这条依赖**根本不经过 registry** —— npm 拿到 packument 后会直接去
 * 那个 URL 下载。实测：把包和它的这个依赖都放进私有库，再从私有源装，
 * npm 仍然去连 cloudsmith，离线现场报 `ECONNRESET ... failed, reason:
 * Client network socket disconnected`。私有源在这条路径上完全被绕开了。
 *
 * 这不是个别现象：工业节点包为了发私有构建，用 URL 依赖的不少。而症状
 * （「包明明在源里，装的时候却去连一个没听说过的域名」）根本指不到根因。
 *
 * 所以生成 packument 时要把这类声明改写成普通版本号 —— 见 resolveDeps。
 *
 * ## 判定规则
 *
 * 语义化版本范围里**不可能出现斜杠**，所以「带协议前缀」或「含斜杠」
 * 就是非注册表声明。唯一的例外是 `npm:` 别名（`npm:@scope/pkg@^1`），
 * 它仍然走 registry，要原样留着。
 */
export function isNonRegistrySpec(spec: string): boolean {
  const s = spec.trim();
  if (s === '') return false;
  if (s.startsWith('npm:')) return false;
  if (/^(?:https?|git(?:\+[a-z]+)?|file|link|portal):/i.test(s)) return true;
  if (/^git@/i.test(s)) return true;
  if (/^(?:github|gitlab|bitbucket|gist):/i.test(s)) return true;
  // `owner/repo` 与 `owner/repo#semver:^1.2.3` 的 GitHub 简写
  return s.includes('/');
}

/**
 * tarball URL 末尾的版本号，取不出来返回 undefined。
 *
 * npm 发布的包体文件名固定是 `<名字>-<版本>.tgz`，所以 URL 自己就写着
 * 它要的是哪一版。**能取到就用它**，而不是一律取库里最新的 ——
 * 库里同时存着一个包的多个版本是常态（不同节点包各要一版），
 * 那时候「最新」多半不是这条依赖想要的那一版。
 */
function versionInTarballUrl(spec: string): string | undefined {
  const file = spec.split('?')[0]?.split('#')[0]?.split('/').pop() ?? '';
  return /-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.tgz$/.exec(file)?.[1];
}

/**
 * 把依赖声明改写成私有源里真实存在的版本。
 *
 * 只动**非注册表声明**，而且只在库里确实有那个包时才动；
 * 库里没有就原样留着 —— 那种情况下改写只会把「去连外网失败」
 * 换成「解析不到版本」，同样装不上，却更难看出是缺包。
 * 缺的那一个会由 closureReport 报成缺口，那才是该看的地方。
 *
 * 钉成**确切版本**而不是范围：库里有什么就是什么，不给 npm 留下
 * 「这个范围我在别处也许能找到更新的」的余地。
 */
function resolveDeps(
  store: NodeStore, deps: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (!isNonRegistrySpec(spec)) {
      out[name] = spec;
      continue;
    }
    let picked: string | undefined;
    try {
      const have = store.versions(name);
      // URL 里写明的那一版优先；库里没有那一版才退回最新的
      const wanted = versionInTarballUrl(spec);
      picked = (wanted !== undefined && have.includes(wanted))
        ? wanted
        : have[have.length - 1];
    } catch {
      // 依赖名不合法（过不了 assertModuleName）—— 当作库里没有
      picked = undefined;
    }
    out[name] = picked ?? spec;
  }
  return out;
}

export interface Packument {
  _id: string;
  name: string;
  description: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, VersionManifest>;
  time: Record<string, string>;
}

/**
 * 包体下载地址。
 *
 * 走 `<base>/<module>/-/<basename>-<version>.tgz` 这个 npm 惯用形状，
 * 而不是随便编一个 —— npm 会把 tarball URL 原样拿去下载，形状本身不重要，
 * 但保持惯例能让 `npm view` 之类的输出看起来正常，排障时少一层疑惑。
 */
export function tarballUrl(base: string, module: string, version: string): string {
  const file = `${module.split('/').pop() ?? module}-${version}.tgz`;
  return `${base.replace(/\/$/, '')}/${module}/-/${file}`;
}

function manifest(store: NodeStore, meta: PackageMeta, base: string): VersionManifest {
  return {
    name: meta.name,
    version: meta.version,
    description: meta.description,
    keywords: meta.keywords,
    dependencies: resolveDeps(store, meta.dependencies),
    /*
     * 可选依赖**必须原样带上**。漏了它 npm 不会报错、包照样装上，
     * 只是那部分功能静悄悄地缺席 —— node-red-contrib-modbus 的串口（RTU）
     * 支持就在 optionalDependencies 里（serialport / @serialport/list）。
     */
    optionalDependencies: resolveDeps(store, meta.optionalDependencies),
    peerDependencies: meta.peerDependencies,
    // 少了它，本来标着 optional 的 peer 会被 npm 当成硬依赖去装
    peerDependenciesMeta: meta.peerDependenciesMeta,
    engines: meta.engines,
    dist: {
      tarball: tarballUrl(base, meta.name, meta.version),
      shasum: meta.shasum,
      integrity: meta.integrity,
    },
  };
}

/**
 * 生成某个包的 packument。库里没有这个包时返回 undefined（调用方回 404）。
 *
 * `base` 必须是**实例容器视角**能访问到的地址，因为拿它去下载的是
 * 容器里的 npm，不是浏览器。两者的可达地址不同 —— 见 http/nodes/registry.ts。
 */
export function buildPackument(
  store: NodeStore, module: string, base: string,
): Packument | undefined {
  const versions = store.versions(module);
  if (versions.length === 0) return undefined;

  const out: Record<string, VersionManifest> = {};
  const time: Record<string, string> = {};
  let description = '';
  for (const v of versions) {
    const meta = store.meta(module, v);
    if (!meta) continue;
    out[v] = manifest(store, meta, base);
    time[v] = meta.updatedAt;
    description = meta.description || description;
  }
  const latest = versions[versions.length - 1];
  if (latest === undefined) return undefined;

  return {
    _id: module,
    name: module,
    description,
    /*
     * 只给 latest。npm info 不带版本时读的就是它（installer.js 的
     * getModuleVersionFromNPM 直接取返回体的 .version）。
     * 多余的 tag（next/beta）在这个场景里没有意义，还会让人以为能选。
     */
    'dist-tags': { latest },
    versions: out,
    time,
  };
}

/** Node-RED 编辑器节点管理面板读的目录格式 */
export interface Catalogue {
  name: string;
  updated_at: string;
  modules: Array<{
    id: string;
    version: string;
    description: string;
    keywords: string[];
    types: string[];
    updated_at: string;
  }>;
}

/**
 * 生成编辑器用的节点目录。
 *
 * **只列节点包**：库里同时存着它们的依赖（普通 npm 库），
 * 那些东西列进目录只会让现场在一堆看不懂的名字里找自己要的那个。
 *
 * 注意编辑器前端**自己也会**拿 allowList/denyList 再过滤一遍这份目录
 * （red.js 的 handleCatalogResponse）。所以目录里出现未批准的包并不会
 * 让它可安装，但会显示成灰的 —— 干脆不列。
 */
export function buildCatalogue(
  store: NodeStore, opts: { name: string; approved?: ReadonlySet<string> | undefined },
): Catalogue {
  const modules: Catalogue['modules'] = [];
  for (const m of store.modules()) {
    if (opts.approved && !opts.approved.has(m)) continue;
    const versions = store.versions(m);
    const latest = versions[versions.length - 1];
    if (latest === undefined) continue;
    const meta = store.meta(m, latest);
    if (!meta || !meta.isNodeRedNode) continue;
    modules.push({
      id: meta.name,
      version: meta.version,
      description: meta.description,
      keywords: meta.keywords,
      types: meta.types,
      updated_at: meta.updatedAt,
    });
  }
  return { name: opts.name, updated_at: new Date().toISOString(), modules };
}
