/**
 * `EXTERNAL_URL` 可达性与证书自检（T6.2）。
 *
 * **这两项有一个必须讲清楚的能力边界**：Manager 跑在容器里，而
 * `EXTERNAL_URL` 是**给外面用的**地址 —— 现场可能是宿主 IP、企业反代的域名、
 * 甚至 NAT 之后的公网地址。容器内连不上它是**常态而非故障**。
 *
 * 所以这两项一律是 `warn` 级，并且失败时的措辞要说清「连不上不一定有问题，
 * 但连得上能排除一批问题」。写成阻断会让一大批正常部署卡在自检上，
 * 那时候人会直接跳过自检 —— 自检就废了。
 */
import { connect as tlsConnect } from 'node:tls';
import { probeEndpoint } from '../diag/probe.ts';
import { parseEndpoint } from '../diag/endpoint.ts';
import { pass, fail, skip, type CheckResult } from './types.ts';

/** 证书剩余有效期低于这个值就告警 —— 留出申请与更换的时间 */
const CERT_WARN_DAYS = 30;

/** EXTERNAL_URL 可达性自测 —— 失败**告警** */
export async function checkExternalUrl(
  externalUrl: string, timeoutMs = 5_000,
): Promise<CheckResult> {
  const id = 'endpoint.reachable';
  const name = 'EXTERNAL_URL 可达性';
  let target: { host: string; port: number };
  try {
    target = parseEndpoint(externalUrl);
  } catch (e) {
    return fail(id, name, 'warn', `EXTERNAL_URL 解析不了：${(e as Error).message}`);
  }
  const r = await probeEndpoint(`${target.host}:${target.port}`, timeoutMs);
  const data = { externalUrl, ...target, dns: r.dns, tcp: r.tcp } as unknown as Record<string, unknown>;
  return r.tcp?.ok
    ? pass(id, name, `从容器内可达 ${r.target}`, data)
    : fail(id, name, 'warn',
        `${r.summary}。**容器内连不上外部地址是常态**（那是给外面用的地址，`
        + '可能要经过宿主端口映射或企业反代），不一定是故障；'
        + '但请从**现场浏览器**实际打开一次确认', data);
}

/**
 * 证书有效性与有效期 —— 失败**告警**。
 *
 * 只在 `EXTERNAL_URL` 是 https 时才有意义；http 部署直接跳过。
 * 注意这里读的是**外层反代出示的证书** —— Manager 自己不终结 TLS
 * （见 03 号文 2.5/2.6），所以证书归外层管，我们只负责发现它快过期了。
 */
export function checkCertificate(
  externalUrl: string, timeoutMs = 5_000,
): Promise<CheckResult> {
  const id = 'endpoint.certificate';
  const name = '证书有效性与有效期';
  let url: URL;
  try {
    url = new URL(externalUrl);
  } catch {
    return Promise.resolve(skip(id, name, `EXTERNAL_URL 不是合法 URL：${externalUrl}`));
  }
  if (url.protocol !== 'https:') {
    return Promise.resolve(skip(id, name,
      `EXTERNAL_URL 是 ${url.protocol}//，没有 TLS 证书可查。`
      + '现场若走公网，建议在外层反代上启用 HTTPS'));
  }

  const host = url.hostname;
  const port = url.port === '' ? 443 : Number(url.port);

  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    const done = (r: CheckResult) => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };

    const socket = tlsConnect({
      host, port, servername: host,
      /*
       * 不校验证书链：自检要**看得见**自签名证书的有效期，
       * 而不是在握手阶段就被拒掉什么都读不到。
       * 校验结果单独由 authorized 字段报告，不影响读取。
       */
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) {
        done(fail(id, name, 'warn', `${host}:${port} 握手成功但拿不到证书信息`));
        return;
      }
      const notAfter = Date.parse(cert.valid_to);
      const days = Math.floor((notAfter - Date.now()) / 86_400_000);
      const data = {
        host, port, subject: cert.subject?.CN ?? '', issuer: cert.issuer?.CN ?? '',
        validFrom: cert.valid_from, validTo: cert.valid_to, daysLeft: days,
        authorized: socket.authorized,
        authorizationError: socket.authorized ? '' : String(socket.authorizationError ?? ''),
      };
      if (Number.isNaN(notAfter)) {
        done(fail(id, name, 'warn', `证书有效期读不出来（valid_to=${cert.valid_to}）`, data));
      } else if (days < 0) {
        done(fail(id, name, 'warn',
          `证书已于 ${cert.valid_to} 过期（${-days} 天前）。浏览器会拦截，现场打不开控制台`, data));
      } else if (days < CERT_WARN_DAYS) {
        done(fail(id, name, 'warn',
          `证书 ${days} 天后过期（${cert.valid_to}）。离线现场换证要提前安排，别等到过期当天`, data));
      } else {
        const selfSigned = !socket.authorized;
        done(pass(id, name,
          `${cert.subject?.CN ?? host} 有效期至 ${cert.valid_to}（还有 ${days} 天）`
          + (selfSigned ? ` · 自签名/链不完整：${data.authorizationError}，浏览器会提示不安全` : ''),
          data));
      }
    });
    socket.once('timeout', () => done(fail(id, name, 'warn',
      `连接 ${host}:${port} 超时（${timeoutMs}ms），读不到证书`)));
    socket.once('error', (e: Error) => done(fail(id, name, 'warn',
      `连接 ${host}:${port} 失败：${e.message}。容器内连不上外部地址是常态，`
      + '请从现场浏览器确认证书是否正常')));
  });
}
