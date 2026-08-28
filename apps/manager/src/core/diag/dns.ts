/**
 * DNS 解析探针（T4.5）。
 *
 * 用 `lookup` 而不是 `resolve4`：前者走系统解析器（/etc/hosts、容器 DNS、
 * systemd-resolved 都算数），后者只查 DNS 服务器。现场「hosts 里写死了」
 * 是很常见的做法，用 resolve4 会把这种正常配置报成解析失败。
 *
 * **注意「解析成功」是个比看上去弱的信号**：运营商通配 DNS 与本机代理工具的
 * fake-IP 模式都会让**任何**域名都解析出地址（开发机上实测，随手编的域名
 * 返回 198.18.1.140，那是 RFC 2544 的测试网段）。所以判断连通性必须看
 * TCP 那一步，不能停在 DNS 成功上 —— 停在那儿会得出「域名没问题」的错误结论。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { DEFAULT_TIMEOUT_MS, type DnsResult } from './types.ts';

/** 主机名是不是已经是个 IP —— 是的话跳过 DNS，省一次没意义的查询 */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** 给 promise 加超时。DNS 的原生超时不可控，只能在外面兜 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export async function resolveHost(
  host: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DnsResult> {
  const started = Date.now();
  if (isIpLiteral(host)) {
    return { host, ok: true, addresses: [host], elapsedMs: 0 };
  }
  try {
    const records = await withTimeout(
      dnsLookup(host, { all: true }),
      timeoutMs,
      `DNS 解析超时（${timeoutMs}ms）`,
    );
    if (records.length === 0) {
      // lookup 成功但零条记录：必须给出原因，否则界面上就是个没有解释的红叉
      return {
        host, ok: false, addresses: [], elapsedMs: Date.now() - started,
        error: '解析器返回了空记录集',
      };
    }
    return {
      host, ok: true,
      addresses: records.map((r) => r.address),
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return {
      host, ok: false, addresses: [], elapsedMs: Date.now() - started,
      error: (e as Error).message,
    };
  }
}
