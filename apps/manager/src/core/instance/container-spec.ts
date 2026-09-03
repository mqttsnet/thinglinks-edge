/**
 * 容器创建参数硬白名单。
 *
 * 这是比 docker-socket-proxy 更重要的一道防线：socket-proxy 只限制「能调哪些 API」，
 * 不限制调用参数。只要能创建容器并自由指定 Binds / Privileged / PidMode，
 * 攻破 Manager 就等于拿下宿主。
 *
 * 因此用户输入永远不直接拼进 docker 参数 —— 只能填本文件定义的有限字段，
 * 由固定模板生成最终配置，并在下发前二次校验。
 */

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { registryEnv } from '../nodes/policy.ts';

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

export interface PortBinding {
  /** 宿主端口 */
  hostPort: number;
  /** 容器端口 */
  containerPort: number;
  protocol: 'tcp' | 'udp';
  /** 绑定网卡地址；默认只绑回环，避免把设备端口暴露到办公网 */
  hostIp: string;
}

export interface InstanceSpec {
  id: string;
  imageTag: string;
  memoryMb: number;
  cpus: number;
  ports: PortBinding[];
  /** 由 config.adminRootFor 派生，写进容器环境供 settings.js 使用 */
  adminRoot: string;
  /**
   * `@thinglinks` 节点回报台账用的接入令牌。
   * 留空则节点降级为「只跑流程、不回报」，不影响采集本身。
   */
  ingestToken?: string | undefined;
  /**
   * Manager 在实例网络上的地址（形如 `http://tle-mgr:19100/nodered`）。
   * Manager 跑在宿主上时解析不到容器名，此处留空 —— 节点会打一条警告后静默跳过回报。
   */
  managerUrl?: string | undefined;
  /**
   * 私有 npm 源地址（形如 `http://tle-mgr:19100/nodered/npm/`）。
   *
   * 必须是**容器内**可达的地址：取它的是容器里的 npm 进程，不是浏览器。
   * 留空则实例沿用镜像默认的公网源 —— 有外网的现场可以这样，
   * 但白名单仍然生效（那是 settings.js 管的，与源无关）。
   */
  npmRegistry?: string | undefined;
}

/** 实例 id 严格字符集 —— 它会进入容器名、卷名、网络名与访问路径 */
const ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export function assertValidId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new SpecError(
      `实例 ID 非法：${JSON.stringify(id)}。只允许小写字母、数字与连字符，` +
        '以字母开头、字母或数字结尾，长度 3-32',
    );
  }
}

export function assertValidSpec(spec: InstanceSpec, portRange: { min: number; max: number }): void {
  assertValidId(spec.id);

  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(spec.imageTag)) {
    throw new SpecError(`镜像 tag 非法：${JSON.stringify(spec.imageTag)}`);
  }
  if (!Number.isInteger(spec.memoryMb) || spec.memoryMb < 64 || spec.memoryMb > 65536) {
    throw new SpecError(`内存上限须为 64-65536 MB 的整数，收到 ${spec.memoryMb}`);
  }
  if (!(spec.cpus > 0 && spec.cpus <= 64)) {
    throw new SpecError(`CPU 配额须在 (0, 64] 之间，收到 ${spec.cpus}`);
  }

  const seen = new Set<number>();
  for (const p of spec.ports) {
    if (!Number.isInteger(p.hostPort) || p.hostPort < portRange.min || p.hostPort > portRange.max) {
      throw new SpecError(
        `宿主端口 ${p.hostPort} 超出允许范围 ${portRange.min}-${portRange.max}`,
      );
    }
    if (!Number.isInteger(p.containerPort) || p.containerPort < 1 || p.containerPort > 65535) {
      throw new SpecError(`容器端口非法：${p.containerPort}`);
    }
    if (seen.has(p.hostPort)) {
      throw new SpecError(`宿主端口重复：${p.hostPort}`);
    }
    seen.add(p.hostPort);
  }
}

export const containerName = (id: string) => `tle-nr-${id}`;
export const BOOTSTRAP_TX_LABEL = 'com.mqttsnet.thinglinks-edge.bootstrap-tx';
export const MIGRATION_TX_LABEL = 'com.mqttsnet.thinglinks-edge.migration-tx';
export const MIGRATION_PROBE_LABEL = 'com.mqttsnet.thinglinks-edge.migration-probe';
const BOOTSTRAP_TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMMUTABLE_IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export function assertImmutableImageId(imageId: string): void {
  if (!IMMUTABLE_IMAGE_ID.test(imageId)) {
    throw new SpecError('不可变镜像 ID 必须是 sha256: 后跟 64 位小写十六进制');
  }
}

