/**
 * ThingLinks Edge Manager —— 入口。
 *
 * 当前阶段只做 Node-RED 多实例这条垂直切片，兄弟容器模式。
 * 其余能力（南向接入、云边协同、告警）按实施计划后置。
 */
import { loadConfig } from './core/config.ts';
import { openDb } from './core/db.ts';
import { requireMasterKey, deriveKey } from './core/auth/crypto.ts';
import { AuthService } from './core/auth/service.ts';
import { InstanceRepo } from './core/instance/repo.ts';
import { InstanceService, type InstanceServiceOptions } from './core/instance/service.ts';
import {
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
} from './core/instance/operation-gate.ts';
import { ProxySessionRegistry } from './core/instance/proxy-session-registry.ts';
import { DockerClient } from './core/instance/docker-client.ts';
import { containerName } from './core/instance/container-spec.ts';
import {
  RepositoryInstanceAdminRuntime,
  type InstanceAdminRuntime,
} from './core/instance/admin-runtime.ts';
import { reconcileInstanceNetworks } from './core/instance/network-reconcile.ts';
import { buildServer, type ServerDeps } from './http/app.ts';
import { Spool, type FullPolicy } from './core/spool/spool.ts';
import { SpoolDrainer } from './core/spool/drainer.ts';
import { CloudConfigRepo } from './core/cloud/config-repo.ts';
import { CloudRuntime } from './core/cloud/runtime.ts';
import { OutageLog } from './core/cloud/outage.ts';
import { runPreflight, renderReport, adaptDocker } from './core/preflight/run.ts';
import { readHostStats } from './core/health/host-stats.ts';
import { MetricsHistory, MetricsSampler } from './core/health/metrics-history.ts';
import { NodeStore } from './core/nodes/store.ts';
import { NodeCatalog } from './core/nodes/catalog.ts';
import { buildPolicy, installModeFromEnv } from './core/nodes/policy.ts';
import { UpstreamRegistry } from './core/nodes/upstream.ts';
import { NpmSourceRepo } from './core/nodes/sources.ts';
import { seedFromDir, describeSeed } from './core/nodes/seed.ts';
import { PlatformPackageService } from './core/nodes/platform-package.ts';
import { NOOP_PLATFORM_NODE_BARRIER } from './core/nodes/platform-operation-barrier.ts';
import type { RegistryDeps } from './http/nodes/registry.ts';
import { ValueHistory, limitsFromEnv } from './core/edge/history.ts';
import {
  readProxySettings, proxyConfigured, proxyEnvFor, proxyHasCredentials, missingInternalNoProxy,
} from './core/proxy.ts';
import { recordAudit } from './core/db.ts';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { restoreBackup } from './core/archive/backup.ts';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

// 版本定义搬到 core/version.ts，让 http 层能直接引用而不成环。
// 本文件内部也要用 describe()，所以先 import 再复导出 —— 只写 export…from
// 不会把名字带进本模块作用域。
import { VERSION, describe } from './core/version.ts';
export { VERSION, describe };

/**
 * 装配平台节点包的唯一运行期信任服务。
 *
 * generic seed 必须由调用方先导入；这里随即校验固定字节并建立 Edge 基线批准。
 * 返回的两个依赖片段刻意都持有同一对象，避免 HTTP 层或后续实例服务各造一个
 * 信任根，导致启动校验和请求时校验读到不同状态。
 */
export function assemblePlatformNodeServices(deps: {
  store: NodeStore;
  catalog: NodeCatalog;
}): {
  platformPackages: PlatformPackageService;
  serverDeps: Pick<ServerDeps, 'platformPackages'>;
  registryDeps: Pick<RegistryDeps, 'platformPackages'> & {
    platformPackages: PlatformPackageService;
  };
} {
  const platformPackages = new PlatformPackageService(deps);
  platformPackages.bootstrap('system');
  return {
    platformPackages,
    serverDeps: { platformPackages },
    registryDeps: { platformPackages },
  };
}

export function assembleInstanceAdminRuntime(deps: {
  repo: InstanceRepo;
  upstreamFor: (instanceId: string) => string;
}): {
  adminRuntime: InstanceAdminRuntime;
  instanceServiceDeps: Pick<InstanceServiceOptions, 'adminRuntime'>;
  serverDeps: Pick<ServerDeps, 'adminRuntime'>;
} {
  const adminRuntime = new RepositoryInstanceAdminRuntime(deps);
  return {
    adminRuntime,
    instanceServiceDeps: { adminRuntime },
    serverDeps: { adminRuntime },
  };
}

