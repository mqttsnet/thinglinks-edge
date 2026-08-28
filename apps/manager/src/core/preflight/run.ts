/**
 * 安装自检的编排与报告（T6.2）。
 *
 * 十项检查按 `03-复杂网络环境适配.md` 第 3 节的表格，**等级由规格定，不由这里判**。
 * 第十项「出网代理」补的是 2.10 —— 只有企业代理能出网的现场，
 * 装完才发现不通的代价最高，必须在装之前查。
 *
 * 两条编排原则：
 *
 *   1. **一项失败不影响其他项**。自检最没用的形态是「第一项挂了、剩下八项没跑」——
 *      现场只能修一项跑一次，来回好几轮。所以每项都各自 try 住。
 *   2. **报告可导出**（规格要求，作为交付材料的一部分）。所以既给结构化
 *      JSON，也给一份人能直接看的文本。
 */
import { checkDockerAvailable, checkArchMatch, checkCgroupMemory, checkNetworkConflict }
  from './docker.ts';
import { checkPorts, checkDisk, checkClock } from './host.ts';
import { checkExternalUrl, checkCertificate } from './endpoint.ts';
import { checkProxy } from './proxy.ts';
import { readProxySettings, type ProxySettings } from '../proxy.ts';
import { skip, summarize, type CheckResult, type PreflightReport } from './types.ts';

export interface PreflightInput {
  externalUrl: string;
  listenAddr: string;
  listenPort: number;
  dataDir: string;
  portRange: { min: number; max: number };
  /** 白名单里的实例镜像，用于架构核对 */
  images: readonly string[];
  /** 企业内网网段，用于网段冲突比对；留空则该项跳过 */
  corporateCidrs: readonly string[];
  ntpServer: string;
  /** 出网代理设置；不传则现读环境变量 */
  proxy?: ProxySettings;
  /** 平台必须绕过代理的内部目标 */
  internalHosts?: { managerContainer: string; instancePrefix: string; network: string };
  /** 云连接是否已配置 —— 配了才提醒「MQTT 不走 HTTP 代理」 */
  cloudConfigured?: boolean;
  /** dockerode 实例；连不上时传 undefined，相关项会如实跳过 */
  docker?: {
    version(): Promise<Record<string, unknown>>;
    info(): Promise<Record<string, unknown>>;
    listNetworks(): Promise<Array<Record<string, unknown>>>;
    getImage(name: string): { inspect(): Promise<Record<string, unknown>> };
  } | undefined;
  hostStats: () => Promise<{
    diskTotalGb: number | null; diskUsedGb: number | null; diskPercent: number | null;
  }>;
  timeoutMs?: number;
}

/** 单项失败不该带垮整份报告 —— 见文件头第 1 条 */
async function attempt(
  id: string, name: string, fn: () => Promise<CheckResult | CheckResult[]>,
): Promise<CheckResult[]> {
  try {
    const r = await fn();
    return Array.isArray(r) ? r : [r];
  } catch (e) {
    return [skip(id, name, `检查本身出错：${(e as Error).message}`)];
  }
}

/**
 * 把 dockerode 实例适配成自检需要的最小形状。
 *
 * dockerode 的方法都带 callback 重载（`version(cb)` / `version()`），
 * 结构类型对不上纯 Promise 的签名。**强转集中在这一个函数里** ——
 * 散在各个检查项里既难看又容易在某处漏掉，而漏掉的表现是运行时 undefined。
 */
export function adaptDocker(raw: {
  version: (...a: never[]) => unknown;
  info: (...a: never[]) => unknown;
  listNetworks: (...a: never[]) => unknown;
  getImage: (name: string) => { inspect: (...a: never[]) => unknown };
}): NonNullable<PreflightInput['docker']> {
  return {
    version: () => (raw.version as () => Promise<Record<string, unknown>>)(),
    info: () => (raw.info as () => Promise<Record<string, unknown>>)(),
    listNetworks: () =>
      (raw.listNetworks as () => Promise<Array<Record<string, unknown>>>)(),
    getImage: (name) => ({
      inspect: () =>
        (raw.getImage(name).inspect as () => Promise<Record<string, unknown>>)(),
    }),
  };
}

