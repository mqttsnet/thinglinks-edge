/**
 * 健康探针 —— 三层。
 *
 *   容器层：运行状态、CPU、内存、重启次数
 *   应用层：HTTP 探针存活与响应延迟
 *   业务层：flow 是否已启动、近期是否有节点报错
 *
 * 分层的意义：容器在跑 ≠ Node-RED 活着 ≠ 流程在正常工作。
 * 只看容器状态会漏掉「进程还在但已经不干活」这类故障。
 */
import type Docker from 'dockerode';

export interface ContainerHealth {
  state: string;
  running: boolean;
  restartCount: number;
  startedAt: string | null;
  cpuPercent: number | null;
  memUsedMb: number | null;
  memLimitMb: number | null;
}

export interface AppHealth {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

export interface FlowHealth {
  started: boolean;
  recentErrors: number;
  lastError: string | null;
}

export interface InstanceHealth {
  id: string;
  container: ContainerHealth;
  app: AppHealth;
  flow: FlowHealth;
  /** 综合判定：三层任一异常即非 healthy */
  verdict: 'healthy' | 'degraded' | 'down';
}

/** Docker stats 的原始片段，只取计算所需字段 */
export interface DockerStatsLike {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number } };
}

/**
 * 由两次采样差值算 CPU 百分比。
 *
 * Docker 的 stats 给的是累计纳秒，必须用「容器增量 / 系统增量 × 核数」，
 * 直接拿 total_usage 当百分比是常见错误。
 */
export function cpuPercent(s: DockerStatsLike): number | null {
  const cur = s.cpu_stats?.cpu_usage?.total_usage;
  const pre = s.precpu_stats?.cpu_usage?.total_usage;
  const curSys = s.cpu_stats?.system_cpu_usage;
  const preSys = s.precpu_stats?.system_cpu_usage;
  if (cur === undefined || pre === undefined || curSys === undefined || preSys === undefined) return null;

  const deltaContainer = cur - pre;
  const deltaSystem = curSys - preSys;
  if (deltaSystem <= 0 || deltaContainer < 0) return null;

  const cores = s.cpu_stats?.online_cpus ?? s.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  return Math.round((deltaContainer / deltaSystem) * cores * 1000) / 10;
}

/** 内存用量：扣掉页缓存才是真实占用，否则会虚高 */
export function memoryUsage(s: DockerStatsLike): { usedMb: number | null; limitMb: number | null } {
  const usage = s.memory_stats?.usage;
  const limit = s.memory_stats?.limit;
  if (usage === undefined) return { usedMb: null, limitMb: limit ? Math.round(limit / 1048576) : null };
  const cache = s.memory_stats?.stats?.cache ?? 0;
  return {
    usedMb: Math.round((usage - cache) / 1048576),
    limitMb: limit ? Math.round(limit / 1048576) : null,
  };
}

/** 从容器日志提取业务层信号 */
export function analyzeLogs(logs: string): FlowHealth {
  const lines = logs.split('\n');
  const started = lines.some((l) => l.includes('Started flows'));
  const errorLines = lines.filter((l) => /\[error\]/i.test(l));
  return {
    started,
    recentErrors: errorLines.length,
    lastError: errorLines.length > 0 ? (errorLines[errorLines.length - 1] ?? '').trim().slice(0, 200) : null,
  };
}

export function judge(container: ContainerHealth, app: AppHealth, flow: FlowHealth): InstanceHealth['verdict'] {
  if (!container.running) return 'down';
  if (!app.ok) return 'down';           // 容器在跑但 HTTP 不通 = 进程假死
  if (!flow.started || flow.recentErrors > 0) return 'degraded';
  return 'healthy';
}

export interface HealthProbeOptions {
  /** 实例的 HTTP 基址解析；生产按容器名，验证时可注入 */
  upstreamFor: (instanceId: string) => string;
  /** 实例的 httpAdminRoot */
  adminRootFor: (instanceId: string) => string | undefined;
  probeTimeoutMs?: number;
}

export class HealthProbe {
  private readonly o: HealthProbeOptions;

  constructor(options: HealthProbeOptions) {
    this.o = options;
  }

  async container(container: Docker.Container): Promise<ContainerHealth> {
    const info = await container.inspect();
    let cpu: number | null = null;
    let mem: { usedMb: number | null; limitMb: number | null } = { usedMb: null, limitMb: null };

    if (info.State.Running) {
      // stream:false 让 Docker 自行采样两次并返回差值所需字段
      const stats = (await container.stats({ stream: false })) as unknown as DockerStatsLike;
      cpu = cpuPercent(stats);
      mem = memoryUsage(stats);
    }
    return {
      state: info.State.Status,
      running: info.State.Running,
      restartCount: info.RestartCount ?? 0,
      startedAt: info.State.StartedAt ?? null,
      cpuPercent: cpu,
      memUsedMb: mem.usedMb,
      memLimitMb: mem.limitMb,
    };
  }

  /** 应用层：打实例的编辑器入口，测存活与延迟 */
  async app(instanceId: string): Promise<AppHealth> {
    const adminRoot = this.o.adminRootFor(instanceId);
    if (!adminRoot) return { ok: false, status: null, latencyMs: null, error: '实例不存在' };

    const url = `${this.o.upstreamFor(instanceId)}${adminRoot}`;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.o.probeTimeoutMs ?? 5000),
        redirect: 'manual',
      });
      const latencyMs = Date.now() - started;
      // 编辑器入口返回 2xx/3xx 均视为存活（adminAuth 开启时可能重定向）
      return { ok: res.status < 400, status: res.status, latencyMs };
    } catch (e) {
      return {
        ok: false, status: null, latencyMs: Date.now() - started,
        error: (e as Error).name === 'TimeoutError' ? '探测超时' : (e as Error).message,
      };
    }
  }
}
