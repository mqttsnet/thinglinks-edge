/**
 * 私有 npm 源的磁盘存储（01 号文 5.7「离线场景下节点可用」）。
 *
 * 存的就是 `npm pack` 出来的原始 .tgz，不做任何转换 —— 离线现场拿到的
 * 就是这种文件，多一层格式转换就多一处「导入时看着成功、安装时报错」的可能。
 *
 * 目录形如：
 *
 *     <dataDir>/npm/node-red-contrib-modbus/5.7.0.tgz
 *     <dataDir>/npm/@scope/pkg/1.0.0.tgz
 *
 * 元数据不落库，每次从 tgz 现读。理由是**它们必须永远一致**：
 * 库里记 1.2.3、盘上其实是 1.2.4 的话，npm 会在下载完成后校验失败，
 * 而那个错误信息（integrity mismatch）完全指不到根因。现读虽然慢一点，
 * 但源头只有一个，不存在对不上的可能。节点包总共也就几十个，慢不到哪去。
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync }
  from 'node:fs';
import { join, dirname } from 'node:path';
import { untar } from '../archive/tar.ts';
import { assertModuleName, NodePolicyError } from './policy.ts';

/** 从 tgz 里读出来的包元数据 */
export interface PackageMeta {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  /**
   * package.json 的 `node-red.nodes` 键名 —— 这个包提供的节点类型。
   * 非节点包（节点包的依赖）为空数组。
   */
  types: string[];
  /** 有 `node-red.nodes` 才算节点包；它的依赖们没有这个键 */
  isNodeRedNode: boolean;
  /** 运行期依赖，原样透传进 packument —— npm 靠它解析依赖闭包 */
  dependencies: Record<string, string>;
  /**
   * 可选依赖。**必须带上**，哪怕它「可选」：
   * node-red-contrib-modbus 把 serialport 与 @serialport/list 放在这里，
   * 丢了它们包照样装得上、Modbus TCP 也照常能用 —— 但**串口（RTU）静悄悄地没了**。
   * 这种「装成功了但少一半功能」的故障在现场最难查。
   */
  optionalDependencies: Record<string, string>;
  /** 同上。装 Node-RED 节点时 peer 依赖经常指向 node-red 本身 */
  peerDependencies: Record<string, string>;
  /** 哪些 peer 是可选的。缺了它，npm 会把本可跳过的 peer 当成硬依赖去装 */
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  /** package.json 的 engines，npm 的 --engine-strict 会看 */
  engines: Record<string, string>;
  /** 文件字节数 */
  size: number;
  /** sha1，十六进制。npm 老字段，仍在用 */
  shasum: string;
  /** SRI 形式的 sha512，npm 现在校验的是这个 */
  integrity: string;
  /** 文件修改时间，用于 catalogue 的 updated_at */
  updatedAt: string;
}

/**
 * 从 tar 条目里挑出包自己的 package.json。
 *
 * **不能写死 `package/package.json`**（曾经就是这么写的，被真包打脸）：
 * npm 的实际行为是**剥掉第一层目录，不管它叫什么**。`npm pack` 产出的确实是
 * `package/`，但从 registry 直接下载的已发布包不一定 —— 实测 DefinitelyTyped 的
 * `@types/semver@7.7.1` 根目录是 `semver/`，`@types/node` 等 13 个包同理。
 * 写死前缀的表现是这些包一律被判成「不像 npm pack 出来的文件」，
 * 于是依赖闭包缺一块，而缺口要到现场点安装时才暴露。
 *
 * 仍然只认**第一层**下的 package.json，不是任意路径下的同名文件 ——
 * 一个包里完全可能有 `xxx/test/fixtures/package.json`。
 * 有多个候选时优先 `package/`，那是规范写法。
 */
const ROOT_PKG_JSON = /^[^/]+\/package\.json$/;

