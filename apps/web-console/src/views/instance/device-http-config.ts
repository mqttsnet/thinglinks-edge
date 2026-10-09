export interface DeviceHttpForm {
  id: string; deviceId: string; targetPath: string;
  maxBodyBytes: number | null; rateLimitPerMinute: number | null;
}

export function deviceIngressUrl(bindingId: string, basePath: string, origin: string): string {
  return `${origin}${basePath}/api/device-ingress/${encodeURIComponent(bindingId)}`;
}

export function validateDeviceHttpForm(value: DeviceHttpForm, adminRoot: string): string {
  const identity = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  if (!identity.test(value.id.trim())) return '绑定 ID 必须是 1–64 个字母、数字、下划线或连字符，以字母或数字开头';
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(value.deviceId.trim())) return '设备 ID 必须与模板中的子设备标识一致，最多 128 位，可含字母、数字、下划线、点、冒号和连字符';
  const path = value.targetPath.trim();
  if (!path.startsWith(`${adminRoot}api/`) || !/^\/[A-Za-z0-9._~/-]+$/.test(path)
    || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) return '请填写当前实例 api/ 下的固定业务路径，不含编码、查询串或相对路径';
  if (value.maxBodyBytes === null || !Number.isInteger(value.maxBodyBytes) || value.maxBodyBytes < 1024 || value.maxBodyBytes > 8388608) return '请求体上限须为 1024–8388608 字节';
  if (value.rateLimitPerMinute === null || !Number.isInteger(value.rateLimitPerMinute) || value.rateLimitPerMinute < 1 || value.rateLimitPerMinute > 6000) return '每分钟请求上限须为 1–6000 的整数';
  return '';
}
