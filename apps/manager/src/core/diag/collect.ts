/**
 * 诊断包组装（T4.5）。
 *
 * 验收标准只有一条，但它是硬的：**导出后 grep 检索包内无明文凭据**。
 *
 * 因此这里的结构是「收集 → 脱敏 → **自检** → 打包」，四步缺一不可。
 * 第三步 `assertNoSecrets` 是最后一道闸：脱敏逻辑再周全，也挡不住以后有人
 * 往包里加一个新字段而忘了脱敏。自检失败就**拒绝导出**，而不是带着凭据发出去 ——
 * 诊断包最常见的去向是发给外部支持人员，漏一次就是真的漏了。
 *
 * 收集范围刻意只覆盖「排障真正需要的」：
 *   · 配置与版本  —— 判断现场跑的到底是什么
 *   · 实例与健康  —— 判断是哪一层坏了
 *   · 网络与时钟  —— 判断是不是环境问题（时钟偏差会伪装成签名错误）
 *   · 云链路与缓存 —— 判断数据丢没丢
 *   · 审计与日志  —— 判断出事前发生过什么
 *
 * 不收集的：数据库原始文件、实例流程内容、点位历史值。它们体积大、含业务机密，
 * 而且对「为什么不工作」这个问题几乎没有帮助。真要看流程用备份接口，那条路径有独立授权。
 */
import { tarArchive, type TarEntry } from '../archive/tar.ts';
import { redactValue, redact, assertNoSecrets, MASK } from './redact.ts';
import { probeEndpoint } from './probe.ts';
import { readClock } from './ntp.ts';
import type { ClockResult } from './types.ts';
import type { EdgeConfig } from '../config.ts';
import type { Db } from '../db.ts';

/** 诊断包版本。结构变了要加一，支持人员据此知道该按哪版解读 */
export const BUNDLE_VERSION = 1;

export interface DiagSource {
  config: EdgeConfig;
  db: Db;
  /** 实例列表与健康。取不到就如实缺省，不因为一处失败让整包出不来 */
  instances: () => Promise<unknown>;
  health: () => Promise<unknown>;
  hostStats: () => Promise<unknown>;
  /** 每个实例的日志尾巴 */
  logs: (id: string, tail: number) => Promise<string>;
  /** 云链路状态与断网缓存指标，没接云时给 null */
  cloudStatus: () => unknown;
  spoolMetrics: () => Promise<unknown>;
  /** 运行时确实持有的秘密，用于按值脱敏与最后自检 */
  secrets: () => (string | undefined)[];
}

export interface DiagOptions {
  actor: string;
  /** 每个实例取多少行日志。行数越多包越大，默认够看一次故障前后 */
  logTail?: number;
  /** 要探测的地址；留空则只探云 broker（若已配置） */
  probeTargets?: string[];
  /** SNTP 服务器，留空表示不发起对时查询 */
  ntpServer?: string;
  /** 探针超时 */
  timeoutMs?: number;
}

export interface DiagManifest {
  bundleVersion: number;
  generatedAt: string;
  generatedBy: string;
  product: string;
  version: string;
  files: string[];
  /** 收集过程中失败的部分。**必须如实列出**，否则读包的人会把缺失当成正常 */
  failures: Array<{ item: string; error: string }>;
}

/** 单项收集失败不该让整包出不来 —— 缺一块总比一点都没有强 */
async function attempt<T>(
  item: string,
  fn: () => Promise<T> | T,
  failures: DiagManifest['failures'],
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failures.push({ item, error: (e as Error).message });
    return null;
  }
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/**
 * 配置快照。
 *
 * 逐字段挑，不是整个 config 倒出来 —— 那样以后往 EdgeConfig 里加一个敏感字段，
 * 就会**自动**出现在诊断包里，而没人会注意到。白名单让新增字段默认不外泄。
 */
function configSnapshot(c: EdgeConfig): Record<string, unknown> {
  return {
    externalUrl: c.externalUrl,
    basePath: c.basePath,
    cookieSecure: c.cookieSecure,
    allowedOrigins: c.allowedOrigins,
    listenAddr: c.listenAddr,
    listenPort: c.listenPort,
    dataRoot: c.dataRoot,
    dataDir: c.dataDir,
    instanceDataRoot: c.instanceDataRoot,
    portRange: c.portRange,
    timezone: c.timezone,
    // 只说配没配，不回地址本身——它可能带内网主机名
    updateCheckConfigured: c.updateCheckUrl !== '',
  };
}

/** 运行环境快照。Node 版本与平台是「同样的包在这台机器上表现不同」的第一嫌疑 */
function runtimeSnapshot(): Record<string, unknown> {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    memoryUsage: process.memoryUsage(),
    /*
     * 环境变量只报**名字**，不报值：值里几乎必然有 MASTER_KEY。
     *
     * 字段名刻意叫 envVarNames 而不是 envKeys —— redactValue 按键名匹配
     * `/pass|pwd|secret|token|key|.../i`，叫 envKeys 会命中 `key` 从而
     * 被整个数组抹成掩码。那个匹配规则是对的（宁可错杀），该改的是这里的命名。
     */
    envVarNames: Object.keys(process.env).sort(),
  };
}

