/**
 * 私有源的上游回源（01 号文 5.7）。
 *
 * 库里没有的包，转发到上游 registry 取，**下载后顺手存进本地库**。
 * 于是：第一次装要联网，之后这个包就永久离线可用了。
 *
 * ## 为什么要有这个
 *
 * 早先私有源是纯本地的：库里没有就 404，不回落公网。那对离线现场是对的，
 * 但它把「有外网的现场」也一起挡住了 —— 想装个 modbus 得先在另一台机器上
 * `npm pack` 再拷进来。绝大多数客户是有网的，不该为离线场景付这个代价。
 *
 * ## 缓存的两条规则
 *
 * 1. **只在取包体时入库，取 packument 时不入库。**
 *    Node-RED 在校验白名单**之前**会先跑一次 `npm info`（见 policy.ts 文件头），
 *    那次请求会问到**未批准**的包。若那时就缓存，库里会堆满没人批准过的东西，
 *    「源里只有批准过的包」这条性质就没了。包体只在真正 `npm install` 时才取，
 *    而那已经过了白名单 —— 所以按包体入库，库里留下的就是真正装过的。
 * 2. **入库前校验 integrity。** 上游给的 packument 里带 `dist.integrity`，
 *    下完当场比对。不比对的话，一次坏掉的下载会把错误内容永久钉进本地库，
 *    而之后所有实例都从本地库取 —— 一次网络抖动污染整个现场。
 *
 * ## 出网
 *
 * 走 Node 24 的内置代理开关（镜像里已设 `NODE_USE_ENV_PROXY=1`），
 * 所以企业代理现场只要配了 `EDGE_HTTP_PROXY` 就自动生效，这里不必自己处理。
 */
import { createHash } from 'node:crypto';
import { NodePolicyError, assertModuleName } from './policy.ts';

