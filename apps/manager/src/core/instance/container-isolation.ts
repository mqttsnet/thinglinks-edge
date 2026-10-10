/** Pure creation contract, shared by Manager and the Docker execution boundary. */
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { networkBootstrapEntrypoint, INSTANCE_STARTUP_ENV, INSTANCE_IPV6_SYSCTLS } from './network-bootstrap.ts';

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

export const INSTANCE_USER = '1000:1000';
export const INSTANCE_TMPFS = 'rw,noexec,nosuid,nodev,size=64m';
export const INSTANCE_LOG_CONFIG = {
  Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' },
} as const;

const CREATE_KEYS = new Set(['name', 'Image', 'User', 'Env', 'Labels', 'ExposedPorts', 'HostConfig', 'Entrypoint', 'Cmd']);
const HOST_KEYS = new Set([
  'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'Binds', 'PortBindings',
  'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'RestartPolicy', 'NetworkMode', 'Tmpfs', 'LogConfig', 'Sysctls',
]);

export interface ContainerIsolationPolicy {
  /** Trusted absolute path, derived from configured data root plus checked ownership. */
  dataDirectory: string;
  /** Network id whose instance ownership has been checked independently of the request. */
  network: string;
  containerName: string;
  restartPolicy: 'unless-stopped' | 'no';
  portRange?: { min: number; max: number };
}

/** Docker inspect includes engine defaults. Normalize only after checking dangerous non-defaults. */
export function assertContainerRuntimeIsolation(
  info: Record<string, unknown>, policy: ContainerIsolationPolicy & { networkName: string },
): void {
  const config = record(info['Config'], 'Config'), host = record(info['HostConfig'], 'HostConfig');
  if (info['Name'] !== `/${policy.containerName}` || host['Privileged'] === true) {
    throw new SpecError('运行容器名或特权设置不符合实例隔离要求');
  }
  if (host['NetworkMode'] !== policy.network && host['NetworkMode'] !== policy.networkName) {
    throw new SpecError('运行容器未使用本实例独立网络');
  }
  for (const key of ['PidMode', 'UTSMode', 'UsernsMode', 'CgroupParent']) {
    if (host[key] !== undefined && host[key] !== '') throw new SpecError('运行容器共享了系统命名空间');
  }
  if (![undefined, '', 'private'].includes(host['IpcMode'] as string | undefined)
    || ![undefined, 'private'].includes(host['CgroupnsMode'] as string | undefined)) {
    throw new SpecError('运行容器共享了系统命名空间');
  }
  for (const key of ['Devices', 'DeviceRequests', 'CapAdd', 'Mounts', 'VolumesFrom', 'GroupAdd', 'ExtraHosts', 'Links', 'DeviceCgroupRules']) {
    if (host[key] !== undefined && host[key] !== null && !(Array.isArray(host[key]) && host[key].length === 0)) {
      throw new SpecError('运行容器包含未授权的设备、挂载或能力');
    }
  }
  const mounts = info['Mounts'];
  if (!Array.isArray(mounts) || mounts.length !== 1) throw new SpecError('运行容器必须仅挂载自身数据目录');
  const mount = record(mounts[0], 'Mount');
  if (mount['Type'] !== 'bind' || mount['Source'] !== policy.dataDirectory || mount['Destination'] !== '/data') {
    throw new SpecError('运行容器数据目录归属不匹配');
  }
  const selected = Object.fromEntries([...HOST_KEYS].map(key => [key, host[key]]));
  selected['NetworkMode'] = policy.network;
  const restart = record(host['RestartPolicy'], 'RestartPolicy');
  if (restart['MaximumRetryCount'] !== undefined && restart['MaximumRetryCount'] !== 0) {
    throw new SpecError('运行容器使用了未批准的重启参数');
  }
  selected['RestartPolicy'] = { Name: restart['Name'] };
  assertContainerIsolation({
    name: policy.containerName, Image: info['Image'], User: config['User'], Env: config['Env'],
    Entrypoint: config['Entrypoint'], Cmd: config['Cmd'],
    Labels: config['Labels'], HostConfig: selected,
    ExposedPorts: Object.fromEntries(Object.keys(record(host['PortBindings'] ?? {}, 'PortBindings')).map(key => [key, {}])),
  }, policy);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SpecError(`${label} 必须是配置对象`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SpecError(`容器配置命中禁用项 ${label}.${key}`);
  }
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function integerRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Lexical check only: the caller must also reject symlinks before filesystem operations. */
export function assertManagedDataDirectory(directory: string): void {
  if (!isAbsolute(directory) || directory.includes(':') || /[\0\r\n]/.test(directory)
    || directory !== resolve(directory) || directory === '/') {
    throw new SpecError('实例数据目录必须是规范的受管绝对路径');
  }
  for (const system of ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run', '/boot']) {
    if (directory === system || directory.startsWith(`${system}/`)) {
      throw new SpecError('实例数据目录不得位于宿主系统目录');
    }
  }
}

/** Reject built-in and shared namespaces even if a caller accidentally trusts their names. */
export function assertDedicatedNetwork(network: unknown): asserts network is string {
  if (typeof network !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)
    || ['host', 'bridge', 'default', 'none'].includes(network)) {
    throw new SpecError('必须使用独立的受管实例网络');
  }
}

