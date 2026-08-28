/**
 * 探测目标的解析（T4.5）。
 *
 * 把 URL 或 `host:port` 拆成主机与端口。单独成文件是因为它是纯函数、
 * 无 IO、可被 HTTP 层在真正发起探测之前拿来做入参校验。
 */

/**
 * 各协议的默认端口。
 *
 * 有这张表，现场粘一个 `mqtts://broker.example.com` 进来就能直接用；
 * 没有的话要么退化成端口 0（连不上还不说为什么），要么强迫人去查默认端口。
 */
const DEFAULT_PORTS: Record<string, number> = {
  'mqtt:': 1883, 'mqtts:': 8883, 'tcp:': 1883, 'ssl:': 8883,
  'ws:': 80, 'wss:': 443, 'http:': 80, 'https:': 443,
};

export function parseEndpoint(raw: string): { host: string; port: number } {
  const value = raw.trim();
  if (value === '') throw new Error('探测目标不能为空');

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    const port = url.port !== '' ? Number(url.port) : DEFAULT_PORTS[url.protocol];
    if (!port) throw new Error(`无法确定 ${value} 的端口，请写成 host:port`);
    return { host: url.hostname, port };
  }

  // 裸 IPv6 要带方括号才分得清冒号是分隔符还是地址的一部分
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!m) throw new Error(`探测目标格式不对：${value}（应为 host:port 或带协议的 URL）`);
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口越界：${m[2]}`);
  }
  return { host: m[1]!, port };
}
