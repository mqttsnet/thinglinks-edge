/**
 * Node-RED Admin API 客户端（T4.6）。
 *
 * 只覆盖流程模板需要的三个动作：换令牌、读流程、写流程，外加一个读已装节点类型。
 * 不做通用 SDK —— 用不到的接口写出来只会变成没人验证的死代码。
 *
 * **为什么走 Admin API 而不是直接改 flows.json**：
 *
 *   · 实例运行时 Node-RED 持有那个文件，外部写进去要等重启才生效，
 *     而且可能被它自己的写入覆盖 —— 表现是「套用成功了但流程没变」
 *   · Admin API 的 `POST /flows` 是**部署**语义：写文件 + 重新装载运行时，
 *     一步到位且立刻生效
 *   · 验收标准写的就是「套用模板 → 部署 → `POST /flows` 得 200」
 *
 * 实测 5.0.4：`POST /flows` 成功返回的是 **204** 而不是 200（验收标准里的
 * 「200」是宽泛说法）。所以判断成功要看 2xx，写死 200 会把正常部署判成失败。
 */
import { authTokenKeyFor } from '../config.ts';
import { PLATFORM_NODE_TYPES } from '../nodes/platform-contract.ts';

export class AdminApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

export interface AdminTarget {
  /** 实例上游基址，如 http://tle-nr-line-a:1880 */
  upstream: string;
  /** httpAdminRoot，带首尾斜杠，如 /red/line-a/ */
  adminRoot: string;
  username: string;
  password: string;
}

/** 注入用：测试与验证脚本替换 fetch */
export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 15_000;
const PLATFORM_TYPES = new Set<string>(PLATFORM_NODE_TYPES);