/** packument 里我们关心的那部分 */
export interface UpstreamPackument {
  name: string;
  'dist-tags'?: Record<string, string>;
  versions: Record<string, {
    name?: string; version?: string;
    dist?: { tarball?: string; integrity?: string; shasum?: string };
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface UpstreamOptions {
  /**
   * 当前启用的源，**传函数不传数组** —— 源在页面上随时可增删，
   * 传数组会让进程一直用着启动那一刻的清单，且没有任何症状。
   */
  sources: () => Array<{ name: string; url: string }>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 搜索结果的一条 */
export interface SearchHit {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  /** 最近发布时间，ISO 串 */
  date: string;
  /** 来自哪个源，界面上要显示 —— 多源时人得知道这个包是哪来的 */
  source: string;
}

/**
 * packument 的短期内存缓存。
 *
 * 一次安装里同一个包的 packument 会被问到两次（`npm info` 预检一次、
 * `npm install` 解析依赖一次），取包体时为了校验 integrity 还要再问一次。
 * 缓存几十秒能把三次变一次，对慢速链路的现场差别很大。
 *
 * **刻意只放内存、TTL 很短**：包的新版本随时会发，缓存久了会让
 * 「装最新版」装到旧的，而那种错极难查。
 */
const PACKUMENT_TTL_MS = 30_000;

function isExactModuleQuery(value: string): boolean {
  try {
    assertModuleName(value);
    return true;
  } catch {
    return false;
  }
}

function hitFromPackument(doc: UpstreamPackument, source: string): SearchHit | undefined {
  const version = doc['dist-tags']?.latest;
  const manifest = version ? doc.versions[version] : undefined;
  const nodeRed = manifest?.['node-red'];
  if (!manifest || !nodeRed || typeof nodeRed !== 'object' || !('nodes' in nodeRed)) return undefined;

  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
    : [];
  const time = (doc.time ?? {}) as Record<string, string>;
  return {
    name: typeof manifest.name === 'string' ? manifest.name : doc.name,
    version: typeof manifest.version === 'string' ? manifest.version : version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    keywords,
    date: time[version] ?? '',
    source,
  };
}

function isNodeRedSearchPackage(pkg: {
  keywords?: string[];
  name?: string;
  description?: string;
}): boolean {
  return pkg.keywords?.some((keyword) => keyword.toLowerCase() === 'node-red') ?? false;
}

function matchesSearchTerms(hit: SearchHit, query: string): boolean {
  const searchable = [hit.name, hit.description, ...hit.keywords].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).every((term) => searchable.includes(term));
}

export class UpstreamRegistry {
  #sources: () => Array<{ name: string; url: string }>;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #cache = new Map<string, { at: number; doc: UpstreamPackument }>();

  constructor(o: UpstreamOptions) {
    this.#sources = o.sources;
    this.#timeoutMs = o.timeoutMs ?? 20_000;
    this.#fetch = o.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return this.#sources().length > 0;
  }

  /** 当前源清单，供日志与界面显示 */
  get urls(): string[] {
    return this.#sources().map((s) => s.url);
  }

  async #get(url: string): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 在所有启用的源里搜索节点包，精确包名优先于模糊结果。 */
  async search(text: string, size = 20): Promise<SearchHit[]> {
    const q = text.trim();
    if (!q) return [];

    if (isExactModuleQuery(q)) {
      const errors: string[] = [];
      const path = encodeURIComponent(q);
      for (const src of this.#sources()) {
        try {
          const res = await this.#get(`${src.url}/${path}`);
          if (res.status === 404) continue;
          if (!res.ok) {
            errors.push(`${src.name}: HTTP ${res.status}`);
            continue;
          }
          const doc = await res.json() as UpstreamPackument;
          const latest = doc['dist-tags']?.latest;
          const manifestName = latest ? doc.versions[latest]?.name : undefined;
          if (doc.name !== q || (manifestName !== undefined && manifestName !== q)) {
            errors.push(`${src.name}: 包名不匹配（请求 ${q}，返回 ${doc.name}）`);
            continue;
          }
          const hit = hitFromPackument(doc, src.name);
          return hit ? [hit] : [];
        } catch (e) {
          errors.push(`${src.name}: ${(e as Error).message}`);
        }
      }
      // 只有所有源都明确说不存在，才允许继续向模糊搜索回退。
      if (errors.length > 0) {
        throw new NodePolicyError(`所有节点源都取不到 ${q}：${errors.join('；')}`);
      }
    }

    const seen = new Map<string, SearchHit>();
    for (const src of this.#sources()) {
      try {
        const url = `${src.url}/-/v1/search?text=${encodeURIComponent(q)}`
          + `&size=${Math.min(Math.max(size, 1), 50)}`;
        const res = await this.#get(url);
        if (!res.ok) continue;
        const body = await res.json() as {
          objects?: Array<{ package?: {
            name?: string; version?: string; description?: string;
            keywords?: string[]; date?: string;
          } }>;
        };
        for (const o of body.objects ?? []) {
          const p = o.package;
          if (!p?.name || !p.version || !isNodeRedSearchPackage(p)) continue;
          // 先到的源优先：多个源有同名包时，按源的排列顺序取第一个
          if (seen.has(p.name)) continue;
          const hit: SearchHit = {
            name: p.name, version: p.version,
            description: p.description ?? '',
            keywords: p.keywords ?? [], date: p.date ?? '',
            source: src.name,
          };
          if (!matchesSearchTerms(hit, q)) continue;
          seen.set(p.name, hit);
        }
      } catch { /* 这个源不通就跳过，别让它拖垮整次搜索 */ }
    }
    return [...seen.values()];
  }

  /**
   * 取上游 packument。上游没有这个包时返回 undefined（由调用方回 404）。
   *
   * 网络故障**抛错**而不是返回 undefined —— 两者对现场是完全不同的事：
   * 前者是「上游连不上，检查网络或代理」，后者是「这个包不存在，名字打错了」。
   * 混成一个，现场会照着错误的方向查半天。
   */
  async packument(module: string): Promise<UpstreamPackument | undefined> {
    assertModuleName(module);
    const hit = this.#cache.get(module);
    if (hit && Date.now() - hit.at < PACKUMENT_TTL_MS) return hit.doc;

    // scope 包的 packument 路径要把斜杠编码，这是 npm registry 的约定
    const path = encodeURIComponent(module);
    const errors: string[] = [];
    for (const src of this.#sources()) {
      let res: Response;
      try {
        res = await this.#get(`${src.url}/${path}`);
      } catch (e) {
        errors.push(`${src.name}: ${(e as Error).message}`);
        continue;
      }
      if (res.status === 404) continue;            // 这个源没有，问下一个
      if (!res.ok) { errors.push(`${src.name}: HTTP ${res.status}`); continue; }
      const doc = await res.json() as UpstreamPackument;
      this.#cache.set(module, { at: Date.now(), doc });
      return doc;
    }
    /*
     * 全部源都 404 → 这个包确实不存在，回 undefined。
     * 但只要有源是**连不上**，就抛错 —— 两者对现场是完全不同的事：
     * 一个查网络，一个查名字拼写。混成一个会让人照错方向查半天。
     */
    if (errors.length > 0) {
      throw new NodePolicyError(`所有节点源都取不到 ${module}：${errors.join('；')}`);
    }
    return undefined;
  }

  /**
   * 取某个版本的包体，并校验 integrity。
   *
   * 返回 undefined 表示上游没有这个包或这个版本。
   */
  /** 某个包的全部版本，新的在前。界面上的版本下拉直接用它 */
  async versions(module: string): Promise<Array<{ version: string; date: string }>> {
    const doc = await this.packument(module);
    if (!doc) return [];
    const time = (doc['time'] ?? {}) as Record<string, string>;
    return Object.keys(doc.versions ?? {})
      .map((v) => ({ version: v, date: time[v] ?? '' }))
      .reverse();
  }

  async tarball(module: string, version: string): Promise<Buffer | undefined> {
    const doc = await this.packument(module);
    const manifest = doc?.versions?.[version];
    if (!manifest) return undefined;

    const url = manifest.dist?.tarball;
    if (!url) throw new NodePolicyError(`上游 packument 里 ${module}@${version} 没有包体地址`);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, { signal: ac.signal });
    } catch (e) {
      throw new NodePolicyError(`下载 ${module}@${version} 失败：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return undefined;
    if (!res.ok) throw new NodePolicyError(`下载 ${module}@${version} 返回 HTTP ${res.status}`);

    const body = Buffer.from(await res.arrayBuffer());
    assertIntegrity(module, version, body, manifest.dist?.integrity, manifest.dist?.shasum);
    return body;
  }
}

/**
 * 比对上游声明的校验值。
 *
 * 上游没给校验值时**放行**并不理想，但拒绝更糟：少数私有 registry 确实不返回
 * integrity，一律拒会让那些现场彻底装不上。给了就必须对得上。
 */
export function assertIntegrity(
  module: string, version: string, body: Buffer,
  integrity?: string | undefined, shasum?: string | undefined,
): void {
  if (integrity) {
    // integrity 形如 `sha512-<base64>`，也可能是空格分隔的多条，取第一条能认的
    for (const entry of integrity.split(/\s+/)) {
      const m = /^(sha1|sha256|sha512)-(.+)$/.exec(entry);
      if (!m) continue;
      const got = createHash(m[1]!).update(body).digest('base64');
      if (got !== m[2]) {
        throw new NodePolicyError(
          `${module}@${version} 校验失败：上游声明 ${entry.slice(0, 24)}…，`
          + `实际算出 ${m[1]}-${got.slice(0, 16)}…。包体在传输中损坏或被篡改，已拒绝入库`,
        );
      }
      return;
    }
  }
  if (shasum) {
    const got = createHash('sha1').update(body).digest('hex');
    if (got !== shasum) {
      throw new NodePolicyError(
        `${module}@${version} 校验失败：上游声明 shasum ${shasum}，实际 ${got}。已拒绝入库`,
      );
    }
  }
}
