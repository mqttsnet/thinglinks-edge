/**
 * Docker 相关的安装自检（T6.2）。
 *
 * 四项都从 `docker info` / `docker version` 一次拿到，所以放在一起：
 * 可用性、架构匹配、cgroup 内存限制、网段冲突。
 *
 * 这里**只读不写**：自检不该在检查过程中改变环境。
 */
import { pass, fail, skip, type CheckResult } from './types.ts';

/**
 * 最低 Docker 版本。
 *
 * 20.10 是分界：它之前的版本对 cgroup v2 支持不完整，而现在的主流发行版
 * （Debian 12、Ubuntu 22.04+、RHEL 9）默认都是 cgroup v2 ——
 * 版本太老会表现为「资源限额配了但不生效」，而且**不报错**。
 */
const MIN_DOCKER_MAJOR = 20;
const MIN_DOCKER_MINOR = 10;

interface DockerLike {
  version(): Promise<Record<string, unknown>>;
  info(): Promise<Record<string, unknown>>;
  listNetworks(): Promise<Array<Record<string, unknown>>>;
  getImage(name: string): { inspect(): Promise<Record<string, unknown>> };
}

/** Docker 版本与可用性 —— 失败**阻断** */
export async function checkDockerAvailable(docker: DockerLike): Promise<CheckResult> {
  const id = 'docker.available';
  const name = 'Docker 版本与可用性';
  let v: Record<string, unknown>;
  try {
    v = await docker.version();
  } catch (e) {
    return fail(id, name, 'block',
      `连不上 Docker 端点：${(e as Error).message}。`
      + '请确认 docker 守护进程在跑，且当前用户或受限代理有访问权限');
  }
  const server = String(v['Version'] ?? '');
  const m = /^(\d+)\.(\d+)/.exec(server);
  if (!m) {
    return fail(id, name, 'warn', `连上了但版本号读不出来（${server || '空'}），无法判断是否满足最低要求`,
      { version: server, apiVersion: v['ApiVersion'] });
  }
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const tooOld = major < MIN_DOCKER_MAJOR
    || (major === MIN_DOCKER_MAJOR && minor < MIN_DOCKER_MINOR);
  const data = { version: server, apiVersion: v['ApiVersion'], os: v['Os'], arch: v['Arch'] };
  return tooOld
    ? fail(id, name, 'block',
        `Docker ${server} 低于最低要求 ${MIN_DOCKER_MAJOR}.${MIN_DOCKER_MINOR}。`
        + '过老的版本对 cgroup v2 支持不完整，表现是「资源限额配了但不生效」且不报错', data)
    : pass(id, name, `Docker ${server}（API ${String(v['ApiVersion'] ?? '?')}）`, data);
}

/**
 * 架构与镜像匹配 —— 失败**阻断**。
 *
 * 只能检查**本机已有的**镜像：没拉下来的镜像，架构信息在本地无从得知
 * （Docker API 不会为了回答这个问题去联网）。所以本机没有目标镜像时如实跳过，
 * 而不是假装检查过了。
 */
