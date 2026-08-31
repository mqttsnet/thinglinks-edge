/**
 * API 客户端。
 *
 * 两个约定与后端对齐：
 *   写操作必须带 x-csrf-token（值取自后端下发的 tle_csrf Cookie，双提交模式）；
 *   401 表示未登录，由调用方跳转登录页，而不是在这里硬跳转。
 */
import type {
  SessionUser, LoginResult, SetupState, SettingsView, SystemSettings, TotpStatus, TotpSetup, Instance, InstanceHealth, HostStats, HealthSummary, CreateInstanceBody,
  MetricsRange, MetricsSeries, VersionInfo, ImageOption,
  CloudConfigView, CloudConfigInput, CloudStatus, SpoolMetrics,
  ReplayProgress, OutageRecord,
  UserRecord, GrantRecord, MyPermissions, BackupInspect, Role, GrantLevel,
  FieldDeviceRecord, FieldTagRecord, FieldSummary, ProbeResult,
  EdgeMetrics, ReplayResult,
  DiagProbeResponse,
  FlowTemplate, ApplyPreview, ApplyResult,
  CatalogEntry, StoreListResult, ImportResult, InstanceInventory, ApplyPolicyResult,
} from './types';
import { filenameFrom } from './filename';

/**
 * 控制台挂载前缀，由 Manager 在 index.html 里注入。
 *
 * 它是**运行期**才知道的（从 EXTERNAL_URL 派生），构建期拿不到，
 * 所以所有请求路径都要在这里补上，不能写死成 `/api/...`。
 * 开发态（Vite）没有注入，退化为空串。
 *
 * 不用 `document.baseURI` 反推：开发态没有 `<base>`，深链接下 baseURI 就是
 * 当前地址，推出来的前缀会是 `/instances` 这种明显错误的值。
 */
