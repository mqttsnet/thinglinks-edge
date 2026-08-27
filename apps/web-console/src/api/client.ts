/**
 * API 客户端。
 *
 * 两个约定与后端对齐：
 *   写操作必须带 x-csrf-token（值取自后端下发的 tle_csrf Cookie，双提交模式）；
 *   401 表示未登录，由调用方跳转登录页，而不是在这里硬跳转。
 */
import type {
  SessionUser, Instance, InstanceHealth, HostStats, HealthSummary, CreateInstanceBody,
  MetricsRange, MetricsSeries, VersionInfo, ImageOption,
  CloudConfigView, CloudConfigInput, CloudStatus, SpoolMetrics,
  UserRecord, GrantRecord, MyPermissions, BackupInspect, Role, GrantLevel,
} from './types';

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

export const api = {
  login: (username: string, password: string) =>
    request<{ user: SessionUser }>('/api/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),

  logout: () => request<void>('/api/logout', { method: 'POST' }),

  me: () => request<{ user: SessionUser }>('/api/me'),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<void>('/api/change-password', {
      method: 'POST', body: JSON.stringify({ oldPassword, newPassword }),
    }),

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
  }>('/api/cloud'),

  saveCloud: (input: CloudConfigInput) =>
    request<{ config: CloudConfigView; status: CloudStatus }>('/api/cloud', {
      method: 'PUT', body: JSON.stringify(input),
    }),

  reconnectCloud: () =>
    request<{ status: CloudStatus }>('/api/cloud/reconnect', { method: 'POST' }),

  unlinkCloud: () =>
    request<{ status: CloudStatus }>('/api/cloud', { method: 'DELETE' }),

  // ── 用户与权限（T4.4）──────────────────────────────────

  myPermissions: () => request<MyPermissions>('/api/me/permissions'),

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
    const filename = /filename="([^"]+)"/.exec(disp)?.[1] ?? 'thinglinks-edge-backup.tar';
    return { blob: await res.blob(), filename };
  },
};