export interface ManagerStartupHooks<Server = unknown> {
  reconcileNetworks: () => Promise<void>;
  recoverInterruptedBootstraps: () => Promise<void>;
  startBackground: () => Promise<void> | void;
  buildServer: () => Promise<Server> | Server;
  listen: (server: Server) => Promise<void>;
}

export async function startManagerRuntime<Server>(
  hooks: ManagerStartupHooks<Server>,
): Promise<Server> {
  await hooks.reconcileNetworks();
  await hooks.recoverInterruptedBootstraps();
  await hooks.startBackground();
  const server = await hooks.buildServer();
  await hooks.listen(server);
  return server;
}

/**
 * 解析 Manager 自身的容器标识，用于把自己接入每个实例的独立网络。
 *
 * 一实例一网络意味着实例之间互不可达，但 Manager 必须可达每个实例，
 * 否则反代与应用层探针都会解析不到容器名。留空（宿主开发态）时不做接入。
 *
 * 优先取显式配置；容器内未配置时退回 hostname —— Docker 默认把容器短 id
 * 设为 hostname，network connect 接受短 id。若部署时自定义了 hostname，
 * 必须显式给 MANAGER_CONTAINER，否则接入会失败。
 */
function resolveManagerContainer(): string | undefined {
  const explicit = process.env['MANAGER_CONTAINER']?.trim();
  if (explicit) return explicit;
  return existsSync('/.dockerenv') ? hostname() : undefined;
}

/**
 * 解析 docker 端点。
 *
 * 生产形态指向**受限代理**（`tcp://host:2375`），代理只放行 Manager 真正用到的
 * 那十几条 API；未配置时回落到默认 unix socket（宿主开发态）。
 *
 * 这里显式解析而不是依赖 dockerode 对 DOCKER_HOST 的隐式支持：配错了会静默
 * 回落到裸 socket，而「以为走了代理、其实挂着裸 socket」正是这一步要消灭的状态。
 */
function dockerConnection(): { host: string; port: number } | { socketPath: string } | undefined {
  const raw = process.env['DOCKER_HOST']?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DOCKER_HOST 不是合法 URL：${raw}`);
  }
  if (url.protocol === 'tcp:' || url.protocol === 'http:') {
    return { host: url.hostname, port: Number(url.port || '2375') };
  }
  if (url.protocol === 'unix:') return { socketPath: url.pathname };
  throw new Error(`DOCKER_HOST 只支持 tcp:// 或 unix://，收到 ${url.protocol}`);
}

/** 供启动日志用：把端点说清楚，免得「以为连了代理」 */
function describeDockerEndpoint(conn: ReturnType<typeof dockerConnection>): string {
  if (!conn) return '/var/run/docker.sock（默认裸 socket）';
  return 'socketPath' in conn ? `${conn.socketPath}（unix socket）` : `${conn.host}:${conn.port}（受限代理）`;
}

/** 节点集目录。镜像里在 /app/nodes；宿主开发态回落到仓库内的源目录 */
function resolveNodePackageDir(): string | undefined {
  const configured = process.env['TLE_NODE_PACKAGE_DIR']?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  const repoLocal = join(import.meta.dirname, '..', '..', '..', 'packages', 'thinglinks-nodes');
  return existsSync(repoLocal) ? repoLocal : undefined;
}

/**
 * 断网缓存的写满策略。
 *
 * 08 号文第 7 节：这是**业务决策**，不由产品替客户决定 ——
 * 监控类场景丢最旧、追溯类场景丢最新、数据绝不可丢的场景宁可停止采集。
 * 配错了宁可拒绝启动，也不要用一个「看起来合理」的默认值悄悄决定客户的数据取舍。
 */
function resolveFullPolicy(): FullPolicy {
  const raw = (process.env['EDGE_SPOOL_FULL_POLICY'] ?? 'drop-oldest').trim();
  const allowed: FullPolicy[] = ['drop-oldest', 'drop-newest', 'stop-accepting'];
  if (!allowed.includes(raw as FullPolicy)) {
    throw new Error(
      `EDGE_SPOOL_FULL_POLICY 只能是 ${allowed.join(' / ')}，收到 ${raw}`,
    );
  }
  return raw as FullPolicy;
}

