/** 与 Manager REST API 的契约。字段与后端 InstanceView / InstanceHealth 对齐。 */

export interface SessionUser {
  username: string;
  role: string;
  mustChangePassword: boolean;
  /** 全站强制两步验证、而这个人还没绑。为 true 时后端只放行绑定相关接口 */
  mustEnroll2fa: boolean;
  totpEnabled: boolean;
}

/** 首次设置状态。`needed` 为真时登录页显示「创建管理员」而不是登录表单 */
export interface SetupState {
  needed: boolean;
  /** 认领窗口已过 —— 要重启 Manager 才能再设置 */
  expired: boolean;
  /** 窗口剩余秒数；0 表示不限时 */
  expiresInSec: number;
}

// ── 系统设置与两步验证 ────────────────────────────────

export interface SystemSettings {
  sessionIdleMin: number;
  loginMaxFailures: number;
  loginLockMin: number;
  require2fa: boolean;
  updateCheckEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface SettingsView {
  settings: SystemSettings;
  /** 服务端当前时间，用来算浏览器与盒子的时钟偏差 —— TOTP 完全靠时钟 */
  serverTime: string;
  canManage: boolean;
}

export interface TotpStatus {
  enabled: boolean;
  /** 全站是否强制。为 true 时界面上不给「解绑」 */
  required: boolean;
  recoveryLeft: number;
}

/** 绑定第一步的返回。密钥只在这一刻明文出现一次，之后接口再也不回它 */
export interface TotpSetup {
  secret: string;
  /** 四位一组，手输时不容易串行 */
  grouped: string;
  otpauth: string;
}

/**
 * 登录结果：要么直接给会话，要么要第二因子。
 * `mfa` 在时**没有任何 Cookie 下发** —— 那正是两步验证成立的前提。
 */
export type LoginResult =
  | { user: SessionUser; mfa?: undefined }
  | { mfa: true; ticket: string };

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
  /** 本机是否已拉取。false 时不能用于创建实例，也不能升级到它 */
  present: boolean;
}

/** 一个节点源 */
export interface NpmSource {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
}

/** 在线搜索命中的一个包 */
export interface NodeSearchHit {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  date: string;
  /** 来自哪个源 —— 配了多个源时人得知道这个包是哪来的 */
  source: string;
}

/** 点位历史的一段 */
export interface TagHistory {
  /**
   * 本部署有没有开点位历史。false 时 points 必为空，界面要说明「未启用」
   * 而不是画一张空图 —— 空图会让人以为是采集坏了。
   */
  enabled: boolean;
  points: { at: string; value: unknown; quality: string }[];
  /** 全库最早一条的时刻。历史按条数封顶，所以「能看多久」随点位数量浮动 */
  oldest: string | null;
  rows: number;
  maxRows: number;
  /** enabled 为 false 时说明原因 */
  reason?: string;
}

/** 换镜像版本的结果 */
export interface ImageUpgradeResult {
  from: string;
  to: string;
  /**
   * 恒为 false —— 回滚发生时后端是**抛错**而不是回一个成功响应。
   * 保留这个字段是为了让「升级成功」这件事在类型上就是明确的。
   */
  rolledBack: boolean;
}

// ── 云平台对接 ────────────────────────────────────────

export type CipherFlag = 0 | 1 | 2;

/**
 * ThingLinks 公有云的默认接入地址。
 *
 * Manager 侧另有一份同名常量（`core/cloud/config-repo.ts`），两处必须一致 ——
 * 一处改了另一处没改，用户会照着界面提示填出一个后端报错的地址。
 * 这里没有共享包可以放，所以只能靠这条注释盯着。
 */
export const DEFAULT_BROKER_HOST = 'broker.thinglinks.mqttsnet.com';
export const DEFAULT_BROKER_URL = `mqtt://${DEFAULT_BROKER_HOST}:11883`;
export const DEFAULT_BROKER_URL_TLS = `mqtts://${DEFAULT_BROKER_HOST}:11884`;

/**
 * 证书模式。
 *
 * `system` 走系统根证书（公网签发的证书用这个）；`ca` 是自签 CA；
 * `mutual` 在自签 CA 之上再加客户端证书与私钥（双向认证）。
 */
export type TlsMode = 'system' | 'ca' | 'mutual';

/** 证书摘要。后端不回 PEM 本身 —— 要判断「传对了没有」，看这几项比看 PEM 清楚 */
export interface CertSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256 指纹，与云平台那边对一眼就知道是不是同一张 */
  fingerprint: string;
  expired: boolean;
}

/**
 * MQTT 协议版本。**不是** topic 首段那个 `v1`（那是 protocolVersion）。
 * 数字取自 mqtt.js 的 protocolVersion：3 = MQTT 3.1，4 = 3.1.1，5 = 5.0。
 */
export type MqttVersion = 3 | 4 | 5;

/** 连接参数。里面没有秘密，读写都是原样 */
export interface ConnectionOptions {
  mqttVersion: MqttVersion;
  keepaliveSec: number;
  connectTimeoutSec: number;
  autoReconnect: boolean;
  reconnectPeriodMs: number;
}

