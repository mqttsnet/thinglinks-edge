/**
 * API 客户端。
 *
 * 两个约定与后端对齐：
 *   写操作必须带 x-csrf-token（值取自后端下发的 tle_csrf Cookie，双提交模式）；
 *   401 表示未登录，由调用方跳转登录页，而不是在这里硬跳转。
 */
import type {
  SessionUser, Instance, InstanceHealth, HostStats, HealthSummary, CreateInstanceBody,
} from './types';

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

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });

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
};