export async function checkArchMatch(
  docker: DockerLike, images: readonly string[],
): Promise<CheckResult> {
  const id = 'docker.arch';
  const name = '架构与镜像匹配';
  let info: Record<string, unknown>;
  try {
    info = await docker.info();
  } catch (e) {
    return skip(id, name, `读不到 docker info：${(e as Error).message}`);
  }
  const daemonArch = String(info['Architecture'] ?? '');
  // docker info 用 x86_64 / aarch64，镜像用 amd64 / arm64，两套写法要归一
  const normalize = (a: string) =>
    ({ x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[a] ?? a);
  const want = normalize(daemonArch);

  const mismatched: string[] = [];
  let checked = 0;
  for (const img of images) {
    try {
      const meta = await docker.getImage(img).inspect();
      checked += 1;
      const got = normalize(String(meta['Architecture'] ?? ''));
      if (got !== want) mismatched.push(`${img}(${got})`);
    } catch { /* 本机没有这个镜像，跳过它 —— 下面按 checked 计数如实说明 */ }
  }

  const data = { daemonArch, normalized: want, checked, total: images.length };
  if (checked === 0) {
    return skip(id, name,
      `本机一个目标镜像都没有，无法核对架构（守护进程是 ${daemonArch}）。`
      + '离线现场请确认导入的镜像与此架构一致');
  }
  return mismatched.length > 0
    ? fail(id, name, 'block',
        `守护进程是 ${want}，但这些镜像不是：${mismatched.join('、')}。`
        + '架构不符的镜像起不来，且报错信息通常与架构无关，很难查',
        { ...data, mismatched })
    : pass(id, name, `${want} · 已核对 ${checked}/${images.length} 个镜像`, data);
}

/**
 * cgroup 内存限制是否可用 —— 失败**告警**。
 *
 * 这一项不阻断但很关键：限额不生效时实例可以吃光整机内存，
 * 而界面上「512 MB」的配置看起来一切正常。
 */
export async function checkCgroupMemory(docker: DockerLike): Promise<CheckResult> {
  const id = 'docker.cgroup-memory';
  const name = 'cgroup 内存限制可用性';
  let info: Record<string, unknown>;
  try {
    info = await docker.info();
  } catch (e) {
    return skip(id, name, `读不到 docker info：${(e as Error).message}`);
  }
  const memLimit = info['MemoryLimit'];
  const swapLimit = info['SwapLimit'];
  const data = {
    memoryLimit: memLimit, swapLimit,
    cgroupVersion: info['CgroupVersion'], cgroupDriver: info['CgroupDriver'],
  };
  if (memLimit === false) {
    return fail(id, name, 'warn',
      '内核未启用内存 cgroup —— **实例的内存限额不会生效**，'
      + '一个实例可以吃光整机内存，而界面上的配额看起来一切正常。'
      + '内核启动参数加 cgroup_enable=memory 后重启', data);
  }
  const note = swapLimit === false
    ? '（swap 限额不可用，超限时会先吃 swap 再被杀，表现为变慢而不是立刻重启）'
    : '';
  return pass(id, name,
    `内存限额可用 · cgroup ${String(info['CgroupVersion'] ?? '?')} / ${String(info['CgroupDriver'] ?? '?')}${note}`,
    data);
}

/** 两个 CIDR 是否重叠。只处理 IPv4 —— 企业内网冲突基本都发生在 v4 */
export function cidrOverlaps(a: string, b: string): boolean {
  const parse = (cidr: string): [number, number] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
    if (!m) return null;
    const bits = Number(m[5]);
    if (bits < 0 || bits > 32) return null;
    const addr = ((Number(m[1]) << 24) | (Number(m[2]) << 16)
      | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [(addr & mask) >>> 0, mask];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  const shared = (pa[1] & pb[1]) >>> 0;
  return ((pa[0] & shared) >>> 0) === ((pb[0] & shared) >>> 0);
}

/**
 * Docker 网段与企业内网冲突 —— 失败**告警 + 引导修改**。
 *
 * **这项检查有明确的能力边界，报告里必须说清楚**：Manager 跑在容器里，
 * 看到的路由表是容器自己的，读不到宿主的企业内网路由。所以只能拿 docker
 * 自己的网段去比对**由部署方显式声明**的内网网段（`CORPORATE_CIDRS`）。
 * 没声明时如实跳过，不假装检查过 —— 假装检查过的自检比没有自检更危险。
 */
export async function checkNetworkConflict(
  docker: DockerLike, corporateCidrs: readonly string[],
): Promise<CheckResult> {
  const id = 'docker.network-conflict';
  const name = 'Docker 网段与内网冲突';
  if (corporateCidrs.length === 0) {
    return skip(id, name,
      '未声明企业内网网段（CORPORATE_CIDRS），无法比对。'
      + 'Manager 在容器内看不到宿主路由表，这一项只能靠部署方显式提供网段');
  }
  let nets: Array<Record<string, unknown>>;
  try {
    nets = await docker.listNetworks();
  } catch (e) {
    return skip(id, name, `列不出 docker 网络：${(e as Error).message}`);
  }

  const conflicts: string[] = [];
  const dockerCidrs: string[] = [];
  for (const n of nets) {
    const ipam = n['IPAM'] as { Config?: Array<{ Subnet?: string }> } | undefined;
    for (const c of ipam?.Config ?? []) {
      if (!c.Subnet) continue;
      dockerCidrs.push(c.Subnet);
      for (const corp of corporateCidrs) {
        if (cidrOverlaps(c.Subnet, corp)) {
          conflicts.push(`${String(n['Name'])} ${c.Subnet} ⇄ ${corp}`);
        }
      }
    }
  }
  const data = { dockerCidrs, corporateCidrs: [...corporateCidrs] };
  return conflicts.length > 0
    ? fail(id, name, 'warn',
        `Docker 网段与内网重叠：${conflicts.join('；')}。`
        + '重叠会让容器访问企业内网时走错路由，表现是「某些内网地址时通时不通」。'
        + '在 /etc/docker/daemon.json 里用 default-address-pools 换一段', { ...data, conflicts })
    : pass(id, name, `${dockerCidrs.length} 个网段与声明的 ${corporateCidrs.length} 段内网无重叠`, data);
}
