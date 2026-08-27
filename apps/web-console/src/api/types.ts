/** 与 Manager REST API 的契约。字段与后端 InstanceView / InstanceHealth 对齐。 */

export interface SessionUser {
  username: string;
  role: string;
  mustChangePassword: boolean;
}

export interface PortRecord {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp: string;
  purpose: string;
}

export interface Instance {
  id: string;
  name: string;
  imageTag: string;
  memLimit: number;
  cpuLimit: number;
  adminRoot: string;
  ports: PortRecord[];
  state: string;
  running: boolean;
  openUrl: string;
}

export interface ContainerHealth {
  state: string;
  running: boolean;
  restartCount: number;
  startedAt: string | null;
  cpuPercent: number | null;
  memUsedMb: number | null;
  memLimitMb: number | null;
}

export interface InstanceHealth {
  id: string;
  container: ContainerHealth;
  app: { ok: boolean; status: number | null; latencyMs: number | null; error?: string };
  flow: { started: boolean; recentErrors: number; lastError: string | null };
  verdict: 'healthy' | 'degraded' | 'down';
}

export interface HostStats {
  cpuCount: number;
  loadPercent: number | null;
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  /** 读数是否可信；不可信时界面不应展示百分比结论 */
  memReliable: boolean;
  diskTotalGb: number | null;
  diskUsedGb: number | null;
  diskPercent: number | null;
  uptimeSec: number;
}

export interface HealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
}

/** 一个采样点。与 Manager 的 MetricSample 对齐 */
export interface MetricPoint {
  t: number;
  host: {
    loadPercent: number | null;
    memPercent: number | null;
    diskPercent: number | null;
  };
  /** 键是实例 id；实例增删会让不同时刻的键不同，缺失即断线，不要补 0 */
  instances: Record<string, {
    cpuPercent: number | null;
    memUsedMb: number | null;
    memPercent: number | null;
    latencyMs: number | null;
    verdict: InstanceHealth['verdict'];
  } | undefined>;
}

export type MetricsRange = '10m' | '1h' | '6h' | '24h';

export interface MetricsSeries {
  /** false 表示 Manager 没开采样（EDGE_METRICS_INTERVAL_SEC=0），不是「暂时没数据」 */
  enabled: boolean;
  range: MetricsRange;
  rangeSec: number;
  /** 点间隔（秒）。窗口大时后端会自动降到粗档，值会变大 */
  stepSec: number;
  /** 采样间隔（秒），用于说明「多久一个点」 */
  intervalSec: number;
  from: number;
  to: number;
  /** 第一次采样的时刻；null 表示还没采到过 */
  firstSampleAt: number | null;
  points: MetricPoint[];
  instanceIds: string[];
}

export interface CreateInstanceBody {
  id: string;
  name: string;
  imageTag: string;
  memoryMb: number;
  cpus: number;
  /**
   * 端口映射表，一行一条；不需要设备直连时传空数组。
   *
   * 早先是「区间字符串 + 一个起始容器端口，其余递增」——
   * 那种写法表达不了 MQTT 1883 配 Modbus 502 这类不连号组合，
   * 且填错不会报错、只是连不上。
   */
  ports: PortRecord[];
}
