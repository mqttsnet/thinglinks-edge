import { assertDedicatedNetwork, assertManagedDataDirectory } from '../instance/container-isolation.ts';
import { isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { AllowedHostEndpoint } from '../network-isolation/descriptor.ts';
import { createHash } from 'node:crypto';

export function deploymentRealm(config: Pick<PolicyConfig, 'dataRoot' | 'networkPrefix'>): string {
  return createHash('sha256').update(JSON.stringify({ dataRoot: config.dataRoot, networkPrefix: config.networkPrefix })).digest('hex');
}

export interface PolicyConfig {
  dataRoot: string;
  networkPrefix: string;
  managerContainer: string;
  imageRepo: string;
  allowedTags: readonly string[];
  allowedImageIds: readonly string[];
  portRange: { min: number; max: number };
  networkSocket: string;
  networkHealthPort: number;
  protectedHosts: string[];
  allowedHostEndpoints: AllowedHostEndpoint[];
  managerPort: number;
  editorPortRange: { min: number; max: number };
  stateRoot: string;
}

export const NETWORK_POLICY_DEFAULTS = {
  networkSocket: '/run/tle-network/control.sock', networkHealthPort: 31555,
  protectedHosts: [] as string[], allowedHostEndpoints: [] as AllowedHostEndpoint[],
  managerPort: 19100, editorPortRange: { min: 19200, max: 19263 }, stateRoot: '/var/lib/tle-policy',
};

/** Deliberately generic: never return Docker bodies, environment values or filesystem contents. */
export class PolicyDenied extends Error {
  readonly statusCode: number;
  constructor(statusCode = 403) {
    super('Docker operation denied by instance isolation policy');
    this.name = 'PolicyDenied'; this.statusCode = statusCode;
  }
}

export function demand(condition: unknown): asserts condition {
  if (!condition) throw new PolicyDenied();
}

export function object(value: unknown): Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  demand(Object.keys(value).every(key => allowed.includes(key)));
}

export function policyConfigFromEnv(env: NodeJS.ProcessEnv): PolicyConfig {
  const value = (name: string): string => { const result = env[name]; demand(result); return result; };
  const config: PolicyConfig = {
    dataRoot: value('TLE_POLICY_DATA_ROOT'),
    networkPrefix: value('TLE_POLICY_NETWORK_PREFIX'),
    managerContainer: value('TLE_POLICY_MANAGER_CONTAINER'),
    imageRepo: value('TLE_POLICY_IMAGE_REPO'),
    allowedTags: value('TLE_POLICY_ALLOWED_TAGS').split(',').map(x => x.trim()).filter(Boolean),
    allowedImageIds: (env['TLE_POLICY_ALLOWED_IMAGE_IDS'] ?? '').split(',').map(x => x.trim()).filter(Boolean),
    portRange: { min: Number(env['TLE_POLICY_PORT_MIN'] ?? 30000), max: Number(env['TLE_POLICY_PORT_MAX'] ?? 30999) },
    networkSocket: env['TLE_POLICY_NETWORK_SOCKET'] ?? NETWORK_POLICY_DEFAULTS.networkSocket,
    networkHealthPort: Number(env['TLE_POLICY_NETWORK_HEALTH_PORT'] ?? NETWORK_POLICY_DEFAULTS.networkHealthPort),
    protectedHosts: (env['TLE_POLICY_PROTECTED_HOSTS'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
    allowedHostEndpoints: JSON.parse(env['TLE_POLICY_ALLOWED_HOST_ENDPOINTS'] ?? '[]') as AllowedHostEndpoint[],
    managerPort: Number(env['TLE_POLICY_MANAGER_PORT'] ?? NETWORK_POLICY_DEFAULTS.managerPort),
    editorPortRange: { min: Number(env['TLE_POLICY_EDITOR_PORT_MIN'] ?? 19200), max: Number(env['TLE_POLICY_EDITOR_PORT_MAX'] ?? 19263) },
    stateRoot: env['TLE_POLICY_STATE_ROOT'] ?? NETWORK_POLICY_DEFAULTS.stateRoot,
  };
  validatePolicyConfig(config);
  return config;
}

export function validatePolicyConfig(config: PolicyConfig): void {
  assertManagedDataDirectory(config.dataRoot);
  assertDedicatedNetwork(config.networkPrefix);
  demand(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.managerContainer));
  demand(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(config.imageRepo) && !config.imageRepo.includes('..'));
  demand(config.allowedTags.length > 0 && config.allowedTags.length <= 32
    && config.allowedTags.every(tag => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tag)));
  demand(config.allowedImageIds.length <= 32 && config.allowedImageIds.every(id => /^sha256:[a-f0-9]{64}$/.test(id)));
  demand(Number.isInteger(config.portRange.min) && Number.isInteger(config.portRange.max)
    && config.portRange.min >= 1024 && config.portRange.max <= 65535 && config.portRange.min <= config.portRange.max);
  demand(isAbsolute(config.networkSocket) && resolve(config.networkSocket) === config.networkSocket
    && config.networkSocket.startsWith('/run/tle-network/') && !/[\0\r\n]/.test(config.networkSocket));
  assertManagedDataDirectory(config.stateRoot);
  demand(config.stateRoot !== config.dataRoot && !config.stateRoot.startsWith(`${config.dataRoot}/`));
  demand(Number.isInteger(config.networkHealthPort) && config.networkHealthPort >= 1024 && config.networkHealthPort <= 65535);
  demand(Number.isInteger(config.managerPort) && config.managerPort >= 1024 && config.managerPort <= 65535);
  demand(Number.isInteger(config.editorPortRange.min) && Number.isInteger(config.editorPortRange.max)
    && config.editorPortRange.min >= 1024 && config.editorPortRange.max <= 65535 && config.editorPortRange.min <= config.editorPortRange.max);
  demand(Array.isArray(config.protectedHosts) && config.protectedHosts.length <= 128 && config.protectedHosts.every(address => isIP(address) === 4));
  const forbiddenPorts = new Set([22, 1880, 2375, 2376, config.managerPort, config.networkHealthPort]);
  demand(![22, 1880, 2375, 2376, config.managerPort].includes(config.networkHealthPort)
    && (config.networkHealthPort < config.editorPortRange.min || config.networkHealthPort > config.editorPortRange.max));
  demand(Array.isArray(config.allowedHostEndpoints) && config.allowedHostEndpoints.length <= 64);
  for (const raw of config.allowedHostEndpoints) {
    const endpoint = object(raw); keys(endpoint, ['address', 'port', 'protocol']);
    demand(typeof endpoint['address'] === 'string' && isIP(endpoint['address']) === 4
      && typeof endpoint['port'] === 'number' && Number.isInteger(endpoint['port']) && endpoint['port'] > 0 && endpoint['port'] <= 65535
      && ['tcp', 'udp'].includes(String(endpoint['protocol'])) && !forbiddenPorts.has(endpoint['port'])
      && (endpoint['port'] < config.editorPortRange.min || endpoint['port'] > config.editorPortRange.max));
  }
}