/** 解析一个 .tgz，读出元数据。文件损坏或不是 npm 包时抛错 */
export function readPackage(tgz: Buffer): Omit<PackageMeta, 'updatedAt'> {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch (e) {
    throw new NodePolicyError(`不是有效的 gzip 文件：${(e as Error).message}`);
  }

  let entries;
  try {
    entries = untar(tar);
  } catch (e) {
    throw new NodePolicyError(`tar 解析失败：${(e as Error).message}`);
  }

  const candidates = entries.filter((f) => ROOT_PKG_JSON.test(f.name));
  const entry = candidates.find((f) => f.name === 'package/package.json') ?? candidates[0];
  if (!entry) {
    throw new NodePolicyError(
      '包里第一层目录下没有 package.json —— 这不像是一个 npm 包',
    );
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(Buffer.from(entry.content).toString('utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new NodePolicyError(`package.json 不是合法 JSON：${(e as Error).message}`);
  }

  const name = typeof pkg['name'] === 'string' ? pkg['name'] : '';
  const version = typeof pkg['version'] === 'string' ? pkg['version'] : '';
  if (!name || !version) {
    throw new NodePolicyError('package.json 缺 name 或 version');
  }
  assertModuleName(name);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
    throw new NodePolicyError(`版本号不是合法 semver：${version}`);
  }

  /*
   * 这个包提供哪些节点类型，取自 package.json 的 `node-red.nodes`。
   *
   * **这里不因为「不是节点包」就拒绝**。离线源里必须同时放得下节点包
   * 和它们的依赖，而依赖是普通 npm 库、根本没有 node-red 这个键。
   * 只放节点包的话，装的时候 npm 会去公网找依赖 —— 而现场没有公网，
   * 表现就是「包在源里、还是装不上」。
   *
   * 「只能批准节点包」是**审批**层的规则（见 catalog.ts），不是存储层的。
   */
  const nr = pkg['node-red'];
  const nodes = (nr && typeof nr === 'object' ? (nr as Record<string, unknown>)['nodes'] : undefined);
  const types = nodes && typeof nodes === 'object'
    ? Object.keys(nodes as Record<string, unknown>).sort()
    : [];

  const strMap = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  };

  /** peerDependenciesMeta 的值是对象（`{ optional: true }`），不是字符串 */
  const metaMap = (v: unknown): Record<string, { optional?: boolean }> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, { optional?: boolean }> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const opt = (val as Record<string, unknown>)['optional'];
        out[k] = typeof opt === 'boolean' ? { optional: opt } : {};
      }
    }
    return out;
  };

  const kw = pkg['keywords'];
  return {
    name,
    version,
    description: typeof pkg['description'] === 'string' ? pkg['description'] : '',
    keywords: Array.isArray(kw) ? kw.filter((k): k is string => typeof k === 'string') : [],
    types,
    isNodeRedNode: types.length > 0,
    dependencies: strMap(pkg['dependencies']),
    optionalDependencies: strMap(pkg['optionalDependencies']),
    peerDependencies: strMap(pkg['peerDependencies']),
    peerDependenciesMeta: metaMap(pkg['peerDependenciesMeta']),
    engines: strMap(pkg['engines']),
    size: tgz.length,
    shasum: createHash('sha1').update(tgz).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
  };
}

export class NodeStore {
  #root: string;

  /** `root` 是存 tgz 的目录，通常是 `<dataDir>/npm` */
  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /**
   * 包在盘上的路径。
   *
   * 名字过了 assertModuleName（只允许小写字母数字与 . _ -，至多一层 @scope/），
   * 所以拼进路径是安全的 —— 那个字符集里没有 `..`，也没有绝对路径的可能。
   * **不要放宽那个正则**：它同时是这里的路径安全保证。
   */
  #pathOf(module: string, version: string): string {
    assertModuleName(module);
    if (!/^[0-9A-Za-z.\-+]{1,64}$/.test(version)) {
      throw new NodePolicyError(`版本号非法：${JSON.stringify(version)}`);
    }
    return join(this.#root, module, `${version}.tgz`);
  }

  /** 导入一个 tgz。返回读出来的元数据；同名同版本会被覆盖 */
  add(tgz: Buffer): PackageMeta {
    const meta = readPackage(tgz);
    const file = this.#pathOf(meta.name, meta.version);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, tgz);
    return { ...meta, updatedAt: statSync(file).mtime.toISOString() };
  }