/** 最近的审计记录。出事前谁动过什么，这张表是唯一答案 */
function recentAudit(db: Db, limit: number): unknown[] {
  return db
    .prepare('SELECT id, actor, action, target, detail, result, ts FROM audit ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown[];
}

/**
 * 收集并打包。返回 tar 字节流。
 *
 * 自检不通过时**抛错**，调用方应把这当成失败而不是降级 ——
 * 「导出了一个可能含凭据的包」比「没导出」危险得多。
 */
export async function collectDiagnostics(
  source: DiagSource,
  opts: DiagOptions,
): Promise<{ archive: Buffer; manifest: DiagManifest }> {
  const failures: DiagManifest['failures'] = [];
  const secrets = source.secrets();
  const r = <T>(v: T) => redactValue(v, { secrets });
  const logTail = opts.logTail ?? 500;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const entries: TarEntry[] = [];
  const add = (name: string, content: string) => {
    entries.push({ name, content, mode: 0o600 });
  };

  // ── 配置与运行环境 ────────────────────────────────
  add('config.json', json(r(configSnapshot(source.config))));
  add('runtime.json', json(r(runtimeSnapshot())));

  // ── 实例与健康 ────────────────────────────────────
  const instances = await attempt('instances', source.instances, failures);
  if (instances !== null) add('instances.json', json(r(instances)));
  const health = await attempt('health', source.health, failures);
  if (health !== null) add('health.json', json(r(health)));
  const host = await attempt('hostStats', source.hostStats, failures);
  if (host !== null) add('host.json', json(r(host)));

  // ── 云链路与断网缓存 ──────────────────────────────
  const cloud = await attempt('cloudStatus', () => source.cloudStatus(), failures);
  const spool = await attempt('spoolMetrics', source.spoolMetrics, failures);
  add('cloud.json', json(r({
    status: cloud,
    spool,
    note: '云平台是否真正可用以 status.state 为准。'
      + '网络探针能证否不能证真——透明代理会让 TCP 探测误报可达。',
  })));

  // ── 网络与时钟 ────────────────────────────────────
  const targets = new Set(opts.probeTargets ?? []);
  // 没显式指定就探云 broker：这是现场最常问的那一个
  const brokerUrl = (cloud as { brokerUrl?: string } | null)?.brokerUrl;
  if (targets.size === 0 && brokerUrl) targets.add(brokerUrl);

  const probes = [];
  for (const t of targets) {
    const p = await attempt(`probe:${t}`, () => probeEndpoint(t, timeoutMs), failures);
    if (p !== null) probes.push(p);
  }
  add('network.json', json(r({
    probes,
    note: targets.size === 0
      ? '未指定探测目标，且未配置云对接，故未做连通性探测'
      : '「可达」只代表 TCP 握手成功，不代表对端就是预期的服务',
  })));

  const clock = await attempt<ClockResult>(
    'clock', () => readClock(opts.ntpServer ?? '', timeoutMs), failures);
  if (clock !== null) {
    add('clock.json', json({
      ...clock,
      note: clock.note + '｜时钟偏差过大会让云侧验签失败，'
        + '表现与 signKey 填错完全一样（连接正常但数据不进库）',
    }));
  }

  // ── 审计 ──────────────────────────────────────────
  const audit = await attempt('audit', () => recentAudit(source.db, 500), failures);
  if (audit !== null) add('audit.json', json(r(audit)));

  // ── 日志 ──────────────────────────────────────────
  const ids = Array.isArray(instances)
    ? (instances as Array<{ id?: unknown }>).map((i) => String(i.id ?? '')).filter(Boolean)
    : [];
  for (const id of ids) {
    const text = await attempt(`logs:${id}`, () => source.logs(id, logTail), failures);
    if (text !== null) add(`logs/${id}.log`, redact(text, { secrets }));
  }

  // ── 清单 ──────────────────────────────────────────
  const manifest: DiagManifest = {
    bundleVersion: BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: opts.actor,
    product: 'ThingLinks Edge Manager',
    version: process.env['IMAGE_VERSION'] ?? 'unknown',
    // 把 manifest.json 自己也算进去 —— 清单漏掉自己会让「清单 vs 实际」
    // 永远差一个，每次核对都要在脑子里减一，纯属给人添乱
    files: [...entries.map((e) => e.name), 'manifest.json'].sort(),
    failures,
  };
  /*
   * 清单也要过脱敏 —— 这条曾经漏过。
   *
   * `failures[].error` 装的是异常消息，而异常消息最爱把连接串原样吐出来
   * （`connect ECONNREFUSED mqtt://user:pass@host`）。不脱敏的话，
   * 一次探测失败就能把凭据带进包里；那时下面的自检会直接**拒绝导出**，
   * 于是「网络有点问题」升级成「诊断包根本导不出来」，排障反而更难。
   */
  const safeManifest = redactValue(manifest, { secrets }) as DiagManifest;
  // 清单排在最前：解包的人第一眼要看到「这包里有什么、哪块没收上来」
  entries.unshift({ name: 'manifest.json', content: json(safeManifest), mode: 0o600 });

  /*
   * 最后一道闸。扫的是**即将写进包里的全部内容**，不是某个字段。
   *
   * 注意要扫拼接后的整体：单个文件各自脱敏都对，也可能因为某个字段是
   * 我们没预料到的形态而漏网。这里一次性兜住。
   *
   * 一个**已知会漏到这一层**的形态：秘密出现在对象的**键名**里
   * （比如以接入令牌为 key 的映射）。`redactValue` 只脱敏值不动键名 ——
   * 键名一改结构就坏了，读包的人反而看不懂。所以那种情况按设计就是
   * 走到这里被拦下：拒绝导出，让人回去把那个数据结构改掉，
   * 而不是导出一个键名里带凭据的包。
   */
  const whole = entries.map((e) => `${e.name}\n${e.content}`).join('\n');
  assertNoSecrets(whole, secrets);

  return { archive: tarArchive(entries), manifest };
}

/** 供上层展示与测试断言：包里出现这个串就说明脱敏生效了 */
export { MASK };
