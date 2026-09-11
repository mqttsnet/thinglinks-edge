/**
 * MQTT 连接参数 —— 版本、心跳、超时、重连。
 *
 * 单独成文件的理由与 `tls.ts` 一样：**持久化层和传输层都要用它**。
 * 类型放在任一边都会形成倒挂 —— config-repo 去 import gateway 会把 mqtt 客户端
 * 拖进持久化的依赖图，反过来则是传输层的行为由存储结构定义。
 *
 * 这几项原本写死在 gateway 里。写死不是不能用，是**现场没得调**：
 *
 *   · 有些云侧只认 MQTT 3.1.1，5.0 连上去直接被拒
 *   · NAT 网关常在 60 秒后回收空闲连接，心跳得压到 30 才不会被无声掐断
 *   · 4G 弱网现场，5 秒一次重连会把本就窄的上行带宽占满
 *
 * `DEFAULT_CONNECTION` 的每一项都**等于写死时的那个值**：升级顺手改掉运行参数，
 * 是最难排查的一类事故 —— 现场只知道「昨天还好好的」。
 */

export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionConfigError';
  }
}

export interface ConnectionOptions {
  /** mqtt.js 的 protocolVersion：3 = MQTT 3.1，4 = 3.1.1，5 = 5.0 */
  mqttVersion: 3 | 4 | 5;
  /** 心跳，秒。0 = 不发心跳，只有确知中间链路不回收空闲连接时才该用 */
  keepaliveSec: number;
  connectTimeoutSec: number;
  /** 关掉后断线不再自动重连，要人工点「重新连接」。现场几乎不该关 */
  autoReconnect: boolean;
  reconnectPeriodMs: number;
}

export const DEFAULT_CONNECTION: ConnectionOptions = {
  mqttVersion: 5,
  keepaliveSec: 60,
  connectTimeoutSec: 15,
  autoReconnect: true,
  reconnectPeriodMs: 5_000,
};

/** 界面下拉用。3.1 摆在最后：需要它的现场很少，但需要时非它不可 */
export const MQTT_VERSIONS = [
  { value: 5, label: '5.0' },
  { value: 4, label: '3.1.1' },
  { value: 3, label: '3.1' },
] as const;

function assertInt(v: number, name: string, min: number, max: number, unit: string): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ConnectionConfigError(
      `${name}要是 ${min}—${max} ${unit}之间的整数，收到 ${String(v)}`,
    );
  }
}

/**
 * 合并并校验。逐字段「没传就不改」，与 TLS 同一套语义。
 *
 * 逐项给范围，而不是「随便填、连不上再说」：keepalive 填 100000 会在 CONNECT
 * 阶段被 broker 直接拒掉（MQTT 的 keepalive 是 16 位字段），重连间隔填 10 毫秒
 * 会在断网时把 CPU 和那条本就不通的链路一起打满。两种错都不会说自己是错。
 */
export function normalizeConnection(
  input: Partial<ConnectionOptions> | undefined,
  prev: ConnectionOptions = DEFAULT_CONNECTION,
): ConnectionOptions {
  const merged: ConnectionOptions = { ...prev, ...(input ?? {}) };

  if (![3, 4, 5].includes(merged.mqttVersion)) {
    throw new ConnectionConfigError(
      `MQTT 版本只能是 3（3.1）/ 4（3.1.1）/ 5（5.0），收到 ${String(merged.mqttVersion)}`,
    );
  }
  // 上限 65535 是 MQTT 协议的 16 位字段决定的，不是我们定的
  assertInt(merged.keepaliveSec, '心跳间隔', 0, 65535, '秒');
  assertInt(merged.connectTimeoutSec, '连接超时', 1, 300, '秒');
  // 下限 500ms：再短的重连间隔在断网时只会空转，帮不上忙
  assertInt(merged.reconnectPeriodMs, '重连周期', 500, 300_000, '毫秒');

  return merged;
}

/**
 * 落成 mqtt.js 的连接参数。
 *
 * 两处不能想当然：MQTT 3.1 的协议名是 `MQIsdp` 而不是 `MQTT`，少了它会被
 * broker 在 CONNECT 阶段拒掉、且只报「连接被拒」；「关掉自动重连」在 mqtt.js 里
 * 就是把间隔设成 0，没有单独的开关。
 */
export function connectionOptions(conn: ConnectionOptions): Record<string, unknown> {
  return {
    protocolVersion: conn.mqttVersion,
    ...(conn.mqttVersion === 3 ? { protocolId: 'MQIsdp' } : {}),
    keepalive: conn.keepaliveSec,
    connectTimeout: conn.connectTimeoutSec * 1000,
    reconnectPeriod: conn.autoReconnect ? conn.reconnectPeriodMs : 0,
  };
}