export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const t = input.timeoutMs ?? 5_000;
  const checks: CheckResult[] = [];
  const d = input.docker;

  if (d) {
    checks.push(...await attempt('docker.available', 'Docker 版本与可用性',
      () => checkDockerAvailable(d)));
    checks.push(...await attempt('docker.arch', '架构与镜像匹配',
      () => checkArchMatch(d, input.images)));
    checks.push(...await attempt('docker.cgroup-memory', 'cgroup 内存限制可用性',
      () => checkCgroupMemory(d)));
    checks.push(...await attempt('docker.network-conflict', 'Docker 网段与内网冲突',
      () => checkNetworkConflict(d, input.corporateCidrs)));
  } else {
    for (const [id, name] of [
      ['docker.available', 'Docker 版本与可用性'],
      ['docker.arch', '架构与镜像匹配'],
      ['docker.cgroup-memory', 'cgroup 内存限制可用性'],
      ['docker.network-conflict', 'Docker 网段与内网冲突'],
    ] as const) {
      checks.push(skip(id, name, '未提供 Docker 端点，跳过'));
    }
  }

  checks.push(...await attempt('host.port', '端口占用',
    () => checkPorts(input.listenAddr, input.listenPort, input.portRange)));
  checks.push(...await attempt('host.disk', '磁盘可用空间',
    async () => checkDisk(await input.hostStats(), input.dataDir)));
  checks.push(...await attempt('host.clock', '系统时钟偏差',
    () => checkClock(input.ntpServer, t)));
  checks.push(...await attempt('endpoint.reachable', 'EXTERNAL_URL 可达性',
    () => checkExternalUrl(input.externalUrl, t)));
  checks.push(...await attempt('endpoint.certificate', '证书有效性与有效期',
    () => checkCertificate(input.externalUrl, t)));
  checks.push(...await attempt('network.proxy', '出网代理可用性',
    () => checkProxy({
      proxy: input.proxy ?? readProxySettings(),
      internal: input.internalHosts
        ?? { managerContainer: '', instancePrefix: 'tle-nr-', network: 'thinglinks-edge' },
      cloudConfigured: input.cloudConfigured ?? false,
      timeoutMs: t,
    })));

  return summarize(checks);
}

/**
 * 把报告渲染成可直接贴进交付材料的文本。
 *
 * 阻断项排在最前 —— 现场看报告时最先要看的是「能不能装」，
 * 而不是从头顺着读到第七行才发现有个阻断。
 */
export function renderReport(r: PreflightReport): string {
  const icon = (c: CheckResult) =>
    c.status === 'pass' ? '✓'
      : c.status === 'skip' ? '−'
        : c.severity === 'block' ? '✗' : '!';
  const rank = (c: CheckResult) =>
    c.status === 'fail' && c.severity === 'block' ? 0
      : c.status === 'fail' ? 1
        : c.status === 'skip' ? 2 : 3;

  const lines = [
    '════ ThingLinks Edge 安装自检 ════',
    `生成于 ${r.generatedAt}`,
    r.ok
      ? `结论：可以安装（${r.warnings} 项告警 · ${r.skipped} 项未检查）`
      : `结论：**不建议安装** —— ${r.blocking} 项阻断 · ${r.warnings} 项告警 · ${r.skipped} 项未检查`,
    '',
  ];
  for (const c of [...r.checks].sort((a, b) => rank(a) - rank(b))) {
    lines.push(`${icon(c)} ${c.name}`);
    lines.push(`    ${c.detail}`);
  }
  if (r.skipped > 0) {
    lines.push('',
      '注：「−」是**未检查**，不等于通过。跳过的原因写在每项后面，',
      '    多数需要部署方补充信息（NTP 服务器、企业内网网段）才能检查。');
  }
  return lines.join('\n') + '\n';
}
