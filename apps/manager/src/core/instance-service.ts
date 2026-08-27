/**
 * 实例服务 —— 编排仓储与 Docker。
 *
 * 创建顺序：先在仓储内以事务占坑（端口冲突在此原子检出），再落 Docker。
 * Docker 失败时补偿删除仓储记录，避免留下「有记录无容器」的半条状态。
 */
import bcrypt from 'bcryptjs';
import type { Db } from './db.ts';
import { recordAudit } from './db.ts';
import { adminRootFor } from './config.ts';
import { InstanceRepo, type PortRecord } from './instance-repo.ts';
import { DockerClient } from './docker-client.ts';
import { renderSettings } from './settings-template.ts';
import { assertValidId } from './container-spec.ts';
import { generatePassword } from './crypto.ts';
import { validatePortMappings, recommendPorts, type PortRange, type PortMapping } from './ports.ts';
import { HealthProbe, analyzeLogs, judge, type InstanceHealth } from './health.ts';
import { readHostStats, isExhausted, type HostStats } from './host-stats.ts';

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface CreateInstanceInput {
  id: string;
  name: string;
  imageTag: string;
  memoryMb: number;
  cpus: number;
  /**
   * 端口映射表，一行一条，空数组表示不映射。
   *
   * 早先是「区间字符串 + 一个起始容器端口，其余递增」。那个抽象拟合不了真实协议布局
   * （MQTT 1883、Modbus 502、OPC UA 4840 并不连号），且填错不报错、只是连不上。
   * 现在每条映射显式给全：宿主端口、容器端口、协议、监听网卡、用途。
   */
  ports: PortMapping[];
  actor: string;
}

export interface InstanceView {
  id: string;
  name: string;
  imageTag: string;
  memLimit: number;
  cpuLimit: number;
  adminRoot: string;
  ports: PortRecord[];
  state: string;
  running: boolean;
}

export interface InstanceServiceOptions {
  db: Db;
  repo: InstanceRepo;
  docker: DockerClient;
  basePath: string;
  portRange: PortRange;
  /** 允许创建的镜像 tag 白名单 */
  allowedImageTags: string[];
  /** 校验端口时是否探测宿主实际占用；测试可关掉 */
  probeHostPorts?: boolean;
  /** 实例 HTTP 基址解析；生产按容器名，验证时可注入 */
  upstreamFor?: ((instanceId: string) => string) | undefined;
}

export class InstanceService {
  private readonly o: InstanceServiceOptions;
  private readonly probe: HealthProbe;

  constructor(options: InstanceServiceOptions) {
    this.o = options;
    this.probe = new HealthProbe({
      upstreamFor: options.upstreamFor ?? ((id) => `http://tle-nr-${id}:1880`),
      adminRootFor: (id) => options.repo.get(id)?.adminRoot,
    });
  }

  async hostStats(): Promise<HostStats> {
    return readHostStats();
  }

  /** 三层探针：容器 / 应用 / 业务 */
  async health(id: string): Promise<InstanceHealth> {
    this.assertExists(id);
    const container = await this.probe.container(this.o.docker.containerRef(id));
    const app = container.running
      ? await this.probe.app(id)
      : { ok: false, status: null, latencyMs: null, error: '容器未运行' };
    const flow = container.running
      ? analyzeLogs(await this.o.docker.logs(id, 200).catch(() => ''))
      : { started: false, recentErrors: 0, lastError: null };
    return { id, container, app, flow, verdict: judge(container, app, flow) };
  }

  async healthAll(): Promise<InstanceHealth[]> {
    const ids = this.o.repo.list().map((i) => i.id);
    return Promise.all(ids.map((id) => this.health(id).catch((e): InstanceHealth => ({
      id,
      container: { state: 'unknown', running: false, restartCount: 0, startedAt: null,
                   cpuPercent: null, memUsedMb: null, memLimitMb: null },
      app: { ok: false, status: null, latencyMs: null, error: (e as Error).message },
      flow: { started: false, recentErrors: 0, lastError: null },
      verdict: 'down',
    }))));
  }

  recommendPorts(count: number): string {
    return recommendPorts(count, this.o.portRange, this.o.repo.usedPorts());
  }

