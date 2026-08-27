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
export const volumeName = (id: string) => `tle-nr-${id}-data`;

/** 由固定模板生成容器配置；用户输入只影响本文件允许的字段 */
export function buildCreateOptions(
  spec: InstanceSpec,
  opts: { network: string; imageRepo: string },
): Record<string, unknown> {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const p of spec.ports) {
    const key = `${p.containerPort}/${p.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostIp: p.hostIp, HostPort: String(p.hostPort) }];
  }

  return {
    name: containerName(spec.id),
    Image: `${opts.imageRepo}:${spec.imageTag}`,
    // 非 root 运行
    User: 'node-red',
    Env: [
      `TLE_INSTANCE_ID=${spec.id}`,
      `TLE_ADMIN_ROOT=${spec.adminRoot}`,
    ],
    Labels: {
      'com.mqttsnet.thinglinks-edge.managed': 'true',
      'com.mqttsnet.thinglinks-edge.instance': spec.id,
    },
    ExposedPorts: exposed,
    HostConfig: {
      // 资源配额
      Memory: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: 512,
      // 只允许平台管理的具名卷；1880 不在 PortBindings 内，唯一入口是 Manager 反代
      Binds: [`${volumeName(spec.id)}:/data`],
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

export function assertSafeCreateOptions(options: Record<string, unknown>): void {
  const hc = (options['HostConfig'] ?? {}) as Record<string, unknown>;

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
    for (const b of binds as unknown[]) {
      if (typeof b !== 'string') throw new SpecError('Binds 元素必须是字符串');
      // 只允许平台命名规则内的具名卷，杜绝任意宿主路径挂载
      if (!/^tle-nr-[a-z0-9-]+-data:\/data$/.test(b)) {
        throw new SpecError(`禁止的挂载：${b}。只允许平台管理的具名卷挂到 /data`);
      }
    }
  }

  const pb = (hc['PortBindings'] ?? {}) as Record<string, unknown>;
  if (Object.keys(pb).some((k) => k.startsWith('1880/'))) {
    throw new SpecError('实例 1880 端口不得映射到宿主 —— 唯一入口必须是 Manager 反代');
  }
}