  has(module: string, version: string): boolean {
    return existsSync(this.#pathOf(module, version));
  }

  /** 读原始 tgz 字节，供下载用。不存在返回 undefined */
  tarball(module: string, version: string): Buffer | undefined {
    const file = this.#pathOf(module, version);
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  /** 删除某个版本。返回是否真的删掉了 */
  remove(module: string, version: string): boolean {
    const file = this.#pathOf(module, version);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  /** 某个包在库里的全部版本，升序 */
  versions(module: string): string[] {
    assertModuleName(module);
    const dir = join(this.#root, module);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => f.slice(0, -4))
      .sort(compareVersions);
  }

  /** 库里的全部包名 */
  modules(): string[] {
    const out: string[] = [];
    const scan = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (!statSync(full).isDirectory()) continue;
        // @scope 目录本身不是包，往下再走一层
        if (name.startsWith('@') && prefix === '') scan(full, `${name}/`);
        else out.push(`${prefix}${name}`);
      }
    };
    scan(this.#root, '');
    return out.sort();
  }

  /** 读某个版本的完整元数据 */
  meta(module: string, version: string): PackageMeta | undefined {
    const file = this.#pathOf(module, version);
    if (!existsSync(file)) return undefined;
    return {
      ...readPackage(readFileSync(file)),
      updatedAt: statSync(file).mtime.toISOString(),
    };
  }
}

/**
 * semver 排序。只比数字段，预发布标记一律排在同版本正式版之前。
 *
 * 不引 semver 库：这里只需要「挑出最大的那个」，而完整的 semver 优先级规则
 * （构建号、预发布标识符逐段比较）在节点包这个场景里用不上。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;      // 正式版大于任何预发布
  if (pb.pre === '') return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * 依赖闭包缺口。
 *
 * 离线源最容易出的问题不是「包没放进来」，而是「包放进来了、它的依赖没放」——
 * 那种情况下界面上一切正常，直到现场点安装，npm 去公网找依赖，超时失败。
 * 所以导入之后要能主动回答「还差什么」。
 *
 * 只沿**库里已有**的包往下走：缺失的那个包本身的依赖当然也读不到，
 * 但把它补进来之后再查一次就能继续往下推，逐轮收敛。
 *
 * 返回缺失的包名（不带版本）——版本范围的求解是 npm 的活，
 * 这里给的是「这些名字在库里一个版本都没有」这个确定的事实。
 */
export interface ClosureReport {
  /** 必需依赖里缺的。少一个，现场点安装就直接失败 */
  missing: string[];
  /**
   * 可选依赖（optionalDependencies）里缺的。
   *
   * 缺了**不会让安装失败** —— 正因如此才要单独报出来：
   * node-red-contrib-modbus 的 serialport 就在这里，缺了它包照样装上、
   * Modbus TCP 一切正常，只有串口（RTU）那半边悄无声息地不工作。
   * 不列出来的话，现场排查这种故障要花掉一整天。
   */
  missingOptional: string[];
}

export function closureReport(
  store: NodeStore, module: string, version: string,
): ClosureReport {
  const missing = new Set<string>();
  const missingOptional = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<[string, string]> = [[module, version]];

  /** 库里这个名字的最新版本；名字非法（依赖写得离谱）时当作没有 */
  const latestOf = (dep: string): string | undefined => {
    try {
      const have = store.versions(dep);
      return have[have.length - 1];
    } catch {
      return undefined;
    }
  };

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const [m, v] = next;
    const key = `${m}@${v}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const meta = store.meta(m, v);
    if (!meta) continue;
    for (const dep of Object.keys(meta.dependencies)) {
      const latest = latestOf(dep);
      // peerDependencies 不进队列：那是「宿主要提供」的东西，
      // node-red 本身就是最常见的一个，它当然不在我们的节点源里
      if (latest === undefined) missing.add(dep);
      else queue.push([dep, latest]);
    }
    /*
     * 可选依赖也要往下走：它自己在库里的话，**它的**必需依赖就是硬缺口了。
     * 只统计不递归会漏掉这一层。
     */
    for (const dep of Object.keys(meta.optionalDependencies)) {
      const latest = latestOf(dep);
      if (latest === undefined) missingOptional.add(dep);
      else queue.push([dep, latest]);
    }
  }
  // 必需与可选同时出现时按必需算：那是更严重、也更该先解决的那一个
  for (const m of missing) missingOptional.delete(m);
  return { missing: [...missing].sort(), missingOptional: [...missingOptional].sort() };
}

/** 只要必需依赖的缺口。绝大多数调用方关心的就是这一个 */
export function closureGaps(store: NodeStore, module: string, version: string): string[] {
  return closureReport(store, module, version).missing;
}
