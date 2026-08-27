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
  /** 数据目录（SQLite、密钥、spool） */
  dataDir: string;
  /** 实例宿主端口可分配范围 */
  portRange: { min: number; max: number };
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
    dataDir: env['DATA_DIR']?.trim() || '/data',
    portRange: { min: portMin, max: portMax },
  };
}
