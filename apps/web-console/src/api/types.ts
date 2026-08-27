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

export interface CreateInstanceBody {
  id: string;
  name: string;
  imageTag: string;
  memoryMb: number;
  cpus: number;
  portSpec: string;
  containerPort?: number;
  purpose?: string;
}
