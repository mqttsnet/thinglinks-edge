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

export interface UpdateInfo {
  enabled: boolean;
  latest?: string;
  url?: string;
  outdated?: boolean;
  checkedAt?: string;
  /** 检查失败的原因。有它就说明**没查到**，不能当作「已是最新」 */
  error?: string;
}

export interface VersionInfo {
  version: string;
  /** 面向使用者的本次变更说明（Markdown）。为空表示该版本没写，不弹窗 */
  notes: string;
  update: UpdateInfo;
}

export interface ImageOption {
  tag: string;
  /** 本机是否已拉取。false 时不能用于创建实例 */
  present: boolean;
}

// ── 云平台对接 ────────────────────────────────────────

export type CipherFlag = 0 | 1 | 2;

/** 连接状态。`unconfigured`/`disabled` 是「没配」与「配了但关着」，不要混为 offline */
export type CloudState = 'unconfigured' | 'disabled' | 'offline' | 'connecting' | 'online';

/**
 * 后端回的配置**永远不含明文密钥**，只用 secretsSet 说明某项设没设。
 * 前端据此显示「已设置，留空表示不修改」。
 */
export interface CloudConfigView {
  enabled: boolean;
  brokerUrl: string;
  clientId: string;
  deviceIdentification: string;
  username: string;
  cipherFlag: CipherFlag;
  protocolVersion: string;
  qos: 0 | 1 | 2;
  updatedAt: string;
  updatedBy: string;
  secretsSet: { password: boolean; signKey: boolean; encryptKey: boolean; encryptVector: boolean };
}

export interface CloudStatus {
  state: CloudState;
  configured: boolean;
  brokerUrl: string;
  deviceIdentification: string;
  clientId: string;
  cipherFlag: number;
  lastError: string;
  lastErrorAt: string | null;
  connectedAt: string | null;
  published: number;
  failed: number;
}

/** 保存请求。密钥字段留 undefined 表示不修改，传空串才是清空 */
export interface CloudConfigInput {
  enabled: boolean;
  brokerUrl: string;
  clientId: string;
  deviceIdentification: string;
  username: string;
  /* 显式带上 undefined：exactOptionalPropertyTypes 下「留空表示不修改」
     这个语义要求调用方能真的传 undefined，只写 `?:` 是传不进去的 */
  password?: string | undefined;
  cipherFlag: CipherFlag;
  signKey?: string | undefined;
  encryptKey?: string | undefined;
  encryptVector?: string | undefined;
  protocolVersion?: string | undefined;
  qos?: 0 | 1 | 2 | undefined;
}

/** 字段与 Manager 的 Spool.metrics() 一一对应，不要另起名字 */
export interface SpoolMetrics {
  pending: number;
  bytes: number;
  maxBytes: number;
  usagePercent: number;
  full: boolean;
  policy: string;
  segments: number;
  droppedOldest: number;
  droppedNewest: number;
  rejected: number;
  replayed: number;
}

// ── 数据面：微批与积压（B4/B5）──────────────────────────────

/** 触发一次攒批的三个阈值，任一达到即发出 */
export interface BatchLimits {
  windowMs: number;
  maxPoints: number;
  maxBytes: number;
}

export interface BatchMetrics {
  limits: BatchLimits;
  /** 当前还攒在内存里、尚未发出的点数与字节数 */
  pending: number;
  pendingBytes: number;
  /** 累计发出的批次与点数 */
  batches: number;
  points: number;
  /** 发送失败的点数（这些点会转入断网缓存） */
  failures: number;
  /** 累计落入断网缓存的批次数 */
  spooled: number;
  lastError: string;
}

export interface EdgeMetrics {
  cloud: 'configured' | 'not-configured';
  cloudStatus: CloudStatus | null;
  batch: BatchMetrics;
  /** 未启用断网缓存时为 null —— 如实为空，不编一个全零对象 */
  spool: SpoolMetrics | null;
}

/** 一轮补传的结果 */
export interface ReplayResult {
  sent: number;
  failed: number;
}

// ── 用户与权限（T4.4）────────────────────────────────────────

export type Role = 'admin' | 'operator' | 'viewer';
/** 实例授权档位。operate 蕴含 view */
export type GrantLevel = 'view' | 'operate';

export interface UserRecord {
  username: string;
  role: string;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface GrantRecord {
  username: string;
  instanceId: string;
  level: GrantLevel;
  grantedBy: string;
  grantedAt: string;
}

/** 当前登录者自己的权限。前端据此隐藏入口 —— 但后端仍然逐个路由判 */
export interface MyPermissions {
  role: string;
  actions: string[];
  /** admin 为 'all'，其余为逐条授权 */
  instances: 'all' | GrantRecord[];
}

// ── 备份（T4.3）──────────────────────────────────────────────

export interface BackupManifest {
  format: number;
  product: string;
  createdAt: string;
  schemaVersion: number;
  /** MASTER_KEY 派生密钥的指纹，不含密钥本身 */
  masterKeyFingerprint: string;
  instances: { id: string; name: string; imageTag: string }[];
}

export interface BackupInspect {
  manifest: BackupManifest;
  files: number;
  bytes: number;
}

// ── 现场设备台账与南向探测（T4.5）──────────────────────────
//
// 两类数据**不能混**，类型上就分开：
//   · FieldDeviceRecord / FieldTagRecord 是 `@thinglinks` 节点主动回报的可信台账，
//     有在线状态、当前值与质量码；
//   · ProbedDevice / ProbedTag 是从 flows.json 反推的尽力探测，恒 managed: false，
//     没有运行时数据。界面必须标「未纳管」，两边的数字也不许相加。

export interface FieldDeviceRecord {
  instanceId: string;
  nodeId: string;
  name: string;
  protocol: string;
  address: string;
  model: string;
  manufacturer: string;
  online: boolean;
  lastSeen: string | null;
  registeredAt: string;
}

export interface FieldTagRecord {
  instanceId: string;
  nodeId: string;
  tagId: string;
  name: string;
  unit: string;
  dataType: string;
  /** 最近一次上报的值，已还原为原始类型；从未上报过时为 null */
  lastValue: unknown;
  quality: string;
  lastAt: string | null;
}

/** 只涵盖**已纳管**的部分。note 是后端给的口径说明，原样展示，不要自己改写 */
export interface FieldSummary {
  managed: { devices: number; online: number; tags: number };
  note: string;
}

export interface ProbedDevice {
  nodeId: string;
  name: string;
  protocol: string;
  address: string;
  /** 原始节点类型，便于用户对回流里的哪个节点 */
  sourceType: string;
}

export interface ProbedTag {
  /** 所属设备（配置节点 id）；认不出归属时为空 */
  nodeId: string;
  tagId: string;
  name: string;
  address: string;
  dataType: string;
  sourceType: string;
}

export interface ProbeResult {
  devices: ProbedDevice[];
  tags: ProbedTag[];
  /** 见到但认不出的节点类型 —— 必须如实告知「还有这些我看不懂」 */
  unrecognized: { type: string; count: number }[];
  /** 恒为 false。方案 A 永远不是可靠台账 */
  managed: false;
  /** 没探成的原因（无 flows.json、JSON 坏了）。有它就说明结果是空的，不是「真没设备」 */
  reason?: string;
}