function assertTxId(txId: string): void {
  if (!BOOTSTRAP_TX_ID.test(txId)) throw new SpecError('migration tx id 非法');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function migrationProbeName(instanceId: string, txId: string): string {
  assertValidId(instanceId);
  assertTxId(txId);
  return `tle-nr-migrate-${instanceId}-${shortHash(txId)}`;
}

export function migrationProbeNetworkName(instanceId: string, txId: string): string {
  return `${migrationProbeName(instanceId, txId)}-net`;
}

export function migrationProbeDataDir(root: string, instanceId: string, txId: string): string {
  assertValidId(instanceId);
  assertTxId(txId);
  if (!isAbsolute(root)) throw new SpecError('probe data root 必须是绝对路径');
  const parent = resolve(root, '.thinglinks-probes');
  const path = resolve(parent, instanceId, txId);
  const rel = relative(parent, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SpecError('probe data path 越界');
  return path;
}

/**
 * 实例数据目录（宿主路径）。
 *
 * 原先用 docker 具名卷 `tle-nr-{id}-data`，改成宿主目录 bind 是为了让运维能在一个
 * 已知位置直接看到数据，而不是去 /var/lib/docker/volumes 里翻。
 *
 * **不要改回「具名卷 + driver_opts 绑宿主路径」**：实测 `docker volume rm` 只删卷元数据、
 * 不动宿主目录内容，那样删除实例时 removeData 会静默失效 —— 用户以为数据删了，其实还在。
 */
export const instanceDataDir = (root: string, id: string) => `${root}/${id}`;

/** 由固定模板生成容器配置；用户输入只影响本文件允许的字段 */
export function buildCreateOptions(
  spec: InstanceSpec,
  opts: {
    network: string; imageRepo: string; instanceDataRoot: string; timezone: string;
    /**
     * 出网代理环境变量（03 号文 2.10）。实例装第三方节点要出网，
     * 而现场常常只有企业代理这一条路。留空表示不配 —— 离线部署即此形态。
     */
    proxyEnv?: readonly string[];
    /** 仅由全新实例 bootstrap 专用创建路径传入；普通重建不得携带。 */
    bootstrapTxId?: string;
    /** 仅由 same-image rebuild/probe 使用；普通创建仍固定使用仓储 image tag。 */
    imageIdOverride?: string;
  },
): Record<string, unknown> {
  if (opts.bootstrapTxId !== undefined && !BOOTSTRAP_TX_ID.test(opts.bootstrapTxId)) {
    throw new SpecError('bootstrap tx id 非法');
  }
  if (opts.imageIdOverride !== undefined) assertImmutableImageId(opts.imageIdOverride);
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const p of spec.ports) {
    const key = `${p.containerPort}/${p.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostIp: p.hostIp, HostPort: String(p.hostPort) }];
  }

  return {
    name: containerName(spec.id),
    Image: opts.imageIdOverride ?? `${opts.imageRepo}:${spec.imageTag}`,
    // 非 root 运行
    User: 'node-red',
    Env: [
      // 官方镜像默认 UTC，不给 TZ 的话定时流程与时间戳会整体偏移，且不报错
      `TZ=${opts.timezone}`,
      `TLE_INSTANCE_ID=${spec.id}`,
      `TLE_ADMIN_ROOT=${spec.adminRoot}`,
      // 两者都具备才注入，避免容器里出现半套配置：
      // 只有令牌没有地址，节点会以为能回报却连不上，比干脆不配更难查
      ...(spec.ingestToken && spec.managerUrl
        ? [`TLE_INGEST_TOKEN=${spec.ingestToken}`, `TLE_MANAGER_URL=${spec.managerUrl}`]
        : []),
      /*
       * 私有 npm 源。用环境变量而不是往 /data/.npmrc 里写 registry= ——
       * 后者够不着 Node-RED 装包前那次版本预检（`npm info` 的 cwd 是
       * /usr/src/node-red，不是 /data），详见 core/nodes/policy.ts 的 registryEnv。
       */
      ...registryEnv(spec.npmRegistry ?? ''),
      /*
       * 出网代理。NO_PROXY 由平台补齐过内部条目（见 core/proxy.ts）——
       * 漏了容器名的话，实例回报台账、Manager 反代实例都会被绕去代理，
       * 表现是 502 或探针不通，而代理日志里只有一串解析不了的主机名。
       */
      ...(opts.proxyEnv ?? []),
    ],
    Labels: {
      'com.mqttsnet.thinglinks-edge.managed': 'true',
      'com.mqttsnet.thinglinks-edge.instance': spec.id,
      ...(opts.bootstrapTxId ? { [BOOTSTRAP_TX_LABEL]: opts.bootstrapTxId } : {}),
    },
    ExposedPorts: exposed,
    HostConfig: {
      // 资源配额
      Memory: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: 512,
      // 只允许平台计算出的本实例数据目录；1880 不在 PortBindings 内，唯一入口是 Manager 反代
      Binds: [`${instanceDataDir(opts.instanceDataRoot, spec.id)}:/data`],
      PortBindings: bindings,
      // 权限裁剪
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: opts.network,
      // 只读根文件系统下这些目录仍需可写
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
    },
  };
}

/** Build the stopped-copy probe. It has no published ports and is tx-owned. */
export function buildMigrationProbeCreateOptions(
  spec: InstanceSpec,
  opts: {
    instanceDataRoot: string;
    imageRepo: string;
    timezone: string;
    txId: string;
    imageId: string;
    networkId: string;
    proxyEnv?: readonly string[];
  },
): Record<string, unknown> {
  assertTxId(opts.txId);
  assertImmutableImageId(opts.imageId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(opts.networkId)) {
    throw new SpecError('probe network id 非法');
  }
  const options = buildCreateOptions({ ...spec, ports: [] }, {
    network: opts.networkId,
    imageRepo: opts.imageRepo,
    instanceDataRoot: opts.instanceDataRoot,
    timezone: opts.timezone,
    ...(opts.proxyEnv ? { proxyEnv: opts.proxyEnv } : {}),
    imageIdOverride: opts.imageId,
  });
  options['name'] = migrationProbeName(spec.id, opts.txId);
  options['Labels'] = {
    ...(options['Labels'] as Record<string, unknown>),
    [MIGRATION_TX_LABEL]: opts.txId,
    [MIGRATION_PROBE_LABEL]: 'true',
  };
  const host = options['HostConfig'] as Record<string, unknown>;
  host['Binds'] = [`${migrationProbeDataDir(opts.instanceDataRoot, spec.id, opts.txId)}:/data`];
  host['PortBindings'] = {};
  host['RestartPolicy'] = { Name: 'no' };
  options['ExposedPorts'] = {};
  return options;
}

/** 下发前的二次校验：确保模板没有被意外改出提权配置 */
const FORBIDDEN_HOST_CONFIG = [
  'Privileged',
  'CapAdd',
  'Devices',
  'DeviceCgroupRules',
  'IpcMode',
  'UsernsMode',
  'CgroupParent',
  'Sysctls',
] as const;

export function assertSafeCreateOptions(
  options: Record<string, unknown>,
  opts: { instanceDataRoot: string },
): void {
  const hc = (options['HostConfig'] ?? {}) as Record<string, unknown>;
  const labels = (options['Labels'] ?? {}) as Record<string, unknown>;
  const bootstrapTxId = labels[BOOTSTRAP_TX_LABEL];
  if (bootstrapTxId !== undefined && (
    typeof bootstrapTxId !== 'string' || !BOOTSTRAP_TX_ID.test(bootstrapTxId)
  )) {
    throw new SpecError('bootstrap tx label 非法');
  }

  for (const key of FORBIDDEN_HOST_CONFIG) {
    if (hc[key] !== undefined) {
      throw new SpecError(`容器配置命中禁用项 HostConfig.${key}`);
    }
  }
  if (hc['Privileged'] === true) throw new SpecError('禁止特权容器');
  if (hc['ReadonlyRootfs'] !== true) throw new SpecError('必须启用只读根文件系统');
  if (options['User'] !== 'node-red') throw new SpecError('必须以非 root 身份运行');

  for (const mode of ['NetworkMode', 'PidMode'] as const) {
    const v = hc[mode];
    if (typeof v === 'string' && (v === 'host' || v.startsWith('host'))) {
      throw new SpecError(`禁止使用宿主 ${mode}`);
    }
  }

  const binds = hc['Binds'];
  if (binds !== undefined) {
    if (!Array.isArray(binds)) throw new SpecError('Binds 必须是数组');
    // 合法挂载只有一个，且完全由平台算出：数据根来自配置，实例 id 取自标签并过 ID_RE。
    // 用「精确等于」而不是模式匹配 —— 模式匹配留给 ../ 之类构造的余地，等号不留。
    const instanceId = labels['com.mqttsnet.thinglinks-edge.instance'];
    if (typeof instanceId !== 'string') {
      throw new SpecError('缺少实例标签，无法校验数据目录挂载');
    }
    assertValidId(instanceId);
    const allowed = `${instanceDataDir(opts.instanceDataRoot, instanceId)}:/data`;
    for (const b of binds as unknown[]) {
      if (b !== allowed) {
        throw new SpecError(`禁止的挂载：${String(b)}。只允许 ${allowed}`);
      }
    }
  }

  // TZ 必须是像样的时区名。少传 timezone 时模板会生成 `TZ=undefined`，
  // 容器不会报错、只是退回 UTC —— 定时流程和时间戳整体偏移且毫无症状。
  // 类型系统在这里指望不上：测试文件被 tsconfig 排除，不参与类型检查。
  const env = (options['Env'] ?? []) as unknown[];
  const tz = env.find((e) => typeof e === 'string' && e.startsWith('TZ='));
  const zone = typeof tz === 'string' ? tz.slice(3) : '';
  // 用运行时自带的时区库做真校验，而不是拿正则猜格式：
  // 漏传 timezone 会生成字面量 `TZ=undefined`，那串字符恰好能通过任何宽松的正则，
  // 却是个无效时区 —— 容器不报错，只是退回 UTC。
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new SpecError(`容器时区非法或缺失：${JSON.stringify(zone)}。缺时区会让容器静默跑在 UTC 上`);
  }

  const pb = (hc['PortBindings'] ?? {}) as Record<string, unknown>;
  if (Object.keys(pb).some((k) => k.startsWith('1880/'))) {
    throw new SpecError('实例 1880 端口不得映射到宿主 —— 唯一入口必须是 Manager 反代');
  }
}

/** Probe-specific secondary guard for its independent sibling data root. */
export function assertSafeMigrationProbeOptions(
  options: Record<string, unknown>,
  opts: { instanceDataRoot: string; instanceId: string; txId: string },
): void {
  assertValidId(opts.instanceId);
  assertTxId(opts.txId);
  const labels = (options['Labels'] ?? {}) as Record<string, unknown>;
  const host = (options['HostConfig'] ?? {}) as Record<string, unknown>;
  if (
    labels['com.mqttsnet.thinglinks-edge.managed'] !== 'true'
    || labels['com.mqttsnet.thinglinks-edge.instance'] !== opts.instanceId
    || labels[MIGRATION_TX_LABEL] !== opts.txId
    || labels[MIGRATION_PROBE_LABEL] !== 'true'
  ) throw new SpecError('probe 标签归属不匹配');
  if (options['name'] !== migrationProbeName(opts.instanceId, opts.txId)) {
    throw new SpecError('probe 容器名不匹配');
  }
  assertImmutableImageId(String(options['Image'] ?? ''));
  if (options['User'] !== 'node-red' || host['ReadonlyRootfs'] !== true) {
    throw new SpecError('probe 必须以只读根非 root 运行');
  }
  for (const key of FORBIDDEN_HOST_CONFIG) {
    if (host[key] !== undefined) throw new SpecError(`probe 命中禁用项 HostConfig.${key}`);
  }
  const expectedBind = `${migrationProbeDataDir(
    opts.instanceDataRoot, opts.instanceId, opts.txId,
  )}:/data`;
  if (JSON.stringify(host['Binds']) !== JSON.stringify([expectedBind])) {
    throw new SpecError('probe 挂载路径不匹配');
  }
  if (Object.keys((host['PortBindings'] ?? {}) as Record<string, unknown>).length !== 0) {
    throw new SpecError('probe 不得映射宿主端口');
  }
  if (Object.keys((options['ExposedPorts'] ?? {}) as Record<string, unknown>).length !== 0) {
    throw new SpecError('probe 不得暴露端口');
  }
  if ((host['RestartPolicy'] as { Name?: unknown } | undefined)?.Name !== 'no') {
    throw new SpecError('probe 不得配置自动重启');
  }
}
