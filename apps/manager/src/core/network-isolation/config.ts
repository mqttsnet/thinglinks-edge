import { dirname, isAbsolute, resolve } from 'node:path';
import { NetworkIsolationError, ipv4 } from './descriptor.ts';
export interface NetworkIsolationConfig {
  controlSocket: string; stateDir: string; healthHost: string; healthPort: number;
  extraProtectedHosts: string[]; reconcileMs: number;
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new NetworkIsolationError('网络保护服务数值配置无效', 400);
  return number;
}
export function parseNetworkIsolationConfig(env: NodeJS.ProcessEnv): NetworkIsolationConfig {
  const controlSocket = env['TLE_NET_CONTROL_SOCKET'] ?? '/run/tle-network/control.sock';
  const stateDir = env['TLE_NET_STATE_DIR'] ?? '/run/tle-network/state';
  const healthHost = env['TLE_NET_HEALTH_HOST'] ?? '0.0.0.0';
  const extraProtectedHosts = [...new Set((env['TLE_NET_EXTRA_PROTECTED_HOSTS'] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
  if (!isAbsolute(controlSocket) || controlSocket !== resolve(controlSocket) || controlSocket.length > 100
    || dirname(controlSocket) === '/' || !stateDir.startsWith(`${dirname(controlSocket)}/`) || stateDir !== resolve(stateDir)
    || !ipv4(healthHost) || extraProtectedHosts.length > 128 || extraProtectedHosts.some(host => !ipv4(host))) throw new NetworkIsolationError('网络保护服务路径或地址配置无效', 400);
  return { controlSocket, stateDir, healthHost, extraProtectedHosts,
    healthPort: integer(env['TLE_NET_HEALTH_PORT'], 31555, 1024, 65535), reconcileMs: integer(env['TLE_NET_RECONCILE_MS'], 2000, 500, 10000) };
}
export function assertRuntimeCapabilities(platform: string, uid: number | undefined, status: string): void {
  const capability = /^CapEff:\s*([a-f0-9]+)$/mi.exec(status)?.[1];
  if (platform !== 'linux' || uid !== 0 || !capability || BigInt(`0x${capability}`) !== (1n << 12n) || !/^NoNewPrivs:\s*1$/m.test(status)) {
    throw new NetworkIsolationError('网络保护必须运行于独立 Linux 容器，仅具有 NET_ADMIN 并禁止提权');
  }
}