export function assertContainerIsolation(
  options: Record<string, unknown>, policy: ContainerIsolationPolicy,
): void {
  onlyKeys(record(options, 'CreateOptions'), CREATE_KEYS, 'CreateOptions');
  const host = record(options['HostConfig'], 'HostConfig');
  onlyKeys(host, HOST_KEYS, 'HostConfig');
  if (options['name'] !== policy.containerName) throw new SpecError('容器名与实例归属不匹配');
  if (!exactStrings(options['Entrypoint'], networkBootstrapEntrypoint()) || !exactStrings(options['Cmd'], [])) {
    throw new SpecError('必须使用固定的网络隔离启动门禁，不允许替换启动命令');
  }
  const environment = options['Env'];
  if (!Array.isArray(environment) || !environment.every(value => typeof value === 'string')) {
    throw new SpecError('容器环境变量格式错误');
  }
  // The optional compatibility artifact is supplied by a trusted image, never
  // by writable instance data. Ordinary images leave this variable absent.
  const nativeOverrides = environment.filter(value => value === 'OPCUA_OPEN62541_ADDON'
    || value.startsWith('OPCUA_OPEN62541_ADDON='));
  if (nativeOverrides.length > 1 || (nativeOverrides.length === 1
    && nativeOverrides[0] !== 'OPCUA_OPEN62541_ADDON=/opt/thinglinks/opcua-native/opcua_open62541.node')) {
    throw new SpecError('OPC UA 原生构件仅允许使用受管镜像内的固定只读路径');
  }
  for (const expected of INSTANCE_STARTUP_ENV) {
    const prefix = expected.slice(0, expected.indexOf('=') + 1);
    const values = environment.filter(value => value.startsWith(prefix));
    if (values.length !== 1 || values[0] !== expected) throw new SpecError('禁止通过环境变量注入启动代码');
  }
  // A username can resolve to uid 0 in a substituted image. Pin both numeric ids.
  if (options['User'] !== INSTANCE_USER) throw new SpecError('必须以固定非 root UID/GID 运行');
  if (host['ReadonlyRootfs'] !== true) throw new SpecError('必须启用只读根文件系统');
  if (!exactStrings(host['CapDrop'], ['ALL'])) throw new SpecError('必须裁剪全部 Linux capabilities');
  if (!exactStrings(host['SecurityOpt'], ['no-new-privileges:true'])) {
    throw new SpecError('必须禁止提权且不可覆盖系统安全配置');
  }
  const sysctls = record(host['Sysctls'], 'Sysctls');
  if (Object.keys(sysctls).length !== 2 || Object.entries(INSTANCE_IPV6_SYSCTLS).some(([key, value]) => sysctls[key] !== value)) {
    throw new SpecError('当前实例网络保护必须关闭容器 IPv6，禁止其他内核参数');
  }

  assertDedicatedNetwork(policy.network);
  if (host['NetworkMode'] !== policy.network) throw new SpecError('网络与已核验的实例网络不匹配');
  assertManagedDataDirectory(policy.dataDirectory);
  if (!exactStrings(host['Binds'], [`${policy.dataDirectory}:/data`])) {
    throw new SpecError('只允许唯一挂载本实例受管数据目录');
  }

  if (!integerRange(host['Memory'], 64 * 1024 ** 2, 65536 * 1024 ** 2)
    || host['MemorySwap'] !== host['Memory']
    || !integerRange(host['NanoCpus'], 1, 64 * 1e9) || host['PidsLimit'] !== 512) {
    throw new SpecError('必须配置有限的内存、无额外 swap、CPU 与进程配额');
  }
  const tmpfs = record(host['Tmpfs'], 'Tmpfs');
  if (Object.keys(tmpfs).length !== 1 || tmpfs['/tmp'] !== INSTANCE_TMPFS) {
    throw new SpecError('只允许受限的临时目录挂载');
  }
  const restart = record(host['RestartPolicy'], 'RestartPolicy');
  if (Object.keys(restart).length !== 1 || restart['Name'] !== policy.restartPolicy) {
    throw new SpecError('重启策略与实例用途不匹配');
  }
  const log = record(host['LogConfig'], 'LogConfig');
  const logOptions = record(log['Config'], 'LogConfig.Config');
  if (Object.keys(log).length !== 2 || log['Type'] !== INSTANCE_LOG_CONFIG.Type
    || Object.keys(logOptions).length !== 2
    || logOptions['max-size'] !== INSTANCE_LOG_CONFIG.Config['max-size']
    || logOptions['max-file'] !== INSTANCE_LOG_CONFIG.Config['max-file']) {
    throw new SpecError('必须启用受限的本地容器日志轮转');
  }

  const bindings = record(host['PortBindings'], 'PortBindings');
  const exposed = record(options['ExposedPorts'], 'ExposedPorts');
  const range = policy.portRange ?? { min: 1024, max: 65535 };
  if (Object.keys(exposed).length !== Object.keys(bindings).length) {
    throw new SpecError('声明端口与发布端口不一致');
  }
  const usedPorts = new Set<string>();
  for (const [key, value] of Object.entries(bindings)) {
    const match = /^(\d{1,5})\/(tcp|udp)$/.exec(key);
    if (!match || !integerRange(Number(match[1]), 1, 65535)) throw new SpecError('协议端口非法');
    if (Number(match[1]) === 1880) throw new SpecError('实例 1880 端口不得映射到宿主');
    if (Object.keys(record(exposed[key], 'ExposedPorts entry')).length !== 0
      || !Array.isArray(value) || value.length !== 1) throw new SpecError('端口映射格式非法');
    const binding = record(value[0], 'PortBinding');
    onlyKeys(binding, new Set(['HostIp', 'HostPort']), 'PortBinding');
    if (typeof binding['HostIp'] !== 'string' || !isIP(binding['HostIp'])
      || typeof binding['HostPort'] !== 'string' || !/^[1-9]\d{0,4}$/.test(binding['HostPort'])
      || !integerRange(Number(binding['HostPort']), range.min, range.max)
      || usedPorts.has(binding['HostPort'])) throw new SpecError('宿主端口不合法或重复');
    usedPorts.add(binding['HostPort']);
  }
}
