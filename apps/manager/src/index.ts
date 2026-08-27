/**
 * ThingLinks Edge Manager —— 入口。
 *
 * 当前阶段只做 Node-RED 多实例这条垂直切片，兄弟容器模式。
 * 其余能力（南向接入、云边协同、告警）按实施计划后置。
 */
import { loadConfig } from './core/config.ts';
import { openDb } from './core/db.ts';
import { requireMasterKey, deriveKey, generatePassword } from './core/crypto.ts';
import { AuthService } from './core/auth.ts';
import { InstanceRepo } from './core/instance-repo.ts';
import { InstanceService } from './core/instance-service.ts';
import { DockerClient } from './core/docker-client.ts';
import { buildServer } from './http/app.ts';
import { Spool, type FullPolicy } from './core/spool/spool.ts';
import { MetricsHistory, MetricsSampler } from './core/metrics-history.ts';
import { recordAudit } from './core/db.ts';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { restoreBackup } from './core/backup.ts';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

// 版本定义搬到 core/version.ts，让 http 层能直接引用而不成环。
// 本文件内部也要用 describe()，所以先 import 再复导出 —— 只写 export…from
// 不会把名字带进本模块作用域。
import { VERSION, describe } from './core/version.ts';
export { VERSION, describe };

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

export async function main(): Promise<void> {
  const config = loadConfig();
  const key = deriveKey(requireMasterKey(), 'thinglinks-edge:instance-cred');
  const db = openDb(join(config.dataDir, 'edge.db'));

  const auth = new AuthService(db);
  const repo = new InstanceRepo(db, key);

  // 首次启动生成随机初始口令并打印一次；标记必须改密
  const initialPassword = process.env['INITIAL_PASSWORD'] ?? generatePassword();
  if (auth.ensureInitialUser('admin', initialPassword)) {
    console.log(`[init] 已创建初始账号 admin，初始口令：${initialPassword}`);
    console.log('[init] 首次登录后必须修改口令，之后此口令即失效。');
  }

  const connection = dockerConnection();
  const managerContainer = resolveManagerContainer();
  const docker = new DockerClient({
    connection,
    network: process.env['INSTANCE_NETWORK'] ?? 'thinglinks-edge',
    imageRepo: process.env['NODE_RED_IMAGE_REPO'] ?? 'nodered/node-red',
    portRange: config.portRange,
    instanceDataRoot: config.instanceDataRoot,
    timezone: config.timezone,
    managerContainer: managerContainer,
    nodePackageDir: resolveNodePackageDir(),
    /*
     * 实例里的 @thinglinks 节点要回报台账，得能找到 Manager。
     * 靠容器名解析，因此只有 Manager 自己也是容器时才给得出地址 ——
     * 宿主开发态留空，节点会打一条警告后只透传不回报。
     */
    managerUrl: managerContainer
      ? `http://${managerContainer}:${config.listenPort}${config.basePath}`
      : undefined,
  });
  const service = new InstanceService({
    db, repo, docker,
    basePath: config.basePath,
    portRange: config.portRange,
    allowedImageTags: (process.env['ALLOWED_IMAGE_TAGS'] ??
      '5.0.4-24-minimal,4.1.13-22-minimal').split(',').map((s) => s.trim()).filter(Boolean),
  });

  // WEB_ROOT 由镜像设定（/app/web）；宿主开发态不设，前端走 Vite
  /*
   * 断网缓存。写满时必须产生**严重告警并记审计**（08 号文第 7 节）——
   * 数据取舍这种事发生了却没人知道，是最糟的情况。
   */
  const fullPolicy = resolveFullPolicy();
  const spool = await Spool.open({
    dir: join(config.dataDir, 'spool'),
    maxBytes: Number(process.env['EDGE_SPOOL_MAX_BYTES'] ?? 2 * 1024 * 1024 * 1024),
    fullPolicy,
    onFull: (info) => {
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
  if (metrics) {
    // 采样出错每 10 秒一条会把日志刷爆，同一个原因只报第一次
    let lastError = '';
    new MetricsSampler({
      history: metrics,
      source: service,
      intervalMs: metricsIntervalSec * 1000,
      onError: (e) => {
        const msg = (e as Error).message;
        if (msg === lastError) return;
        lastError = msg;
        console.error(`[metrics] 采样失败：${msg}（同样的原因不再重复打印）`);
      },
    }).start();
  }

  const app = buildServer({
    config, db, auth, repo, service, spool, metrics,
    webRoot: process.env['WEB_ROOT']?.trim() || undefined,
  });
  await app.listen({ host: config.listenAddr, port: config.listenPort });
  console.log(
    `[ready] ${describe()} 监听 ${config.listenAddr}:${config.listenPort}` +
      ` · 外部地址 ${config.externalUrl}` +
      ` · docker 端点 ${describeDockerEndpoint(connection)}` +
      ` · 缓存写满策略 ${fullPolicy}` +
      ` · 指标采样 ${metricsIntervalSec > 0 ? `${metricsIntervalSec}s` : '已关闭'}`,
  );
}

// 直接运行时启动服务；被 import 时只导出
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const [sub, ...rest] = process.argv.slice(2);
  const task = sub === 'restore' ? runRestore(rest) : main();
  task.catch((e) => {
    console.error('[fatal]', (e as Error).message);
    process.exit(1);
  });
}
