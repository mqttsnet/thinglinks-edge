/**
 * 组合探测（T4.5）—— 把 DNS 与 TCP 两步串起来给一个可读结论。
 *
 * 分两步报是有意的：只回一个「不通」没法定位，而「域名解析不出来」和
 * 「解析出来了但端口拒绝」是完全不同的两类故障，处理方式也不同。
 *
 * 单个探针在 ./dns.ts ./tcp.ts ./ntp.ts，各自可以单独用；
 * 这里只负责编排与措辞，不含任何网络细节。
 */
import { resolveHost } from './dns.ts';
import { tcpProbe } from './tcp.ts';
import { parseEndpoint } from './endpoint.ts';
import { DEFAULT_TIMEOUT_MS, type EndpointProbe } from './types.ts';

export async function probeEndpoint(
  raw: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<EndpointProbe> {
  const { host, port } = parseEndpoint(raw);
  const dns = await resolveHost(host, timeoutMs);
  if (!dns.ok) {
    return {
      target: `${host}:${port}`, dns, tcp: null,
      summary: `域名 ${host} 解析失败：${dns.error ?? '无记录'}`,
    };
  }
  const tcp = await tcpProbe(host, port, timeoutMs);
  return {
    target: `${host}:${port}`,
    dns,
    tcp,
    summary: tcp.ok
      ? `${host}:${port} 可达，握手 ${tcp.elapsedMs}ms（解析到 ${dns.addresses[0]}）`
      : `${host}:${port} 不可达：${tcp.error ?? '未知原因'}`
        + `（域名解析到 ${dns.addresses.join(' ')}，若这个地址明显不对，`
        + '多半是本机 DNS 被代理或运营商劫持了）',
  };
}
