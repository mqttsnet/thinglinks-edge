/**
 * 出网代理自检（T6.2 补齐 · `03-复杂网络环境适配.md` 2.10）。
 *
 * 现场只有企业代理能出网时，装完常见三种「看起来配了却不通」：
 *
 *   1. 代理地址写错或不通 —— 表现是升级检查、镜像拉取一律卡住超时
 *   2. `NO_PROXY` 漏了容器名与内网段 —— **内部通信被绕去代理**，
 *      表现是反代 502、探针不通，而代理日志里只有解析不了的主机名
 *   3. 以为配了代理云连接就能通 —— 云连接是 MQTT，**HTTP 代理管不了它**
 *
 * 三条都在装之前查一次，比装完在现场逐个试便宜得多。
 */
import { connect as tcpConnect } from 'node:net';
import { proxyConfigured, parseProxyUrl, proxyHasCredentials, type ProxySettings }
  from '../proxy.ts';
import { pass, fail, skip, type CheckResult } from './types.ts';

const ID = 'network.proxy';
const NAME = '出网代理可用性';

/** 只测 TCP 可达。要不要能 CONNECT 出去由代理策略决定，那不是安装期能判的 */
function probe(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port });
    const done = (err?: string) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(err);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(undefined));
    sock.once('timeout', () => done(`连接 ${host}:${port} 超时（${timeoutMs}ms）`));
    sock.once('error', (e) => done(`连接 ${host}:${port} 失败：${(e as Error).message}`));
  });
}

export interface ProxyCheckInput {
  proxy: ProxySettings;
  /** 平台必须绕过代理的内部目标，用于核对 NO_PROXY */
  internal: { managerContainer: string; instancePrefix: string; network: string };
  /** 云连接是否已配置 —— 配了才提醒 MQTT 不走代理这件事 */
  cloudConfigured: boolean;
  timeoutMs?: number;
}

export async function checkProxy(input: ProxyCheckInput): Promise<CheckResult> {
  const { proxy, internal } = input;
  const timeout = input.timeoutMs ?? 5_000;

  if (!proxyConfigured(proxy)) {
    return skip(ID, NAME,
      '未配置 HTTP_PROXY / HTTPS_PROXY —— 离线部署即此形态，属正常。'
      + '若本站点必须经企业代理出网，请在 .env 里配置后重跑自检');
  }

  const url = proxy.httpsProxy || proxy.httpProxy;
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) {
    return fail(ID, NAME, 'block', `代理地址不可用：${parsed.reason}`, { url });
  }

  const err = await probe(parsed.host, parsed.port, timeout);
  const data: Record<string, unknown> = {
    httpProxy: proxy.httpProxy, httpsProxy: proxy.httpsProxy,
    noProxy: proxy.noProxy, host: parsed.host, port: parsed.port,
    credentialsInUrl: proxyHasCredentials(url),
  };
  if (err) {
    return fail(ID, NAME, 'block',
      `${err}。代理不通时对外请求会一路卡到超时，而不是立刻报错 —— 先让网管确认地址与放行`,
      data);
  }

  /*
   * NO_PROXY 的内部条目由平台在注入实例时补齐，这里核对的是**部署方自己填的那份**。
   * 缺了不阻塞安装（平台会补），但要让人知道：宿主上直接跑的命令
   * （curl、npm、docker）用的是部署方填的那份，平台补不到。
   */
  const listed = proxy.noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const want = [internal.managerContainer, internal.instancePrefix, internal.network, 'localhost']
    .filter((v) => v !== '');
  const missing = want.filter((v) => !listed.includes(v.toLowerCase()));

  const notes: string[] = [
    `代理 ${parsed.host}:${parsed.port} 可达`,
    // 实测：Node 的内置代理即使目标是 http:// 也走 CONNECT 隧道。
    // 只放行 443 CONNECT 的企业策略会挡掉升级检查，而现场看到的只是「检查更新超时」
    '对外请求走 CONNECT 隧道（目标是 http 也一样），代理需放行到目标端口的 CONNECT',
  ];
  if (missing.length > 0) {
    notes.push(
      `NO_PROXY 未包含 ${missing.join('、')} —— 平台注入实例时会自动补上，`
      + '但宿主上手动执行的 curl / npm / docker 命令仍会把内部地址送去代理',
    );
  }
  if (input.cloudConfigured) {
    notes.push('云连接是 MQTT，不经 HTTP 代理：需要防火墙直接放行 broker 端口，否则只有云连接连不上');
  }
  if (data['credentialsInUrl'] === true) {
    notes.push('代理地址内嵌了账号口令，它会随环境变量进入实例容器与进程列表');
  }
  /*
   * 回环地址的代理在容器里指的是**容器自己**，不是宿主。
   * 现场把宿主上跑的代理（常见 127.0.0.1:7890）直接填进来时，
   * 自检在宿主上跑是通的、装进容器就全超时 —— 这条必须提前说。
   */
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.host);
  if (loopback) {
    notes.push(
      `代理填的是回环地址 ${parsed.host} —— 容器里的回环指向容器自身，`
      + '宿主上跑的代理要改用宿主内网 IP（或 host.docker.internal）',
    );
    data['loopbackProxy'] = true;
  }

  // 有提醒时报 warn：能装，但现场很可能踩坑（severity 的定义见 types.ts）
  const hasWarning = missing.length > 0 || input.cloudConfigured
    || data['credentialsInUrl'] === true || loopback;
  return hasWarning
    ? fail(ID, NAME, 'warn', notes.join('；'), data)
    : pass(ID, NAME, notes.join('；'), data);
}
