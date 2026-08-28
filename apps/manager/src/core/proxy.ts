/**
 * 企业 HTTP 代理（`03-复杂网络环境适配.md` 2.10）。
 *
 * 现场形态：边缘盒子没有直接出网权限，所有对外 HTTP 必须走企业代理。
 * 这件事有三个层面，缺一个都会在现场变成难查的故障：
 *
 *   1. **Manager 自己出网**（升级检查等）走代理 ——
 *      由 Node 24 的 `NODE_USE_ENV_PROXY=1` 接管 `fetch`，镜像里已默认打开；
 *      没配代理时它什么都不做，所以离线部署不受影响。
 *   2. **实例容器出网**（装第三方节点）走代理 —— 由这里把变量透传进容器。
 *   3. **内部通信绝不能走代理** —— 这是最容易翻车的一条：
 *      `NO_PROXY` 漏了容器名，实例访问 Manager、Manager 反代实例都会被绕去代理，
 *      表现是 502 或探针不通，而代理日志里是一串「无法解析的主机名」。
 *      所以 `NO_PROXY` 不能原样透传，必须由平台补齐内部条目。
 *
 * MQTT 不在其列：云连接是 MQTT over TCP/TLS，**HTTP 代理管不了它**。
 * 只有出网代理而没有放行 MQTT 端口的现场，云连接一定连不上 ——
 * 自检里会明说这件事，而不是让人对着 `connecting/offline` 反复猜。
 */

export interface ProxySettings {
  /** 空串表示没配 */
  httpProxy: string;
  httpsProxy: string;
  /** 原样取到的 NO_PROXY，未补内部条目 */
  noProxy: string;
}

/** 是否配了出网代理。离线部署下三项皆空，全部相关逻辑退化为不做事 */
export function proxyConfigured(p: ProxySettings): boolean {
  return p.httpProxy !== '' || p.httpsProxy !== '';
}

/**
 * 读取代理配置。大小写两种写法都认 ——
 * 大写是 Docker / 企业运维的习惯，小写是 curl 与多数 CLI 的习惯，
 * 现场两种都会出现，只认一种就会变成「我明明配了」。
 */
export function readProxySettings(env: NodeJS.ProcessEnv = process.env): ProxySettings {
  const pick = (upper: string) => (env[upper] ?? env[upper.toLowerCase()] ?? '').trim();
  return {
    httpProxy: pick('HTTP_PROXY'),
    httpsProxy: pick('HTTPS_PROXY'),
    noProxy: pick('NO_PROXY'),
  };
}

/** 平台必须自己保证不走代理的目标 */
export interface InternalHosts {
  /** Manager 的容器名；宿主开发态没有则留空 */
  managerContainer: string;
  /** 实例容器名前缀，如 `tle-nr-` —— 用通配写进 NO_PROXY */
  instancePrefix: string;
  /** 实例所在 docker 网络名 */
  network: string;
}

/** 任何部署形态下都不该走代理的固定条目 */
const ALWAYS: readonly string[] = ['localhost', '127.0.0.1', '::1', '.local'];

/**
 * 把内部条目补进 NO_PROXY。
 *
 * 用户填的排在前面、原样保留 —— 企业网管给的清单不能被平台改写；
 * 平台只往后追加自己必须的那几条，且去重。
 */
export function buildNoProxy(user: string, hosts: InternalHosts): string {
  const items = user.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const add = (v: string) => {
    if (v !== '' && !items.some((i) => i.toLowerCase() === v.toLowerCase())) items.push(v);
  };
  for (const a of ALWAYS) add(a);
  add(hosts.managerContainer);
  // 容器名没有域名后缀，通配要写成 `前缀*`：多数客户端（含 Node、curl、npm）
  // 对 NO_PROXY 的匹配是后缀匹配，`tle-nr-*` 这种写法不通用，
  // 因此直接把前缀本身写进去 —— 前缀匹配不到的实例名不存在
  add(hosts.instancePrefix);
  add(hosts.network);
  return items.join(',');
}

/**
 * 生成注入实例容器的环境变量。
 *
 * 没配代理时返回空数组 —— 不能注入空值：`HTTP_PROXY=` 在部分客户端里
 * 会被当成「配了一个空代理」，比不配更糟。
 */
export function proxyEnvFor(p: ProxySettings, hosts: InternalHosts): string[] {
  if (!proxyConfigured(p)) return [];
  const noProxy = buildNoProxy(p.noProxy, hosts);
  const out: string[] = [];
  for (const [name, value] of [
    ['HTTP_PROXY', p.httpProxy],
    ['HTTPS_PROXY', p.httpsProxy || p.httpProxy],
    ['NO_PROXY', noProxy],
  ] as const) {
    if (value === '') continue;
    // 大小写各给一份：容器里跑的是 npm / node-red / 各种节点，
    // 它们读哪一种全看实现，只给一种就会有一半程序绕过代理
    out.push(`${name}=${value}`, `${name.toLowerCase()}=${value}`);
  }
  return out;
}

/** 代理地址是否像话。只做形态校验，连通性由自检项负责 */
export function parseProxyUrl(raw: string): { ok: true; host: string; port: number } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `不是合法 URL：${raw}（应形如 http://proxy.corp.com:8080）` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `代理协议只支持 http/https，收到 ${u.protocol}` };
  }
  if (u.username !== '' || u.password !== '') {
    // 不拒绝：带认证的代理在企业里很常见。但要提醒它会随环境变量落进容器
    // 与进程列表 —— 这件事必须让部署方知道，而不是我们替他决定
    return { ok: true, host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  }
  return { ok: true, host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
}

/**
 * Manager **自己**的 NO_PROXY 是否已覆盖内部目标。
 *
 * 这条不是锦上添花：Manager 连受限 docker 代理、反代到实例、应用层探针，
 * 全走 Node 的 HTTP 客户端。配了 HTTP_PROXY 而 NO_PROXY 没写这些名字，
 * 它们会被一并送去企业代理，表现是「创建实例失败：无法查询镜像 …
 * connect ECONNREFUSED <代理地址>」—— 看起来完全像 docker 端点坏了。
 *
 * 只能报警不能自动修：`NODE_USE_ENV_PROXY` 在进程启动时就把代理规则定死了，
 * 进程内再改 `process.env.NO_PROXY` 已经不生效。正确的位置是 compose / 启动参数。
 */
export function missingInternalNoProxy(p: ProxySettings, hosts: InternalHosts): string[] {
  if (!proxyConfigured(p)) return [];
  const listed = p.noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [hosts.managerContainer, hosts.instancePrefix, hosts.network, 'localhost']
    .filter((v) => v !== '' && !listed.includes(v.toLowerCase()));
}

/** 代理地址里是否内嵌了账号口令 —— 自检要就此提醒 */
export function proxyHasCredentials(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}