/**
 * 服务器地址在界面上拆成四段，落库仍是一整条 `brokerUrl`。
 *
 * 为什么不把四段分别存起来：mqtt.js 要的就是一条 URL，拆开存就得在两处保持一致，
 * 迟早出现「界面上是 8883、实际连的是 1883」这种对不上的状态。
 * 界面拆是为了好填，存一份是为了不打架。
 */
export const BROKER_SCHEMES = ['mqtt://', 'mqtts://', 'ws://', 'wss://'] as const;
export type BrokerScheme = (typeof BROKER_SCHEMES)[number];

/**
 * 换协议时顺手把端口带过去的**建议值**（ThingLinks 的约定端口）。
 * 用户改过端口就不再自动改。这只是填表建议，不是协议默认端口。
 */
export const SCHEME_DEFAULT_PORT: Record<BrokerScheme, number> = {
  'mqtt://': 11883,
  'mqtts://': 11884,
  'ws://': 8083,
  'wss://': 8084,
};

/**
 * 协议**真正的**默认端口。只用在一处：把一条没写端口的旧地址拆开时，
 * 补的必须是它实际会连的那个端口。
 *
 * 拿上面那组建议值来补是错的 —— `mqtts://host` 实际连的是 8883，
 * 补成 11884 再存回去，地址就被悄悄改掉了，而用户只是来改了个心跳。
 */
export const PROTOCOL_DEFAULT_PORT: Record<BrokerScheme, number> = {
  'mqtt://': 1883,
  'mqtts://': 8883,
  'ws://': 80,
  'wss://': 443,
};

/** 保存请求里的 TLS 部分。私钥与口令同一套语义：留 undefined 表示不改 */
export interface TlsConfigInput {
  mode?: TlsMode | undefined;
  ca?: string | undefined;
  cert?: string | undefined;
  key?: string | undefined;
  rejectUnauthorized?: boolean | undefined;
  servername?: string | undefined;
}

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
  /** 连接参数。里面没有秘密，原样回传 */
  connection: ConnectionOptions;
  /** 证书部分。`ca`/`cert` 是摘要不是 PEM，没传过就是 null */
  tls: {
    mode: TlsMode;
    rejectUnauthorized: boolean;
    servername: string;
    /** 地址本身是不是加密协议。界面据此决定要不要展开证书那一段 */
    secure: boolean;
    ca: CertSummary | null;
    cert: CertSummary | null;
  };
  protocolVersion: string;
  qos: 0 | 1 | 2;
  updatedAt: string;
  updatedBy: string;
  secretsSet: {
    password: boolean; signKey: boolean; encryptKey: boolean; encryptVector: boolean;
    tlsKey: boolean;
  };
}

export interface CloudStatus {
  state: CloudState;
  configured: boolean;
  brokerUrl: string;
  deviceIdentification: string;
  clientId: string;
  cipherFlag: number;
  /** 链路是不是加密的。第一屏要能一眼看出来 */
  secure: boolean;
  tlsMode: TlsMode;
  /** false 就是「只加密不认人」，界面必须标出来 */
  rejectUnauthorized: boolean;
  /** 实际以哪一版 MQTT 连上的 */
  mqttVersion: MqttVersion;
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
  /** 整块留 undefined 表示 TLS 设置一个字段都不改 */
  tls?: TlsConfigInput | undefined;
  /** 同上：整块或逐字段留空都表示不改 */
  connection?: Partial<ConnectionOptions> | undefined;
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

// ── 远程诊断（T4.5）──────────────────────────────────────────

export interface DnsResult {
  host: string;
  ok: boolean;
  addresses: string[];
  elapsedMs: number;
  error?: string;
}

export interface TcpResult {
  host: string;
  port: number;
  ok: boolean;
  elapsedMs: number;
  /** 实际连到的地址，双栈环境下用于确认走的是 v4 还是 v6 */
  remoteAddress?: string;
  error?: string;
}

export interface ClockResult {
  localTime: string;
  timezone: string;
  uptimeSec: number;
  /** 配了时钟源才有；正数表示本机比参考时间慢 */
  offsetMs?: number;
  roundtripMs?: number;
  server?: string;
  ok: boolean;
  /** 没配时钟源时说明原因，而不是假装检查过 */
  note: string;
}

/** 一次「解析 + 连通」的合并结论。解析没成功时 tcp 为 null —— 那时根本没去连 */
export interface EndpointProbe {
  target: string;
  dns: DnsResult | null;
  tcp: TcpResult | null;
  summary: string;
}

export interface DiagProbeResponse {
  probes: EndpointProbe[];
  clock: ClockResult;
  /** 后端附带的口径说明，原样展示 —— 「可达」不等于「可用」 */
  note: string;
}

// ── 流程模板（T4.6）──────────────────────────────────────────

/** 模板元信息。列表接口只回这些，**不含 flows** —— 一个模板可能几百 KB */
export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  /** 标签页数量，等于「几张流程图」 */
  tabCount: number;
  /** 去重后的节点类型 */
  nodeTypes: string[];
  /** 来源实例 id；从文件建的是 `upload` */
  source: string;
  /** 疑似写死在 function 节点里的凭据。**只告警不剥离** */
  warnings: string[];
  createdBy: string;
  createdAt: string;
}