export const basePath: string =
  (window as unknown as { __TLE_BASE__?: string }).__TLE_BASE__ ?? '';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function csrfToken(): string {
  return /(?:^|;\s*)tle_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('x-csrf-token', csrfToken());
    if (init.body !== undefined) headers.set('content-type', 'application/json');
  }

  const res = await fetch(`${basePath}${path}`, { ...init, headers, credentials: 'same-origin' });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson && text ? JSON.parse(text) : text;

  if (!res.ok) {
    const message = isJson && payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

/** 拼查询串：值为空的键直接不出现，避免发出 `?instanceId=` 这种后端要当真的空值 */
function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const api = {
  /** 匿名可读：登录页要靠它决定显示登录还是首次设置 */
  setupState: () => request<SetupState>('/api/setup'),

  /** 首次设置。成功即登录，直接回会话 */
  setup: (username: string, password: string) =>
    request<{ user: SessionUser }>('/api/setup', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),

  login: (username: string, password: string) =>
    request<LoginResult>('/api/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),

  /** 第二因子。验证码或恢复码都收 */
  loginSecondFactor: (ticket: string, code: string) =>
    request<{ user: SessionUser }>('/api/login/2fa', {
      method: 'POST', body: JSON.stringify({ ticket, code }),
    }),

  logout: () => request<void>('/api/logout', { method: 'POST' }),

  me: () => request<{ user: SessionUser }>('/api/me'),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<void>('/api/change-password', {
      method: 'POST', body: JSON.stringify({ oldPassword, newPassword }),
    }),

  // ── 系统设置与两步验证 ──────────────────────────────

  settings: () => request<SettingsView>('/api/settings'),

  saveSettings: (input: Partial<SystemSettings>) =>
    request<{ settings: SystemSettings }>('/api/settings', {
      method: 'PUT', body: JSON.stringify(input),
    }),

  totpStatus: () => request<TotpStatus>('/api/me/totp'),

  totpSetup: () => request<TotpSetup>('/api/me/totp/setup', { method: 'POST' }),

  /** 确认绑定。恢复码只在这一次返回，之后库里只有哈希 */
  totpConfirm: (code: string) =>
    request<{ codes: string[] }>('/api/me/totp/confirm', {
      method: 'POST', body: JSON.stringify({ code }),
    }),

  totpDisable: (password: string) =>
    request<void>('/api/me/totp', {
      method: 'DELETE', body: JSON.stringify({ password }),
    }),

  /** 管理员强制解绑别人。用于「手机丢了、恢复码也没了」 */
  totpReset: (username: string) =>
    request<void>(`/api/users/${encodeURIComponent(username)}/totp/reset`, { method: 'POST' }),

  instances: () => request<{ instances: Instance[] }>('/api/instances'),

  instance: (id: string) => request<{ instance: Instance }>(`/api/instances/${id}`),

  createInstance: (body: CreateInstanceBody) =>
    request<{ instance: Instance }>('/api/instances', {
      method: 'POST', body: JSON.stringify(body),
    }),

  startInstance: (id: string) => request<void>(`/api/instances/${id}/start`, { method: 'POST' }),
  stopInstance: (id: string) => request<void>(`/api/instances/${id}/stop`, { method: 'POST' }),

  removeInstance: (id: string, removeData: boolean) =>
    request<void>(`/api/instances/${id}?removeData=${removeData}`, { method: 'DELETE' }),

  resetCredential: (id: string, username: string) =>
    request<{ password: string }>(`/api/instances/${id}/credentials/${username}/reset`, { method: 'POST' }),

  logs: (id: string, tail = 200) =>
    request<string>(`/api/instances/${id}/logs?tail=${tail}`),

  recommendPorts: (count: number) =>
    request<{ recommended: string }>(`/api/ports/recommend?count=${count}`),

  health: () =>
    request<{ summary: HealthSummary; host: HostStats; instances: InstanceHealth[] }>('/api/health'),

  /** 资源趋势历史。与 health 分开：那边现探三层探针，这边纯读内存，刷曲线不加探针压力 */
  metrics: (range: MetricsRange) => request<MetricsSeries>(`/api/metrics?range=${range}`),

  version: () => request<VersionInfo>('/api/version'),

  /** 可选实例版本 + 本机是否已有。列表来自后端白名单，前端不再自己硬编码 */
  images: () => request<{ images: ImageOption[] }>('/api/images'),

  // ── 云平台对接 ──────────────────────────────────────

  cloud: () => request<{
    config: CloudConfigView | null;
    status: CloudStatus;
    spool: SpoolMetrics | null;
    replay: ReplayProgress | null;
    outages: OutageRecord[] | null;
  }>('/api/cloud'),

  saveCloud: (input: CloudConfigInput) =>
    request<{ config: CloudConfigView; status: CloudStatus }>('/api/cloud', {
      method: 'PUT', body: JSON.stringify(input),
    }),

  reconnectCloud: () =>
    request<{ status: CloudStatus }>('/api/cloud/reconnect', { method: 'POST' }),

  unlinkCloud: () =>
    request<{ status: CloudStatus }>('/api/cloud', { method: 'DELETE' }),

  /** 数据面明细：微批当前攒了多少、断网缓存积压多少 */
  edgeMetrics: () => request<EdgeMetrics>('/api/edge/metrics'),

  /**
   * 手动跑一轮补传。
   *
   * 正常情况下补传由每次成功发送自动带动，这个口子是给现场排障用的 ——
   * 「明明连上了但积压不降」时手动推一把，并看到 sent/failed 的实数。
   */
  replaySpool: () => request<ReplayResult>('/api/edge/replay', { method: 'POST' }),

  // ── 用户与权限（T4.4）──────────────────────────────────

  myPermissions: () => request<MyPermissions>('/api/me/permissions'),

  // ── 现场设备（T4.5）────────────────────────────────────
  //
  // 不指名 instanceId 就是跨实例聚合，后端按登录者的授权逐条过滤 ——
  // 前端拿到多少就是他能看多少，不需要（也不应该）在这里再筛一遍。

  fieldSummary: (instanceId?: string) =>
    request<FieldSummary>(`/api/field/summary${qs({ instanceId })}`),

  fieldDevices: (instanceId?: string) =>
    request<{ devices: FieldDeviceRecord[] }>(`/api/field/devices${qs({ instanceId })}`),

  /** 点位按设备懒加载：现场一台实例几千个点，全量拉会把首屏拖垮 */
  fieldTags: (instanceId?: string, nodeId?: string) =>
    request<{ tags: FieldTagRecord[] }>(`/api/field/tags${qs({ instanceId, nodeId })}`),

  /** 南向探测**必须**指名实例：读的是那台的 flows.json，比台账更敏感 */
  southbound: (instanceId: string) =>
    request<ProbeResult>(`/api/field/southbound${qs({ instanceId })}`),


  users: () =>
    request<{ users: UserRecord[]; roles: Role[]; grants: GrantRecord[] }>('/api/users'),

  /** 返回的一次性明文口令**只出现这一次**，不落库、不可再查 */
  createUser: (username: string, role: Role) =>
    request<{ username: string; role: Role; password: string }>('/api/users', {
      method: 'POST', body: JSON.stringify({ username, role }),
    }),

  setUserRole: (username: string, role: Role) =>
    request<void>(`/api/users/${encodeURIComponent(username)}/role`, {
      method: 'POST', body: JSON.stringify({ role }),
    }),

  setUserDisabled: (username: string, disabled: boolean) =>
    request<void>(`/api/users/${encodeURIComponent(username)}/disabled`, {
      method: 'POST', body: JSON.stringify({ disabled }),
    }),

  resetUserPassword: (username: string) =>
    request<{ username: string; password: string }>(
      `/api/users/${encodeURIComponent(username)}/password/reset`, { method: 'POST' }),

  grantInstance: (username: string, instanceId: string, level: GrantLevel) =>
    request<void>(`/api/users/${encodeURIComponent(username)}/grants`, {
      method: 'POST', body: JSON.stringify({ instanceId, level }),
    }),

  revokeInstance: (username: string, instanceId: string) =>
    request<void>(
      `/api/users/${encodeURIComponent(username)}/grants/${encodeURIComponent(instanceId)}`,
      { method: 'DELETE' }),

  // ── 备份（T4.3）────────────────────────────────────────

  /** 只看内容不下载，用于「这次备份会包含什么」 */
  inspectBackup: () => request<BackupInspect>('/api/backup/inspect', { method: 'POST' }),

  /**
   * 下载备份。
   *
   * 不能走 `request`：它用 `res.text()` 读响应，会把 tar 里的二进制按 UTF-8
   * 解码而损坏内容 —— 且**下下来的包看着正常，恢复时才炸**。这里直接取 blob。
   */
  downloadBackup: async (): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`${basePath}/api/backup`, {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const text = await res.text();
      let message = `备份失败（HTTP ${res.status}）`;
      try { message = String(JSON.parse(text).error ?? message); } catch { /* 非 JSON 用默认 */ }
      throw new ApiError(res.status, message);
    }
    const disp = res.headers.get('content-disposition') ?? '';
    const filename = filenameFrom(disp, 'thinglinks-edge-backup.tar');
    return { blob: await res.blob(), filename };
  },

  // ── 远程诊断（T4.5）────────────────────────────────────

  /**
   * 连通性与时钟探测。
   *
   * `targets` 留空时后端探当前配置的云 broker —— 现场十次里九次问的就是这个。
   * 上限 8 个目标、超时上限 15 秒，都由后端裁剪，前端不必重复限制。
   */
  diagProbe: (targets: string[], timeoutMs = 5000) =>
    request<DiagProbeResponse>('/api/diag/probe', {
      method: 'POST', body: JSON.stringify({ targets, timeoutMs }),
    }),

  /**
   * 导出诊断包。
   *
   * 与备份下载同理，**不能走 `request`**：它用 `res.text()` 读响应，
   * 会把 tar 里的二进制按 UTF-8 解码而损坏，且下下来的包看着正常、解包才炸。
   */
  diagBundle: async (probeTargets: string[], logTail = 500): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`${basePath}/api/diag/bundle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ probeTargets, logTail }),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = `导出失败（HTTP ${res.status}）`;
      try {
        const j = JSON.parse(text);
        // 自检拒绝时后端会给 hint，那句才是能照做的部分
        message = [j.error, j.hint].filter(Boolean).join(' ') || message;
      } catch { /* 非 JSON 就用默认 */ }
      throw new ApiError(res.status, message);
    }
    const disp = res.headers.get('content-disposition') ?? '';
    const filename = filenameFrom(disp, 'thinglinks-edge-diag.tar');
    return { blob: await res.blob(), filename };
  },

  // ── 流程模板（T4.6）────────────────────────────────────

  templates: () => request<{ templates: FlowTemplate[] }>('/api/templates'),

  /**
   * 建模板。两种来源二选一：
   *   · `instanceId` —— 从运行中的实例现导（要有那台实例的查看授权）
   *   · `content`    —— 直接给流程 JSON（从文件读进来的）
   */
  createTemplate: (body: {
    name: string; description?: string; instanceId?: string; content?: unknown;
  }) => request<{ template: FlowTemplate }>('/api/templates', {
    method: 'POST', body: JSON.stringify(body),
  }),

  renameTemplate: (id: string, name: string, description: string) =>
    request<{ template: FlowTemplate }>(`/api/templates/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name, description }),
    }),

  deleteTemplate: (id: string) => request<void>(`/api/templates/${id}`, { method: 'DELETE' }),

  /**
   * 下载模板文件。
   *
   * 走原生 fetch 而非 `request`：`request` 会把响应当 JSON 解析成对象，
   * 那样就拿不到原文了 —— 而模板文件要的正是**逐字节原样**的那份，
   * 重新序列化会改掉缩进和键序，跟别处导出的文件对不上 diff。
   */
  downloadTemplate: async (id: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`${basePath}/api/templates/${id}/download`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const text = await res.text();
      let message = `下载失败（HTTP ${res.status}）`;
      try { message = String(JSON.parse(text).error) || message; } catch { /* 非 JSON 用默认 */ }
      throw new ApiError(res.status, message);
    }
    const disp = res.headers.get('content-disposition') ?? '';
    return { blob: await res.blob(), filename: filenameFrom(disp, 'flows.json') };
  },

  /**
   * 套用模板到实例。
   *
   * `dryRun` 为 true 时只做兼容性检查**不动目标实例**；为 false 才真正
   * **整体替换**它的全部流程。两个分支返回不同结构，故拆成两个方法，
   * 免得调用方拿到联合类型还要自己收窄。
   */
  // ── 节点管理（01 号文 5.7）────────────────────────────
  //
  // 三个清单三条路由，别当成同一份数据的三个视图 —— 见 types.ts 的说明。

  nodeCatalog: () => request<{ entries: CatalogEntry[] }>('/api/nodes/catalog'),

  /**
   * 批准一个节点包。
   *
   * `version` 留空表示不限版本。**批准不会自动下发到实例** ——
   * 下发要重启实例（会中断现场采集），不能是「点了保存」的副作用，
   * 所以后端回的 `applied` 恒为 false，由界面提示「需下发后生效」。
   */
  approveNode: (module: string, version?: string, note?: string) =>
    request<{ entry: CatalogEntry; applied: false }>('/api/nodes/catalog', {
      method: 'POST', body: JSON.stringify({ module, version, note }),
    }),

  /** 撤销批准。已经装上的**不会**因此消失，只是以后装不上了 */
  revokeNode: (module: string) =>
    request<{ ok: true; applied: false }>(
      `/api/nodes/catalog/${encodeURIComponent(module)}`, { method: 'DELETE' }),

  nodeStore: () => request<StoreListResult>('/api/nodes/store'),

  /**
   * 往离线包库导入一个 .tgz。
   *
   * 请求体是**文件字节本身**（application/octet-stream），不是 multipart。
   * 因此不能走 `request` 的 JSON 序列化 —— 它会把 Blob 变成 "[object Blob]"。
   */
  importNodePackage: async (file: File | Blob): Promise<ImportResult> => {
    const res = await fetch(`${basePath}/api/nodes/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
      body: file,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `导入失败（HTTP ${res.status}）`;
      try { message = String(JSON.parse(text).error) || message; } catch { /* 非 JSON 用默认 */ }
      throw new ApiError(res.status, message);
    }
    return JSON.parse(text) as ImportResult;
  },

  removeNodePackage: (module: string, version: string) =>
    request<{ ok: true }>(
      `/api/nodes/store/${encodeURIComponent(`${module}@${version}`)}`, { method: 'DELETE' }),

  /**
   * 把当前批准清单写进实例并**重启**它们。
   *
   * `instances` 留空就是全部。逐台做且一台失败不中断，结果里逐台给成败 ——
   * 现场常有停着的实例，让一台挡住其余会逼人一台台手工来。
   */
  applyNodePolicy: (instances?: string[]) =>
    request<{ results: ApplyPolicyResult[] }>('/api/nodes/apply', {
      method: 'POST', body: JSON.stringify({ instances: instances ?? [] }),
    }),

  nodeInventory: () =>
    request<{ instances: InstanceInventory[] }>('/api/nodes/inventory'),

  previewApply: (instanceId: string, templateId: string) =>
    request<ApplyPreview>(`/api/instances/${instanceId}/flows`, {
      method: 'POST', body: JSON.stringify({ templateId, dryRun: true }),
    }),

  applyTemplate: (instanceId: string, templateId: string) =>
    request<ApplyResult>(`/api/instances/${instanceId}/flows`, {
      method: 'POST', body: JSON.stringify({ templateId }),
    }),
};