function withTimeout(timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

/**
 * 换取实例的 access_token。
 *
 * 与免密跳转用的是同一套凭据与同一个端点，行为必须保持一致 ——
 * 两处各写一份迟早漂移，而漂移的表现是「网页能进、模板套不上」这种怪事。
 */
export async function getAccessToken(
  t: AdminTarget,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'node-red-editor', grant_type: 'password', scope: '*',
        username: t.username, password: t.password,
      }),
      signal,
    });
    if (!res.ok) throw new AdminApiError(`向实例换取令牌失败（HTTP ${res.status}）`, res.status);
    const body = await res.json() as { access_token?: string };
    if (!body.access_token) throw new AdminApiError('实例返回的令牌里没有 access_token');
    return body.access_token;
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`连接实例失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/**
 * 未启用 adminAuth 的实例拿不到令牌，但接口本身是通的。
 *
 * 我们创建的实例一律带 adminAuth，所以正常路径必有令牌；
 * 这里容忍无令牌只是为了让外部导入的实例也能用模板功能，
 * 而不是默认放行 —— 拿不到令牌时仍然会照常带上空头去试，由实例自己决定拒不拒。
 */
async function authHeaders(
  t: AdminTarget, fetchImpl: FetchLike, timeoutMs: number,
): Promise<Record<string, string>> {
  try {
    return { authorization: `Bearer ${await getAccessToken(t, fetchImpl, timeoutMs)}` };
  } catch {
    return {};
  }
}

/** 读取实例当前的全部流程 */
export async function getFlows(
  t: AdminTarget,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}flows`, {
      headers: { ...headers, accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new AdminApiError(`读取实例流程失败（HTTP ${res.status}）`, res.status);
    return await res.json();
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`读取实例流程失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** 读取实例已安装的全部节点类型，用于套用前的兼容性比对 */
export async function getInstalledTypes(
  t: AdminTarget,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}nodes`, {
      headers: { ...headers, accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new AdminApiError(`读取实例节点清单失败（HTTP ${res.status}）`, res.status);
    const sets = parseNodeSets(await res.text());
    return [...new Set(sets.flatMap((set) => set.types))].sort();
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`读取实例节点清单失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** Node-RED Admin API 返回的一条 node set；`file` 是可选观察证据，不是所有权证明。 */
export interface InstalledNodeSet {
  id: string;
  name: string;
  module: string;
  version: string;
  types: string[];
  enabled: boolean;
  err: string;
  file?: string;
  /** Node-RED 5 返回的实际字段；缺失时不猜测其安装来源。 */
  local?: boolean;
}

/** 实例上装着的一个节点模块。 */
export interface InstalledModule {
  module: string;
  version: string;
  /**
   * 是否**不是**镜像自带的。
   *
   * 实测 5.0.4：`node-red` 本体回 `local:false`，从节点面板装进 userDir 的包回
   * `local:true`。注意由 `nodesDir` 扫目录加载的 `@thinglinks` 节点集也算 local ——
   * 它确实不是镜像自带的，只是来路不是 npm。要再细分就看包名。
   */
  local: boolean;
  /** 该模块提供的节点类型 */
  types: string[];
  /** 是否全部节点都处于启用状态 */
  enabled: boolean;
  /** 每个 node set 的原始加载错误；空数组才表示没有观察到加载错误。 */
  errors: string[];
  /** 原始 node set，不能只靠扁平 types 推断加载或所有权状态。 */
  nodeSets: InstalledNodeSet[];
  /** Admin API 实际提供的 file 字段；可能为空，且不是 npm 路径证明。 */
  observedFiles: string[];
  source: 'builtin' | 'raw' | 'npm' | 'mixed' | 'unknown';
  health: 'healthy' | 'conflict' | 'failed';
}

type NodeSetResponse = {
  id?: unknown; name?: unknown; module?: unknown; version?: unknown; types?: unknown;
  enabled?: unknown; err?: unknown; file?: unknown; local?: unknown;
};

function asNodeSet(value: unknown, fallbackModule = '', fallbackVersion = ''): InstalledNodeSet {
  const set = (value ?? {}) as NodeSetResponse;
  return {
    id: typeof set.id === 'string' ? set.id : '',
    name: typeof set.name === 'string' ? set.name : '',
    module: typeof set.module === 'string' ? set.module : fallbackModule,
    version: typeof set.version === 'string' ? set.version : fallbackVersion,
    types: Array.isArray(set.types) ? set.types.filter((type): type is string => typeof type === 'string').sort() : [],
    enabled: set.enabled !== false,
    err: typeof set.err === 'string' ? set.err : '',
    ...(typeof set.file === 'string' ? { file: set.file } : {}),
    ...(typeof set.local === 'boolean' ? { local: set.local } : {}),
  };
}

function parseNodeSets(text: string, fallbackModule = '', fallbackVersion = ''): InstalledNodeSet[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AdminApiError('实例返回的节点清单不是 JSON');
  }
  const record = body as { name?: unknown; version?: unknown; nodes?: unknown };
  const module = typeof record?.name === 'string' ? record.name : fallbackModule;
  const version = typeof record?.version === 'string' ? record.version : fallbackVersion;
  const entries = Array.isArray(body) ? body : Array.isArray(record?.nodes) ? record.nodes : undefined;
  if (!entries) throw new AdminApiError('实例返回的节点清单格式不正确');
  return entries.map((entry) => asNodeSet(entry, module, version));
}

function sourceForNodeSets(module: string, types: string[]): InstalledModule['source'] {
  if (!module) return 'unknown';
  if (module !== 'node-red') return 'npm';
  const hasPlatformType = types.some((type) => PLATFORM_TYPES.has(type));
  const hasBuiltinType = types.some((type) => !PLATFORM_TYPES.has(type));
  if (hasPlatformType && hasBuiltinType) return 'mixed';
  return hasPlatformType ? 'raw' : 'builtin';
}

/** 将同一模块的原始 node set 归并；更严格的来源与冲突判定由 inventory.ts 完成。 */
export function moduleFromNodeSets(module: string, nodeSets: InstalledNodeSet[]): InstalledModule {
  const orderedSets = [...nodeSets].sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
  const versions = [...new Set(orderedSets.map((set) => set.version).filter(Boolean))].sort();
  const errors = orderedSets.map((set) => set.err).filter(Boolean);
  const types = [...new Set(orderedSets.flatMap((set) => set.types))].sort();
  const observedFiles = [...new Set(orderedSets.flatMap((set) => set.file ? [set.file] : []))].sort();
  return {
    module,
    // Admin API does not guarantee a single version record. Pick deterministically; nodeSets retain all evidence.
    version: versions[0] ?? '',
    local: orderedSets.some((set) => set.local === true),
    types,
    enabled: orderedSets.every((set) => set.enabled),
    errors,
    nodeSets: orderedSets,
    observedFiles,
    source: sourceForNodeSets(module, types),
    health: errors.length > 0 ? 'failed' : 'healthy',
  };
}

/** 读 Admin API 的原始 node set，保留每条加载错误和可选 file 观察字段。 */
export async function getInstalledNodeSets(
  t: AdminTarget,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<InstalledNodeSet[]> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}nodes`, {
      headers: { ...headers, accept: 'application/json' }, signal,
    });
    const text = await res.text();
    if (!res.ok) throw new AdminApiError(`读取实例节点清单失败（HTTP ${res.status}）`, res.status);
    return parseNodeSets(text);
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`读取实例节点清单失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/**
 * 读实例已安装的**模块**清单（含版本），供平台侧节点台账用。
 *
 * 与 getInstalledTypes 的区别：那个只要类型名，用来做模板兼容性比对；
 * 这个要模块与版本，用来回答「这台机器上装了哪些节点、什么版本」。
 * 同一个接口两种投影，各取所需，不合并成一个「什么都返回」的函数。
 */
export async function getInstalledModules(
  t: AdminTarget,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<InstalledModule[]> {
  const sets = await getInstalledNodeSets(t, fetchImpl, timeoutMs);
  const byModule = new Map<string, InstalledNodeSet[]>();
  for (const set of sets) {
    if (!set.module) continue;
    const current = byModule.get(set.module) ?? [];
    current.push(set);
    byModule.set(set.module, current);
  }
  return [...byModule.entries()]
    .map(([module, moduleSets]) => moduleFromNodeSets(module, moduleSets))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * 往实例里装一个节点包（01 号文 5.7）。
 *
 * 走实例自己的 `POST /nodes` —— 也就是节点面板点「安装」时走的那条路。
 * **刻意不绕过它**：白名单、私有源、依赖解析全在那条路上，绕过去就等于
 * 让控制台装的包不受任何管控，而现场从面板装的却受管控。两套规则迟早出事。
 *
 * 装完立即生效，不需要重启实例 —— Node-RED 的节点安装是热加载的。
 *
 * 错误按 code 翻译成人话：实例回的是 `install_not_allowed` 这种机器码，
 * 直接透出去的话，现场看到一串英文完全不知道下一步该干什么。
 */
export async function installModule(
  t: AdminTarget,
  module: string,
  version: string | undefined,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 120_000,          // 装包要下载与解压，比其它调用慢得多
): Promise<InstalledModule> {
  const installed = await stageModule(t, module, version, fetchImpl, timeoutMs);
  if (installed.errors.length > 0) {
    // HTTP 200 only says the installer answered. A node-set err means Node-RED did not load it.
    throw new AdminApiError(
      `装 ${module} 后节点未成功加载：${installed.errors.join('; ')}`,
      409,
    );
  }
  return installed;
}

/**
 * 调用 Node-RED 安装接口并保留它返回的原始 node-set 证据。
 *
 * 迁移流程可用它记录重复注册等现场状态；只有 installModule 才把这种状态收紧为失败。
 */
export async function stageModule(
  t: AdminTarget,
  module: string,
  version: string | undefined,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 120_000,
): Promise<InstalledModule> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}nodes`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(version ? { module, version } : { module }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new AdminApiError(explainInstallError(module, res.status, text), res.status);
    const nodeSets = parseNodeSets(text, module, version ?? '');
    const responseModule = nodeSets.find((set) => set.module)?.module || module;
    return moduleFromNodeSets(responseModule, nodeSets);
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`装节点包失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** 读取一个模块的 Admin API 详情；不把缺少的 file 字段伪造成 node_modules 路径。 */
export async function getModuleDetail(
  t: AdminTarget,
  module: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<InstalledModule> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}nodes/${encodeURIComponent(module)}`, {
      headers: { ...headers, accept: 'application/json' }, signal,
    });
    const text = await res.text();
    if (!res.ok) throw new AdminApiError(`读取节点模块 ${module} 失败（HTTP ${res.status}）`, res.status);
    const nodeSets = parseNodeSets(text, module);
    return moduleFromNodeSets(module, nodeSets);
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`读取节点模块 ${module} 失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** 卸载只能以 Node-RED 的非 2xx 响应为失败，成功不猜测其重载或文件清理结果。 */
export async function uninstallModule(
  t: AdminTarget,
  module: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 120_000,
): Promise<void> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}nodes/${encodeURIComponent(module)}`, {
      method: 'DELETE', headers, signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AdminApiError(
        `卸载 ${module} 失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`卸载 ${module} 失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** 把实例回的机器码翻成现场能照着做的话 */
function explainInstallError(module: string, status: number, body: string): string {
  let code = '';
  try { code = String((JSON.parse(body) as { code?: unknown }).code ?? ''); } catch { /* 非 JSON */ }
  switch (code) {
    case 'install_not_allowed':
      return `${module} 不在这台实例的批准清单里。请先在「批准清单」批准它，`
        + '再点右上角「下发到实例」，然后重试';
    case 'module_already_loaded':
      return `${module} 已经装过了`;
    case 'invalid_module_name':
      return `包名不合法：${module}`;
    case 'invalid_module_url':
      return `包地址不合法：${module}`;
    default:
      return `装 ${module} 失败（HTTP ${status}）：${body.slice(0, 300)}`;
  }
}

/**
 * 部署流程。
 *
 * `Node-RED-Deployment-Type: full` 是刻意的：`nodes` / `flows` 那两种增量部署
 * 只重启变化的部分，而套用模板是**整体替换**，语义上就该整个重来。
 * 用增量部署会留下上一套流程的运行时状态，那种残留极难排查。
 */
export async function setFlows(
  t: AdminTarget,
  flows: unknown,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number }> {
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}flows`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'Node-RED-Deployment-Type': 'full',
      },
      body: JSON.stringify(flows),
      signal,
    });
    // 实测 5.0.4 成功回 204。判 2xx 而不是判 200，否则正常部署会被当成失败
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AdminApiError(
        `部署流程失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`,
        res.status,
      );
    }
    return { status: res.status };
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`部署流程失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** 复导出，供 SSO 与模板两处共用同一个键名推导 */
export { authTokenKeyFor };
