/**
 * Broker 地址的拆与拼。
 *
 * 从 `CloudView.vue` 抽出来的**纯函数**，一行 Vue 都不依赖。抽出来的理由不是行数，
 * 是这段逻辑**最容易静默出错**：把整条 URL 拆成四格给人改、再拼回去交给后端，
 * 中间任何一处偏差都不会报错，只表现为「地址看着对、就是连不上」。
 * 变成纯函数之后它可以被单测钉死 —— 界面里那份没法测。
 */
import {
  BROKER_SCHEMES, SCHEME_DEFAULT_PORT, PROTOCOL_DEFAULT_PORT, DEFAULT_BROKER_HOST,
  type BrokerScheme,
} from '../../api/types.ts';

export interface BrokerParts {
  scheme: BrokerScheme;
  host: string;
  port: number;
  path: string;
}

/** 只有 ws/wss 走 HTTP 路径，tcp 那两个没有 path 的概念 */
export const isWs = (scheme: string): boolean => scheme === 'ws://' || scheme === 'wss://';

/** 链路加不加密只看 scheme —— 与后端同一条规则 */
export const isSecure = (scheme: string): boolean =>
  scheme === 'mqtts://' || scheme === 'wss://';

/**
 * 把落库的整条 URL 拆成界面上的四段。
 *
 * 存进去的地址都过了后端校验，所以正常情况解析不会失败；解析不了时**不抛错**，
 * 而是把原值原样放进主机格 —— 让人看得见那串东西再自己改，比清空好：
 * 清空之后没人知道原来配的是什么。
 */
export function splitBroker(url: string): BrokerParts {
  try {
    const u = new URL(url.trim());
    const raw = `${u.protocol}//` as BrokerScheme;
    const scheme = BROKER_SCHEMES.includes(raw) ? raw : 'mqtt://';
    return {
      scheme,
      // hostname 对 IPv6 会带方括号（[::1]），正好是拼回去时要的形态
      host: u.hostname,
      /*
       * 地址没写端口时补**协议默认端口**，不是 ThingLinks 那组建议端口 ——
       * `mqtts://host` 实际连 8883，补成 11884 会把地址悄悄改掉，
       * 而用户看界面只会看到一个「本来就该是这样」的端口。
       */
      port: u.port === '' ? (PROTOCOL_DEFAULT_PORT[scheme] ?? 1883) : Number(u.port),
      /*
       * **`mqtt:` 是非特殊 scheme**，URL 解析器按 opaque path 处理，
       * `new URL('mqtt://h:1883').pathname` 得到的是 `''` 而不是 `'/'`。
       * 这不影响 mqtt/mqtts（它们本来就不用 path），但从 mqtt 切到 ws 时
       * 会留下一个空 path —— 见 pathOnSchemeChange。
       */
      path: u.pathname === '/' ? '/mqtt' : u.pathname,
    };
  } catch {
    return { scheme: 'mqtt://', host: url.trim(), port: 11883, path: '/mqtt' };
  }
}

/** 拼回给后端的整条地址。端口一律显式写出，不靠 mqtt.js 的默认端口 */
export function joinBroker(p: BrokerParts): string {
  const base = `${p.scheme}${p.host.trim()}:${p.port}`;
  if (!isWs(p.scheme)) return base;
  const path = p.path.trim();
  return base + (path === '' ? '' : path.startsWith('/') ? path : `/${path}`);
}

/**
 * 换协议时该不该把端口一并带过去。
 *
 * 只在**用户没自己改过端口**时带 —— 判断依据是「当前端口正好是某个协议的默认值」。
 * 用户填了自定义端口，切协议不该被悄悄改掉：端口是最容易被改了却没人注意的一格。
 */
export function portOnSchemeChange(currentPort: number, next: BrokerScheme): number {
  const known = Object.values(SCHEME_DEFAULT_PORT) as number[];
  return known.includes(currentPort) ? SCHEME_DEFAULT_PORT[next] : currentPort;
}

/**
 * 换协议时该不该补默认 path。
 *
 * 从 `mqtt://` 切到 `ws://` 时 path 往往是空的（见 splitBroker 里的说明），
 * 拼出来就是 `ws://host:8083` —— 没有路径。多数 broker 的 WebSocket 端点在
 * `/mqtt` 上，连过去会 404，而界面上那格是空的、看不出少了什么。
 * 所以切到 ws/wss 且 path 为空时补上默认值；已有 path 一律不动。
 */
export function pathOnSchemeChange(currentPath: string, next: BrokerScheme): string {
  if (!isWs(next)) return currentPath;
  return currentPath.trim() === '' ? '/mqtt' : currentPath;
}

/** 一键填默认地址。现场手敲域名最容易把协议和端口配错 */
export function defaultBroker(tls: boolean): Pick<BrokerParts, 'scheme' | 'host' | 'port'> {
  const scheme: BrokerScheme = tls ? 'mqtts://' : 'mqtt://';
  return { scheme, host: DEFAULT_BROKER_HOST, port: SCHEME_DEFAULT_PORT[scheme] };
}