/**
 * 指标采样间隔（秒）。0 表示关闭采样 —— 极低配的盒子上，
 * 「不采」是个正当选择，界面会明说趋势未启用，而不是画一张空图。
 *
 * 默认 10 秒：比页面刷新慢一档就够画曲线，又不至于让 docker stats
 * 成为常驻负载（每次采样要为每个实例各取一次容器统计）。
 */
function resolveMetricsIntervalSec(): number {
  const raw = (process.env['EDGE_METRICS_INTERVAL_SEC'] ?? '10').trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 300) {
    throw new Error(`EDGE_METRICS_INTERVAL_SEC 需为 0-300 的整数（0 表示关闭），收到 ${raw}`);
  }
  // 低于 5 秒时探针来不及跑完，采样只会互相跳过，白白压 docker
  if (n > 0 && n < 5) throw new Error('EDGE_METRICS_INTERVAL_SEC 最小 5 秒，再快探针跑不完');
  return n;
}

/**
 * 恢复子命令：`node dist/index.js restore <备份文件> [--force]`
 *
 * 刻意做成 CLI 而不是在线接口：恢复要覆盖正被 Manager 打开的库，
 * 在线做等于自找损坏。正确姿势是停服务 → 恢复 → 再启动。
 */
async function runRestore(argv: string[]): Promise<void> {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('用法：node dist/index.js restore <备份文件> [--force]');
  const config = loadConfig();
  const key = deriveKey(requireMasterKey(), 'thinglinks-edge:instance-cred');
  const archive = await readFile(file);

  const manifest = await restoreBackup({
    archive, dataRoot: config.dataRoot, key,
    ignoreKeyMismatch: argv.includes('--force'),
  });
  console.log(`[restore] 已恢复到 ${config.dataRoot}`);
  console.log(`[restore] 备份时间 ${manifest.createdAt} · schema v${manifest.schemaVersion}`);
  console.log(`[restore] 实例 ${manifest.instances.length} 个：`
    + manifest.instances.map((i) => i.id).join(' '));
  console.log('[restore] 现在可以启动 Manager；实例容器会在下次启动时按记录重建。');
}

/**
 * 安装自检（T6.2 / `03-复杂网络环境适配.md` 第 3 节）。
 *
 * 独立子命令而不是启动时自动跑：**装之前就要能跑**，那时候服务还没起来；
 * 而且现场往往要先跑一遍看结论、改完环境再跑一遍，做成启动副作用就没法这么用。
 *
 *   node dist/index.js preflight            # 人读的报告
 *   node dist/index.js preflight --json     # 结构化，供自动化与交付材料留档
 *
 * 有阻断项时退出码为 1，方便安装脚本 `set -e` 直接卡住。
 */
