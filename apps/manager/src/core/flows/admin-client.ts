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
    const modules = await res.json() as Array<{ types?: string[] }>;
    return [...new Set(modules.flatMap((m) => m.types ?? []))].sort();
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`读取实例节点清单失败：${(e as Error).message}`);
  } finally {
    done();
  }
}

/** 实例上装着的一个节点模块 */
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
  const headers = await authHeaders(t, fetchImpl, timeoutMs);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(`${t.upstream}${t.adminRoot}nodes`, {
      headers: { ...headers, accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new AdminApiError(`读取实例节点清单失败（HTTP ${res.status}）`, res.status);
    const sets = await res.json() as Array<{
      module?: string; version?: string; local?: boolean; types?: string[]; enabled?: boolean;
    }>;

    // 一个模块可以含多个节点集（每个 .js 一个），按模块归并
    const byModule = new Map<string, InstalledModule>();
    for (const s of sets) {
      if (!s.module) continue;
      const cur = byModule.get(s.module) ?? {
        module: s.module, version: s.version ?? '', local: s.local === true,
        types: [], enabled: true,
      };
      cur.types = [...new Set([...cur.types, ...(s.types ?? [])])];
      // 有任意一个节点集被停用，就不算「全部启用」——现场要看到这个差别
      cur.enabled = cur.enabled && s.enabled !== false;
      byModule.set(s.module, cur);
    }
    return [...byModule.values()]
      .map((m) => ({ ...m, types: m.types.sort() }))
      .sort((a, b) => a.module.localeCompare(b.module));
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`读取实例节点清单失败：${(e as Error).message}`);
  } finally {
    done();
  }
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
): Promise<{ module: string; version: string; types: string[] }> {
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

    const info = JSON.parse(text) as { name?: string; version?: string; nodes?: Array<{ types?: string[] }> };
    return {
      module: info.name ?? module,
      version: info.version ?? '',
      types: [...new Set((info.nodes ?? []).flatMap((n) => n.types ?? []))].sort(),
    };
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw new AdminApiError(`装节点包失败：${(e as Error).message}`);
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
