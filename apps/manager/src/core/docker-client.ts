/**
 * Docker 客户端封装 —— 兄弟容器模式。
 *
 * Manager 通过（受限的）docker 端点在宿主上创建 Node-RED 兄弟容器，
 * 而非在自身容器内起子进程。决定性理由：升级 Manager 时实例是独立容器，
 * 现场采集不中断 —— 产线不会为了升级管理台而停止采集。
 *
 * 所有创建请求都必须经 assertSafeCreateOptions 二次校验后才下发。
 */
import Docker from 'dockerode';
import {
  buildCreateOptions, assertSafeCreateOptions, assertValidSpec,
  containerName, volumeName, type InstanceSpec,
} from './container-spec.ts';
import { tarFile } from './tar.ts';

/** 平台管理的容器统一打这个标签，列举与操作一律按标签过滤 */
export const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
/** 官方镜像内 node-red 用户的 uid/gid */
const NODE_RED_UID = 1000;

export interface DockerClientOptions {
  /** dockerode 连接参数；生产环境指向受限代理而非裸 socket */
  connection?: Docker.DockerOptions;
  /** 网络名前缀；每个实例拥有独立网络 `${network}-${id}` */
  network: string;
  imageRepo: string;
  portRange: { min: number; max: number };
  /**
   * Manager 自身的容器名或 id。提供后，每创建一个实例就把 Manager 接入该实例网络，
   * 使 Manager 可达实例、而实例之间互不可达。
   * 开发态 Manager 跑在宿主上时留空。
   */
  managerContainer?: string | undefined;
}

export interface InstanceStatus {
  id: string;
  name: string;
  state: string;
  running: boolean;
  imageTag: string;
  startedAt: string | null;
}

export class DockerClient {
  private readonly docker: Docker;
  private readonly opts: DockerClientOptions;

  constructor(opts: DockerClientOptions) {
    this.opts = opts;
    this.docker = new Docker(opts.connection ?? {});
  }

  /**
   * 一实例一网络。
   *
   * 用户自定义 bridge 网络内的容器彼此天然互通，若所有实例共处一网，
   * 实例 A 的 Function 节点可直接 fetch 实例 B 的 1880，绕过 Manager 全部鉴权。
   * 已用真实容器验证过该漏洞确实存在（HTTP 200），因此改为每实例独立网络。
   */
  instanceNetwork(instanceId: string): string {
    return `${this.opts.network}-${instanceId}`;
  }

  async ensureNetwork(instanceId: string): Promise<void> {
    const name = this.instanceNetwork(instanceId);
    const found = await this.docker.listNetworks({ filters: { name: [name] } });
    if (found.some((n) => n.Name === name)) return;
    await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Labels: { [MANAGED_LABEL]: 'true', 'com.mqttsnet.thinglinks-edge.instance': instanceId },
    });
  }

  /** 把 Manager 接入实例网络，使其可达实例；实例之间仍互不可达 */
  private async attachManager(instanceId: string): Promise<void> {
    const mgr = this.opts.managerContainer;
    if (!mgr) return;
    await this.docker.getNetwork(this.instanceNetwork(instanceId))
      .connect({ Container: mgr })
      .catch((e: Error) => {
        // 已连接时 Docker 报错，属正常
        if (!/already exists|already connected/i.test(e.message)) throw e;
      });
  }

  async ensureVolume(instanceId: string): Promise<void> {
    const name = volumeName(instanceId);
    try {
      await this.docker.getVolume(name).inspect();
    } catch {
      await this.docker.createVolume({ Name: name, Labels: { [MANAGED_LABEL]: 'true' } });
    }
  }

  /**
   * 创建实例容器并写入 settings.js。
   * settings.js 在容器启动前经 putArchive 落进数据卷，避免运行时再改配置。
   */
  async createInstance(spec: InstanceSpec, settingsJs: string): Promise<void> {
    assertValidSpec(spec, this.opts.portRange);
    const options = buildCreateOptions(spec, {
      network: this.instanceNetwork(spec.id),
      imageRepo: this.opts.imageRepo,
    });
    assertSafeCreateOptions(options);

    await this.ensureNetwork(spec.id);
    await this.ensureVolume(spec.id);

    const container = await this.docker.createContainer(options as Docker.ContainerCreateOptions);
    await this.attachManager(spec.id);
    await container.putArchive(
      tarFile('settings.js', settingsJs, { uid: NODE_RED_UID, gid: NODE_RED_UID, mode: 0o644 }),
      { path: '/data' },
    );
  }

  async start(instanceId: string): Promise<void> {
    await this.docker.getContainer(containerName(instanceId)).start();
  }

  async restart(instanceId: string): Promise<void> {
    await this.docker.getContainer(containerName(instanceId)).restart({ t: 10 });
  }

  /**
   * 重写实例的 settings.js。
   * Node-RED 只在启动时读取该文件，因此调用方需自行重启实例使其生效。
   */
  async writeSettings(instanceId: string, settingsJs: string): Promise<void> {
    await this.docker.getContainer(containerName(instanceId)).putArchive(
      tarFile('settings.js', settingsJs, { uid: NODE_RED_UID, gid: NODE_RED_UID, mode: 0o644 }),
      { path: '/data' },
    );
  }

  async stop(instanceId: string): Promise<void> {
    await this.docker.getContainer(containerName(instanceId)).stop({ t: 10 });
  }

  /**
   * 删除实例。只删该实例自己的卷 —— 绝不做全局 prune，
   * 上游 PoC 的 pruneVolumes() 会波及其它容器的无主卷。
   */
  async remove(instanceId: string, opts: { removeData: boolean }): Promise<void> {
    await this.docker.getContainer(containerName(instanceId)).remove({ force: true });
    // 实例网络随实例一并回收，避免残留大量空网络
    await this.docker.getNetwork(this.instanceNetwork(instanceId)).remove().catch(() => undefined);
    if (opts.removeData) {
      await this.docker.getVolume(volumeName(instanceId)).remove().catch(() => undefined);
    }
  }

  /** 只列举带平台标签的容器，避免误操作宿主上的其它容器 */
  async list(): Promise<InstanceStatus[]> {
    const items = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    });
    return items.map((c) => ({
      id: c.Labels['com.mqttsnet.thinglinks-edge.instance'] ?? '',
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      state: c.State,
      running: c.State === 'running',
      imageTag: (c.Image.split(':')[1] ?? 'unknown'),
      startedAt: c.Status || null,
    }));
  }

  /** 校验容器确属本平台管理，防止越权操作宿主上任意容器 */
  async assertManaged(instanceId: string): Promise<void> {
    const info = await this.docker.getContainer(containerName(instanceId)).inspect();
    if (info.Config.Labels?.[MANAGED_LABEL] !== 'true') {
      throw new Error(`容器 ${containerName(instanceId)} 不受本平台管理，拒绝操作`);
    }
  }

  /** 取容器引用，供健康探针读取 inspect 与 stats */
  containerRef(instanceId: string): Docker.Container {
    return this.docker.getContainer(containerName(instanceId));
  }

  async logs(instanceId: string, tail = 200): Promise<string> {
    const buf = await this.docker.getContainer(containerName(instanceId)).logs({
      stdout: true, stderr: true, tail,
    });
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  }
}