async function runPreflightCli(argv: string[]): Promise<void> {
  const config = loadConfig();
  const asJson = argv.includes('--json');

  /*
   * Docker 端点连不上不该让自检整个失败 —— 「连不上」正是它要报告的结论之一。
   * 所以这里吞掉构造异常，把 docker 传成 undefined，由检查项如实报「阻断」。
   */
  let docker: DockerClient | undefined;
  try {
    docker = new DockerClient({
      connection: dockerConnection(),
      network: 'tle-preflight', imageRepo: 'nodered/node-red',
      portRange: config.portRange, instanceDataRoot: config.instanceDataRoot,
      timezone: config.timezone,
    });
  } catch { docker = undefined; }

  const report = await runPreflight({
    externalUrl: config.externalUrl,
    listenAddr: config.listenAddr,
    listenPort: config.listenPort,
    dataDir: config.dataDir,
    portRange: config.portRange,
    images: (process.env['ALLOWED_IMAGE_TAGS'] ?? '5.0.4-24-minimal,4.1.13-22-minimal')
      .split(',').map((t) => `nodered/node-red:${t.trim()}`).filter(Boolean),
    corporateCidrs: (process.env['CORPORATE_CIDRS'] ?? '')
      .split(',').map((c) => c.trim()).filter(Boolean),
    ntpServer: process.env['NTP_SERVER']?.trim() ?? '',
    ...(docker ? { docker: adaptDocker(docker.raw) } : {}),
    hostStats: () => readHostStats(config.dataDir),
  });

  process.stdout.write(asJson ? JSON.stringify(report, null, 2) + '\n' : renderReport(report));
  if (!report.ok) process.exitCode = 1;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const key = deriveKey(requireMasterKey(), 'thinglinks-edge:instance-cred');
  const db = openDb(join(config.dataDir, 'edge.db'));

  // 主密钥同时用于两步验证的 TOTP 密钥加密，与实例凭据同一套
  const auth = new AuthService(db, key);
  const repo = new InstanceRepo(db, key);
  const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const proxySessions = new ProxySessionRegistry();
  const instanceUpstreamFor = (id: string) => `http://${containerName(id)}:1880`;
  const instanceAdmin = assembleInstanceAdminRuntime({ repo, upstreamFor: instanceUpstreamFor });

  /*
   * 账号从哪来，两条路：
   *
   *   · 配了 `INITIAL_PASSWORD` —— 无人值守装机用。口令是操作者自己给的，
   *     他本来就知道，**不打印**。
   *   · 没配 —— 什么都不建，等人打开控制台自己定账号和口令（首次设置）。
   *
   * 以前是「随机生成一个、打进启动日志、让用户去 docker logs 里翻」。
   * 那样口令会跟着日志跑：进日志聚合、进备份、进随手截的一张图 ——
   * 诊断包的脱敏模块里专门为它留了一条规则，就是这个原因。
   */
  const initialPassword = process.env['INITIAL_PASSWORD']?.trim();
  if (initialPassword) {
    if (auth.ensureInitialUser('admin', initialPassword)) {
      console.log('[init] 已按 INITIAL_PASSWORD 创建初始账号 admin，首次登录后必须改密。');
    }
  } else if (auth.needsSetup()) {
    console.log(`[init] 这台设备还没有账号，请打开 ${config.externalUrl} 设置管理员账号与口令。`);
  }

  const connection = dockerConnection();
  const managerContainer = resolveManagerContainer();
  /*
   * 出网代理（03 号文 2.10）。Manager 自己出网由 NODE_USE_ENV_PROXY 接管（镜像里已开），
   * 这里负责把变量透传给实例容器 —— 它们装第三方节点时要出网。
   * NO_PROXY 由 proxyEnvFor 补齐内部条目，不能原样透传。
   */
  const proxy = readProxySettings();
  const instanceNetwork = process.env['INSTANCE_NETWORK'] ?? 'thinglinks-edge';
  const proxyEnv = proxyEnvFor(proxy, {
    managerContainer: managerContainer ?? '',
    instancePrefix: 'tle-nr-',
    network: instanceNetwork,
  });
  if (proxyConfigured(proxy)) {
    console.log(`[proxy] 出网走企业代理 ${proxy.httpProxy || proxy.httpsProxy}，已透传给实例容器`);
    if (proxyHasCredentials(proxy.httpProxy) || proxyHasCredentials(proxy.httpsProxy)) {
      // 说出来而不是替客户决定：带认证的代理在企业里很常见，
      // 但口令会随环境变量落进实例容器与进程列表，部署方必须知情
      console.warn('[proxy] 代理地址内嵌了账号口令，它会随环境变量进入实例容器与进程列表');
    }
    console.log('[proxy] 注意：云连接是 MQTT，不经 HTTP 代理，需要防火墙直接放行 broker 端口');
    /*
     * 自己的 NO_PROXY 漏了内部名字是**会把平台弄瘫**的配置错误：
     * 连 docker 端点、反代实例、应用层探针都会被送去企业代理。
     * 这时候只能大声报，改不了 —— 代理规则在进程启动时就定死了。
     */
    const missing = missingInternalNoProxy(proxy, {
      managerContainer: managerContainer ?? '',
      instancePrefix: 'tle-nr-',
      network: instanceNetwork,
    });
    if (missing.length > 0) {
      console.error(
        `[proxy] ⚠ NO_PROXY 缺少内部条目：${missing.join('、')}。`
        + '这会让 Manager 连 docker 端点、反代实例、探针请求全被送去企业代理，'
        + '表现是「创建实例失败：无法查询镜像…ECONNREFUSED <代理地址>」。'
        + '请在 compose 的 NO_PROXY 里补上后重启',
      );
    }
  }

  /*
   * 私有 npm 源（01 号文 5.7）。
   *
   * 两个地址来源不同，别混：
   *   internal —— 实例容器里的 npm 用，靠容器名解析，Manager 非容器时为空
   *   catalogue —— 现场浏览器里的编辑器前端用，与控制台同源，永远是相对路径
   */
  const nodeStore = new NodeStore(join(config.dataDir, 'npm'));
  const nodeCatalog = new NodeCatalog(db);

  /*
   * 预置节点包（01 号文 5.7「离线场景下节点可用」）。两个来源都扫：
   *
   *   <dataDir>/npm-seed  —— bind 挂进来的目录，现场拷个 .tgz 进去重启即可。
   *                          离线现场最需要的就是这条不依赖任何工具的路子。
   *   NODE_SEED_DIR       —— 镜像里随包发的那份（离线安装包用）
   *
   * 只导入进库，**不自动批准** —— 批准是管理员的动作，见 core/nodes/seed.ts。
   */
  for (const seedDir of [join(config.dataDir, 'npm-seed'), process.env['NODE_SEED_DIR'] ?? '']) {
    const line = describeSeed(seedDir, seedFromDir(nodeStore, seedDir));
    if (line) console.log(`[nodes] ${line}`);
  }
  const platformNodeServices = assemblePlatformNodeServices({
    store: nodeStore,
    catalog: nodeCatalog,
  });
  const npmRegistryUrl = managerContainer
    ? `http://${managerContainer}:${config.listenPort}${config.basePath}/npm/`
    : '';
  const nodeCatalogueUrl = `${config.basePath}/npm/-/catalogue.json`;
  // 编辑器公开搜索目录；仅 open 策略会使用，不能拿来作容器 npm registry。
  const publicNodeCatalogueUrl = 'https://catalogue.nodered.org/catalogue.json';

  /*
   * 上游回源与安装策略。两个都在编排文件里配，不放 Web 设置页 ——
   * 一个决定实例能不能出网取包，一个是安全闸门，都该有文件、有版本、有人 review。
   */
  const nodeSources = new NpmSourceRepo(db);
  // 环境变量只作为**全新安装**时的初始值；之后源以库为准，在页面上增删
  nodeSources.seed(process.env['EDGE_NPM_UPSTREAM']?.trim() ?? '');
  const nodeUpstream = new UpstreamRegistry({
    sources: () => nodeSources.active().map((s) => ({ name: s.name, url: s.url })),
  });
  const installMode = installModeFromEnv();
  console.log(
    `[nodes] 安装策略 ${installMode === 'open' ? 'open（不限制）' : 'allowlist（只装已批准）'}`
    + ` · 节点源 ${nodeUpstream.enabled ? nodeUpstream.urls.join(' / ') : '未配置（纯离线，只服务本地库）'}`,
  );

  /*
   * 点位历史（断网期间现场也要能看趋势）。
   *
   * 上限按**条数**不按天数 —— 边缘盒子的硬约束是磁盘与 SD 卡写入量，
   * 只有条数直接对应这两者。EDGE_HISTORY_MAX_ROWS=0 即彻底关闭记录，
   * 给最低配的设备留一条退路。理由详见 core/edge/history.ts。
   */
  const historyLimits = limitsFromEnv();
  const valueHistory = new ValueHistory(db, historyLimits);
  console.log(
    valueHistory.enabled
      ? `[history] 点位历史已启用：上限 ${historyLimits.maxRows} 条 · 恒定信号每 ${historyLimits.minGapSec}s 留一个锚点`
      : '[history] 点位历史未启用（EDGE_HISTORY_MAX_ROWS=0），趋势界面会如实说明',
  );

  const docker = new DockerClient({
    connection,
    network: instanceNetwork,
    imageRepo: process.env['NODE_RED_IMAGE_REPO'] ?? 'nodered/node-red',
    portRange: config.portRange,
    instanceDataRoot: config.instanceDataRoot,
    timezone: config.timezone,
    managerContainer: managerContainer,
    nodePackageDir: resolveNodePackageDir(),
    proxyEnv,
    /*
     * 实例里的 @thinglinks 节点要回报台账，得能找到 Manager。
     * 靠容器名解析，因此只有 Manager 自己也是容器时才给得出地址 ——
     * 宿主开发态留空，节点会打一条警告后只透传不回报。
     */
    managerUrl: managerContainer
      ? `http://${managerContainer}:${config.listenPort}${config.basePath}`
      : undefined,
    npmRegistry: npmRegistryUrl || undefined,
  });
  const service = new InstanceService({
    ...instanceAdmin.instanceServiceDeps,
    db, repo, docker, gate: operationGate,
    instanceDataRoot: config.instanceDataRoot,
    platformPackages: platformNodeServices.platformPackages,
    barrier: NOOP_PLATFORM_NODE_BARRIER,
    basePath: config.basePath,
    portRange: config.portRange,
    allowedImageTags: (process.env['ALLOWED_IMAGE_TAGS'] ??
      '5.0.4-24-minimal,4.1.13-22-minimal').split(',').map((s) => s.trim()).filter(Boolean),
    /*
     * 传函数不传值：批准清单随时会改，而实例配置是在创建、重置口令、
     * 下发策略这几个时刻各自现算的。传值会让服务一直用着进程启动那一刻的
     * 旧清单 —— 而且没有任何症状，只是新批的节点永远装不上。
     */
    palettePolicy: () => buildPolicy(nodeCatalog.approved(), {
      allowInstall: true,
      catalogueUrl: nodeCatalogueUrl,
      publicCatalogueUrl: publicNodeCatalogueUrl,
      mode: installMode,
    }),
  });

  /*
   * 单独重建 Manager 不会重启历史实例，Docker 也不会把新 Manager 自动接回
   * 各实例的私有网络。HTTP 开始服务前并发补接，保证反代和实例侧回报使用的
   * 容器名解析立即可用。每个实例最多等待 5 秒；单个网络可能已被人工清理，
   * 只告警并继续，不能因此阻止控制台启动或影响其它实例的隔离网络。
   */
  const reconcileNetworks = async () => {
    if (managerContainer) {
      const reconciled = await reconcileInstanceNetworks(
        repo.list().map((instance) => instance.id),
        (id, signal) => docker.reconnectManager(id, signal),
        5_000,
      );
      for (const result of reconciled) {
        if (!result.ok) {
          console.warn(
            `[warn] 实例 ${result.id} 的网络 ${docker.instanceNetwork(result.id)} 未能重新接入 Manager：`
            + result.error,
          );
        }
      }
    }
  };

  // WEB_ROOT 由镜像设定（/app/web）；宿主开发态不设，前端走 Vite
  /*
   * 断网缓存。写满时必须产生**严重告警并记审计**（08 号文第 7 节）——
   * 数据取舍这种事发生了却没人知道，是最糟的情况。
   */
  const fullPolicy = resolveFullPolicy();
  /** 同一个磁盘故障原因只告警一次，恢复正常后由下一次不同的原因重置 */
  let lastWriteErrorKey = '';
  const spool = await Spool.open({
    dir: join(config.dataDir, 'spool'),
    maxBytes: Number(process.env['EDGE_SPOOL_MAX_BYTES'] ?? 2 * 1024 * 1024 * 1024),
    fullPolicy,
    /*
     * 落盘失败告警。与 onFull 走同一条通道 —— 早先只有「逻辑写满」会告警，
     * 而「物理写不进去」（ENOSPC、磁盘故障、权限）悄无声息，后者明明更严重。
     *
     * 同一个原因只报第一次：磁盘坏了会每批都失败，逐条写审计会把表刷爆，
     * 而刷爆之后真正有用的那几条反而找不到了。
     */
    onWriteError: (info) => {
      const key = `${info.phase}:${info.error}`;
      if (key === lastWriteErrorKey) return;
      lastWriteErrorKey = key;
      const what = info.phase === 'append'
        ? '断网缓存写入失败，这批数据已丢失'
        : '断网缓存刷盘失败，已写入的数据可能未真正落盘，掉电会丢';
      console.error(`[alarm] ${what}：${info.error}`);
      recordAudit(db, {
        actor: 'system', action: 'spool-write-error', target: info.phase,
        detail: `${what}：${info.error}`, result: 'fail',
      });
    },
    onFull: (info) => {
      // 写满意味着开始丢数据，断网记录里必须留下这笔
      if (info.full) outages.bump('dropped', 1);
      const msg = info.full
        ? `断网缓存已写满（${info.bytes}/${info.maxBytes} 字节），按「${info.policy}」处置`
        : `断网缓存已回落到安全水位（${info.bytes}/${info.maxBytes} 字节）`;
      console.error(`[alarm] ${msg}`);
      recordAudit(db, {
        actor: 'system', action: 'spool-full', target: info.policy,
        detail: msg, result: info.full ? 'fail' : 'ok',
      });
    },
  });

  /*
   * 资源指标采样。常驻后台而不是「页面打开才采」——
   * 健康监测的价值恰恰在于**没人看的时候发生了什么**，
   * 等运维打开页面才开始记，出事那段永远是空白。
   *
   * 历史只在内存里（见 metrics-history.ts 的说明）：重启即清零，
   * 换来的是不去磨客户的 SD 卡。
   */
  const metricsIntervalSec = resolveMetricsIntervalSec();
  const metrics = metricsIntervalSec > 0 ? new MetricsHistory({ fineStepSec: metricsIntervalSec }) : undefined;
  let startMetrics = () => undefined;
  if (metrics) {
    // 采样出错每 10 秒一条会把日志刷爆，同一个原因只报第一次
    let lastError = '';
    const sampler = new MetricsSampler({
      history: metrics,
      source: service,
      intervalMs: metricsIntervalSec * 1000,
      onError: (e) => {
        const msg = (e as Error).message;
        if (msg === lastError) return;
        lastError = msg;
        console.error(`[metrics] 采样失败：${msg}（同样的原因不再重复打印）`);
      },
    });
    startMetrics = () => { sampler.start(); };
  }

  /*
   * 云平台对接。
   *
   * 接入参数落库（加密），进程起来就按库里那份把连接拉起来 ——
   * **但不等它连上**：现场常见「先装边缘、后开通云账号」，
   * 也常见云端临时不可达。启动阻塞在连接上会让整台设备起不来，
   * 而本地的实例管理与采集本来就不依赖云。
   *
   * 连不上时上行会落进 spool，链路一恢复自动补传（08 号文第 6 节）。
   */
  /*
   * 前向引用：CloudRuntime 的状态回调要触发补传，而 drainer 依赖 cloud.publish，
   * 两者互相需要。用一个后赋值的引用打破循环 —— 比把整块逻辑搅在一起清楚。
   */
  /*
   * 声明与赋值必须分离：上面的 onStateChange 闭包要引用它，
   * 而 drainer 依赖 cloud.publish —— 只能等 cloud 造好之后再回填。
   * 合并成 const 会形成循环依赖，所以这里豁免 prefer-const。
   */
  // eslint-disable-next-line prefer-const
  let drainerRef: SpoolDrainer | undefined;
  /*
   * 断网记录。重启时先收尾上一条未结束的 —— 它的 restoring 状态在内存里的
   * 补传进度已经没了，不标注的话会一直显示「补传中」而实际没人在补。
   */
  const outages = new OutageLog(db);
  const adopted = outages.adoptAfterRestart();
  if (adopted) {
    console.log(`[outage] 接管重启前未结束的断网记录 #${adopted.id}（${adopted.startedAt} 起）`);
  }
  const cloudConfig = new CloudConfigRepo(db, key);

  /*
   * 连接状态只在**真正跃迁**时打一行。
   *
   * `connecting` 是重试循环在走，不是事件：断网时 mqtt.js 每 reconnectPeriod
   * （默认 5 秒）就 close → reconnect 一轮，两个状态各来一次。实测断网十分钟
   * 会触发 243 次回调，全打出来一天三万多行 —— 在边缘盒子上那是拿日志磨 SD 卡，
   * 而真正有用的「掉线了」「回来了」两行反倒被埋掉。
   *
   * 去掉 connecting、再按上一次**打过的**状态去重，同样这十分钟只剩 3 行，
   * 信息量一点没少。审计侧早就按同一个理由只记 online/offline，这里跟上。
   */
  let lastLoggedCloud = '';
  const logCloudState = (state: string, detail: string) => {
    if (state === 'connecting' || state === lastLoggedCloud) return;
    lastLoggedCloud = state;
    console.log(`[cloud] ${detail}`);
  };

  const cloud = new CloudRuntime({
    onStateChange: (state, detail) => {
      logCloudState(state, detail);
      /*
       * 一连上就立刻补一轮，**不等下一条业务数据**。
       * 这是三个触发口里最关键的一个：断网期间现场可能已经停产，
       * 恢复后没有任何新数据能带动补传。
       */
      if (state === 'online') {
        outages.restore();
        void drainerRef?.trigger('link-online');
      }
      /*
       * 掉线即开一条记录。`begin` 自己会去重 —— 连接抖动会在几秒内
       * 掉线重连好几次，每次开一条会把列表刷成噪音。
       */
      if (state === 'offline') outages.begin();
      // 只记上线与掉线两个跃迁，connecting 每次重试都记会把审计刷爆
      if (state === 'online' || state === 'offline') {
        recordAudit(db, {
          actor: 'system', action: 'cloud-state', target: state,
          detail, result: state === 'online' ? 'ok' : 'fail',
        });
      }
    },
  });
  /*
   * 补传调度。
   *
   * 修的是一个真实漏洞：补传原先**只在微批发送成功之后**触发，
   * 没有定时器也没挂链路恢复事件。于是断网攒下积压、链路恢复之后，
   * 只要现场此刻没有新数据上报，积压就永远滞留 —— 而界面显示「已连接」。
   * 夜班停机、长周期抄读、断网期间实例也停了，都会踩到。
   */
  const drainer = new SpoolDrainer({
    spool,
    send: (payload) => cloud.publish(payload),
    ready: () => cloud.configured && cloud.state === 'online',
    ratePerSec: Number(process.env['EDGE_REPLAY_RATE'] ?? 50),
    intervalMs: Number(process.env['EDGE_REPLAY_INTERVAL_MS'] ?? 60_000),
    onRound: (r) => {
      if (r.sent > 0) console.log(`[replay] 补传 ${r.sent} 条（触发：${r.trigger}）`);
      if (r.failed > 0) console.warn(`[replay] 补传中断，${r.failed} 条未送出，等下一轮`);
      outages.bump('replayed', r.sent);
      /*
       * 积压清零才算这次断网真正结束。放在补传回调里判而不是定时轮询：
       * 只有补传动过之后 pending 才可能归零。
       */
      void spool.metrics().then((m) => {
        outages.observePending(m.pending);
        if (m.pending === 0) {
          const done = outages.finish();
          if (done) {
            console.log(`[outage] #${done.id} 已补完：断网 ${done.outageSec}s · `
              + `补传 ${done.recoverySec}s · 峰值积压 ${done.peakPending} 条`
              + (done.dropped > 0 ? ` · **丢弃 ${done.dropped} 条**` : ''));
          }
        }
      });
    },
  });
  drainerRef = drainer;

  await startManagerRuntime({
    reconcileNetworks,
    recoverInterruptedBootstraps: async () => {
      const recovered = await service.recoverInterruptedBootstraps();
      for (const result of recovered) {
        if (result.residuals.length > 0) {
          console.warn(
            `[warn] 实例 ${result.instanceId} 的 bootstrap 补偿仍有残留：${result.residuals.join(',')}`,
          );
        }
      }
    },
    startBackground: async () => {
      startMetrics();
      try {
        await cloud.apply(cloudConfig.get());
      } catch (e) {
        // 配置坏了不该拖垮启动：本地实例管理与采集不依赖云
        console.error(`[cloud] 接入配置无法应用：${(e as Error).message}`);
      }
      drainer.start();
    },
    buildServer: () => buildServer({
      ...platformNodeServices.serverDeps,
      ...instanceAdmin.serverDeps,
      config, db, auth, repo, service, operationGate, proxySessions,
      upstreamFor: instanceUpstreamFor,
      spool, metrics, drainer, outages,
      cloud, cloudConfig,
      cloudSink: (payload) => cloud.publish(payload),
      webRoot: process.env['WEB_ROOT']?.trim() || undefined,
      nodeStore, nodeCatalog, valueHistory, nodeUpstream, nodeSources,
      /*
       * packument 里的包体地址要写成实例视角的绝对地址 —— 取它的是容器里的 npm。
       * Manager 跑在宿主上（开发态）时给不出这个地址，此时私有源仍可读，
       * 只是实例侧本来也没配 registry，用不到。
       */
      npmRegistryUrl,
    }),
    listen: (app) => app.listen({ host: config.listenAddr, port: config.listenPort }).then(() => undefined),
  });
  console.log(
    `[ready] ${describe()} 监听 ${config.listenAddr}:${config.listenPort}` +
      ` · 外部地址 ${config.externalUrl}` +
      ` · docker 端点 ${describeDockerEndpoint(connection)}` +
      ` · 缓存写满策略 ${fullPolicy}` +
      ` · 指标采样 ${metricsIntervalSec > 0 ? `${metricsIntervalSec}s` : '已关闭'}` +
      ` · 云对接 ${cloud.state}`,
  );
}

// 直接运行时启动服务；被 import 时只导出
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const [sub, ...rest] = process.argv.slice(2);
  const task = sub === 'restore' ? runRestore(rest)
    : sub === 'preflight' ? runPreflightCli(rest)
      : main();
  task.catch((e) => {
    console.error('[fatal]', (e as Error).message);
    process.exit(1);
  });
}