/** 套用前的兼容性结论 */
export interface CompatResult {
  /** 是否齐全。**必须连着 `checked` 一起看** —— 没查成时它也是 true */
  ok: boolean;
  /**
   * 这次到底查没查成。取不到目标实例的节点清单时后端不阻断部署，
   * 但那时的 `ok: true` 是默认值不是结论 —— 界面**不能**把它显示成
   * 绿色的「节点齐全」，那是替一件没做过的事打包票。
   */
  checked: boolean;
  /** 目标实例没装的节点类型。套上去它们会变成坏节点，且部署仍然返回成功 */
  missing: string[];
}

/** 试算（dryRun）结果：只查不动 */
export interface ApplyPreview {
  dryRun: true;
  nodeCount: number;
  tabCount: number;
  nodeTypes: string[];
  compat: CompatResult;
  warnings: string[];
  note: string;
}

/** 真正套用之后的结果 */
export interface ApplyResult {
  applied: true;
  deployStatus: number;
  nodeCount: number;
  tabCount: number;
  nodeTypes: string[];
  compat: CompatResult;
  /** 被替换掉的旧流程节点数；取不到时为 null */
  replacedNodeCount: number | null;
  note: string;
}

/** 补传进度。算不出来时 etaSec 为 null 并由 reason 说明，界面不要自己编 */
export interface ReplayProgress {
  pending: number;
  ratePerSec: number | null;
  etaSec: number | null;
  running: boolean;
  reason: string;
}

/**
 * 一次断网的完整记录。三个时刻不是两个 ——
 * 「连上了但还在追欠账」那段是现场最关心的。
 */
export interface OutageRecord {
  id: number;
  startedAt: string;
  restoredAt: string | null;
  drainedAt: string | null;
  outageSec: number | null;
  recoverySec: number | null;
  peakPending: number;
  spooled: number;
  replayed: number;
  /** 非 0 就是真丢了数据 */
  dropped: number;
  status: 'ongoing' | 'restoring' | 'done';
  note: string;
}

// ── 节点管理（01 号文 5.7）──────────────────────────────────
//
// 这一块有三张不同的清单，名字很像但回答的是**不同的问题**，界面上也别混：
//
//   批准清单 CatalogEntry   ——「**允许**装什么」（闸门本身，写进实例 settings.js）
//   离线包库 StorePackage   ——「**有**什么可装」（私有 npm 源里的 tgz）
//   已装台账 InstanceInventory ——「实际**装了**什么」（各实例现答）
//
// 三者不一致是常态，而**发现不一致**正是这一页存在的理由。

/** 一条已批准的节点包 */
export interface CatalogEntry {
  module: string;
  /** 版本范围。留空表示不限版本 */
  version?: string;
  note: string;
  approvedBy: string;
  approvedAt: string;
  /** 离线包库里有没有它。批了但库里没有 = 无外网现场装不上 */
  inStore: boolean;
  storeVersions: string[];
}

/** 离线包库里的一个包 */
export interface StorePackage {
  module: string;
  versions: string[];
  latest: string;
  description: string;
  /** 该包提供的节点类型。依赖包为空 */
  types: string[];
  /** 有 node-red.nodes 才算节点包；其余是被它拖进来的普通依赖 */
  isNodeRedNode: boolean;
  size: number;
  updatedAt: string;
  approved: boolean;
  /** 必需依赖缺口。非空 = 现场点安装会失败 */
  missingDeps: string[];
  /**
   * 可选依赖缺口。非空 = 装得上，但**少一部分功能**，而且不会报错。
   * modbus 的串口（RTU）支持就在这里，所以不能和 missingDeps 一样对待。
   */
  missingOptionalDeps: string[];
}

export interface StoreListResult {
  packages: StorePackage[];
  /** 包库在 Manager 上的绝对路径，排障时要照着它去看盘 */
  root: string;
}

/** 导入一个 tgz 之后的回执 */
export interface ImportResult {
  package: { name: string; version: string; isNodeRedNode: boolean; types: string[] };
  missingDeps: string[];
  missingOptionalDeps: string[];
}

/** 一条节点在合规意义上的判定 */
export type NodeCompliance = 'builtin' | 'platform' | 'approved' | 'unapproved';

export interface InventoryItem {
  module: string;
  version: string;
  local: boolean;
  types: string[];
  enabled: boolean;
  compliance: NodeCompliance;
}

export interface InstanceInventory {
  instanceId: string;
  /** 读取成功与否。停机的实例读不到，那不是错误，是常态 */
  ok: boolean;
  reason: string;
  modules: InventoryItem[];
  unapproved: number;
}

/** 下发策略到某台实例的结果。逐台给，一台失败不影响其余 */
export interface ApplyPolicyResult {
  instanceId: string;
  ok: boolean;
  /** 实例是否真的重启了 —— 不重启就没生效 */
  restarted: boolean;
  error: string;
}
