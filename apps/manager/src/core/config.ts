/**
 * 配置：EXTERNAL_URL 是唯一真源。
 *
 * 所有对外可见的 URL 一律由它派生，绝不从请求头推断 —— 现场「装到客户那儿打不开」
 * 的问题，根因几乎都是程序试图猜自己的外部地址，而现场恰好有一层它没料到的东西。
 */

export interface EdgeConfig {
  /** 外部访问地址原文，如 https://portal.corp.com/nodered */
  externalUrl: string;
  /** 由 externalUrl 派生：无尾斜杠的路径前缀；挂根路径时为空串 */
  basePath: string;
  /** 由 externalUrl 的 scheme 判定，而非当前连接是否加密（外层可能已卸载 TLS） */
  cookieSecure: boolean;
  /** WebSocket 与 CORS 的 Origin 白名单 */
  allowedOrigins: string[];
  /** 监听地址，默认仅回环 —— 不默认监听全部网卡 */
  listenAddr: string;
  listenPort: number;
  /** 宿主持久化根目录 —— Manager 与全部实例的数据都落在这下面，排障只看这一处 */
  dataRoot: string;
  /** 数据目录（SQLite、密钥、spool），默认 dataRoot/manager */
  dataDir: string;
  /**
   * 实例数据根，默认 dataRoot/instances；每个实例一个子目录，bind 挂进容器 /data。
   *
   * 这个值会拼进 docker 的 Binds，由**宿主 daemon** 解析，而 Manager 自己要 mkdir/删除
   * 同一目录时用的是**容器内**视角。因此 Manager 容器必须把这个目录挂在同名路径上 ——
   * 路径一致就不需要在两种视角间翻译，而那种翻译一旦错位就是静默挂错盘。
   */
  instanceDataRoot: string;
  /** 实例宿主端口可分配范围 */
  portRange: { min: number; max: number };
  /**
   * 实例容器时区。
   *
   * Node-RED 官方镜像默认 UTC，与现场差 8 小时：定时节点、班次判断、日志时间戳全错，
   * 而且不报错。镜像自带 tzdata，给 TZ 环境变量即可生效 —— 用它而不是挂
   * /etc/localtime，这样容器创建参数白名单一个口子都不用开。
   */
  timezone: string;
  /**
   * 升级检查地址。**留空表示彻底不联网**，这是默认值。
   *
   * 现场大量站点没有外网（03 号文十三类网络场景），工业客户对「设备自己往外连」
   * 也很敏感 —— 必须由部署方显式配置才发起请求。
   * 官方仓库可填：`https://api.github.com/repos/mqttsnet/thinglinks-edge/releases/latest`
   */
  updateCheckUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 归一化路径前缀：去尾斜杠、保证有头斜杠、空路径归为空串 */
export function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * 推导某个实例的 httpAdminRoot。
 *
 * 必须带 basePath —— 外层企业反代把服务挂在子路径下时，前缀要一路带进实例，
 * 否则编辑器静态资源与 WebSocket 会丢前缀。已在真实 Node-RED 容器验证。
 */
export function adminRootFor(basePath: string, instanceId: string): string {
  return `${basePath}/red/${instanceId}/`;
}

/** Node-RED 存 token 的本地存储键，按 httpAdminRoot 命名空间化（实测 5.0.4） */
export function authTokenKeyFor(adminRoot: string): string {
  const suffix = adminRoot.replace(/\//g, '-').replace(/-+$/, '');
  return suffix === '-' || suffix === '' ? 'auth-tokens' : `auth-tokens${suffix}`;
}

/**
 * 校验持久化路径。必须是绝对路径：它要同时被宿主 daemon 与 Manager 解析，
 * 相对路径在两边含义不同。冒号会破坏 docker 的 `src:dst` 挂载语法。
 */
function assertDataPath(raw: string, name: string): string {
  if (!raw.startsWith('/')) throw new ConfigError(`${name} 必须是绝对路径，收到 ${raw}`);
  if (raw.includes(':')) throw new ConfigError(`${name} 不能含冒号，会破坏挂载语法：${raw}`);
  const normalized = raw.replace(/\/+$/, '');
  if (normalized === '') throw new ConfigError(`${name} 不能是根目录 /`);
  if (normalized.split('/').includes('..')) throw new ConfigError(`${name} 不能含 ..：${raw}`);
  return normalized;
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`${name} 必须是 1-65535 的整数，收到 ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  const raw = env['EXTERNAL_URL']?.trim();
  if (!raw) {
    throw new ConfigError(
      'EXTERNAL_URL 未配置。它是所有对外链接、跳转与 Cookie 策略的唯一真源，' +
        '现场无域名时直接填 IP，例如 http://192.168.10.20:8080',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`EXTERNAL_URL 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`EXTERNAL_URL 只支持 http/https，收到 ${url.protocol}`);
  }

  const basePath = normalizeBasePath(url.pathname);
  const portMin = parsePort(env['INSTANCE_PORT_MIN'], 30000, 'INSTANCE_PORT_MIN');
  const portMax = parsePort(env['INSTANCE_PORT_MAX'], 30999, 'INSTANCE_PORT_MAX');
  if (portMin >= portMax) {
    throw new ConfigError(`INSTANCE_PORT_MIN(${portMin}) 必须小于 INSTANCE_PORT_MAX(${portMax})`);
  }

  const dataRoot = assertDataPath(
    env['EDGE_DATA_ROOT']?.trim() || '/data01/mqttsnet/thinglinks-edge',
    'EDGE_DATA_ROOT',
  );

  const extraOrigins = (env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    externalUrl: raw,
    basePath,
    cookieSecure: url.protocol === 'https:',
    allowedOrigins: [url.origin, ...extraOrigins],
    listenAddr: env['LISTEN_ADDR']?.trim() || '127.0.0.1',
    listenPort: parsePort(env['LISTEN_PORT'], 8080, 'LISTEN_PORT'),
    dataRoot,
    dataDir: assertDataPath(env['DATA_DIR']?.trim() || `${dataRoot}/manager`, 'DATA_DIR'),
    instanceDataRoot: assertDataPath(
      env['INSTANCE_DATA_ROOT']?.trim() || `${dataRoot}/instances`,
      'INSTANCE_DATA_ROOT',
    ),
    portRange: { min: portMin, max: portMax },
    timezone: env['TZ']?.trim() || 'Asia/Shanghai',
    updateCheckUrl: env['UPDATE_CHECK_URL']?.trim() || '',
  };
}