  async create(input: CreateInstanceInput): Promise<InstanceView> {
    assertValidId(input.id);
    if (!input.name.trim()) throw new ServiceError('实例名称不能为空');
    if (!this.o.allowedImageTags.includes(input.imageTag)) {
      throw new ServiceError(
        `镜像 ${input.imageTag} 不在白名单内。可用：${this.o.allowedImageTags.join('、')}`,
      );
    }
    if (this.o.repo.get(input.id)) throw new ServiceError(`实例 ${input.id} 已存在`);

    // 宿主资源逼近上限时阻止创建，而不是等它把机器压垮
    const exhausted = isExhausted(await readHostStats());
    if (exhausted.exhausted) {
      throw new ServiceError(`${exhausted.reason}，已阻止创建新实例`);
    }

    await validatePortMappings(
      input.ports, this.o.portRange, this.o.repo.usedPorts(),
      { probeHost: this.o.probeHostPorts !== false },
    );

    const adminRoot = adminRootFor(this.o.basePath, input.id);
    const password = generatePassword();
    const credSecret = generatePassword(24);
    // 接入令牌：给实例里的 @thinglinks 节点回报台账用，与管理口令分开
    const ingestToken = generatePassword(32);
    const ports: PortRecord[] = input.ports.map((m) => ({ ...m }));

    // 1. 先在仓储占坑 —— 端口冲突在事务内原子检出
    this.o.repo.create(
      {
        id: input.id, name: input.name, imageTag: input.imageTag,
        memLimit: input.memoryMb, cpuLimit: input.cpus,
        adminRoot, credSecret, notes: '',
      },
      ports,
      [{ username: 'admin', password, permissions: '*' }],
    );
    this.o.repo.setIngestToken(input.id, ingestToken);

    // 2. 再落 Docker；失败则补偿删除仓储记录
    try {
      const settings = renderSettings({
        instanceId: input.id,
        adminRoot,
        credentialSecret: credSecret,
        credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync(password, 8), permissions: '*' }],
      });
      await this.o.docker.createInstance(
        { id: input.id, imageTag: input.imageTag, memoryMb: input.memoryMb, cpus: input.cpus,
            ports, adminRoot, ingestToken },
        settings,
      );
      await this.o.docker.start(input.id);
    } catch (e) {
      this.o.repo.remove(input.id);
      await this.o.docker.remove(input.id, { removeData: true }).catch(() => undefined);
      recordAudit(this.o.db, {
        actor: input.actor, action: 'create-instance', target: input.id,
        result: 'fail', detail: (e as Error).message,
      });
      throw new ServiceError(`创建实例失败：${(e as Error).message}`);
    }

    recordAudit(this.o.db, { actor: input.actor, action: 'create-instance', target: input.id, result: 'ok' });
    return (await this.get(input.id))!;
  }

  async list(): Promise<InstanceView[]> {
    const statuses = new Map((await this.o.docker.list()).map((s) => [s.id, s]));
    return this.o.repo.list().map((r) => ({
      id: r.id, name: r.name, imageTag: r.imageTag,
      memLimit: r.memLimit, cpuLimit: r.cpuLimit, adminRoot: r.adminRoot,
      ports: this.o.repo.ports(r.id),
      state: statuses.get(r.id)?.state ?? 'missing',
      running: statuses.get(r.id)?.running ?? false,
    }));
  }

  async get(id: string): Promise<InstanceView | undefined> {
    return (await this.list()).find((i) => i.id === id);
  }

  private assertExists(id: string): void {
    if (!this.o.repo.get(id)) throw new ServiceError(`实例 ${id} 不存在`);
  }

  async start(id: string, actor: string): Promise<void> {
    this.assertExists(id);
    await this.o.docker.assertManaged(id);
    await this.o.docker.start(id);
    recordAudit(this.o.db, { actor, action: 'start-instance', target: id, result: 'ok' });
  }

  async stop(id: string, actor: string): Promise<void> {
    this.assertExists(id);
    await this.o.docker.assertManaged(id);
    await this.o.docker.stop(id);
    recordAudit(this.o.db, { actor, action: 'stop-instance', target: id, result: 'ok' });
  }

  /** 删除实例；是否连带删除数据卷由调用方显式指定，绝不默认删数据 */
  async remove(id: string, opts: { removeData: boolean; actor: string }): Promise<void> {
    this.assertExists(id);
    await this.o.docker.assertManaged(id).catch(() => undefined);
    await this.o.docker.remove(id, { removeData: opts.removeData }).catch(() => undefined);
    this.o.repo.remove(id);
    recordAudit(this.o.db, {
      actor: opts.actor, action: 'remove-instance', target: id,
      detail: opts.removeData ? '含数据卷' : '保留数据卷', result: 'ok',
    });
  }

  /** 重置实例账号口令：改仓储 → 重写 settings.js → 重启实例 */
  async resetCredential(id: string, username: string, actor: string): Promise<string> {
    const inst = this.o.repo.get(id);
    if (!inst) throw new ServiceError(`实例 ${id} 不存在`);

    const password = generatePassword();
    this.o.repo.resetCredential(id, username, password);

    const creds = this.o.repo.credentials(id);
    const settings = renderSettings({
      instanceId: id,
      adminRoot: inst.adminRoot,
      credentialSecret: inst.credSecret,
      credentials: creds.map((c) => ({
        username: c.username,
        passwordHash: bcrypt.hashSync(c.password, 8),
        permissions: c.permissions,
      })),
    });
    await this.o.docker.writeSettings(id, settings);
    await this.o.docker.restart(id);

    recordAudit(this.o.db, { actor, action: 'reset-instance-credential', target: `${id}/${username}`, result: 'ok' });
    return password;
  }

  async logs(id: string, tail = 200): Promise<string> {
    this.assertExists(id);
    await this.o.docker.assertManaged(id);
    return this.o.docker.logs(id, tail);
  }

  /** 跟随日志。与 logs 走同一套存在性与归属校验，返回未解帧的原始流 */
  async logStream(
    id: string,
    opts: { tail?: number; since?: string } = {},
  ): Promise<NodeJS.ReadableStream> {
    this.assertExists(id);
    await this.o.docker.assertManaged(id);
    return this.o.docker.logStream(id, opts);
  }
}
