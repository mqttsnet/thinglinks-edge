/**
 * Docker 客户端封装 —— 兄弟容器模式。
 *
 * Manager 通过（受限的）docker 端点在宿主上创建 Node-RED 兄弟容器，
 * 而非在自身容器内起子进程。决定性理由：升级 Manager 时实例是独立容器，
 * 现场采集不中断 —— 产线不会为了升级管理台而停止采集。
 *
 * 所有创建请求都必须经 assertSafeCreateOptions 二次校验后才下发。
 */
import { mkdir, rm, cp } from 'node:fs/promises';
import Docker from 'dockerode';
import {
  buildCreateOptions, assertSafeCreateOptions, assertValidSpec,
  containerName, instanceDataDir, type InstanceSpec,
} from './container-spec.ts';
import { tarFile } from '../archive/tar.ts';
import { dockerLogToText } from './log-stream.ts';

/** 平台管理的容器统一打这个标签，列举与操作一律按标签过滤 */
export const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
/** 官方镜像内 node-red 用户的 uid/gid */
const NODE_RED_UID = 1000;

export interface DockerClientOptions {
  /** dockerode 连接参数；生产环境指向受限代理而非裸 socket */
  connection?: Docker.DockerOptions | undefined;
  /** 网络名前缀；每个实例拥有独立网络 `${network}-${id}` */
  network: string;
  imageRepo: string;
  portRange: { min: number; max: number };
  /**
   * 实例数据根（宿主路径）。每个实例一个子目录并 bind 挂进容器 /data。
   * Manager 容器必须把它挂在**同名路径**上，否则这里 mkdir 的位置
   * 与 daemon 解析 Binds 的位置对不上 —— 那会静默挂到错误的盘。
   */
  instanceDataRoot: string;
  /** 实例容器时区，缺省会让容器跑在 UTC 上（见 config.timezone） */
  timezone: string;
  /**
   * Manager 在实例网络上的基址，注入给实例里的 `@thinglinks` 节点。
   * 依赖容器名解析，因此只有 Manager 自己也是容器时才有值。
   */
  managerUrl?: string | undefined;
  /**
   * `@thinglinks` 节点集所在目录。创建实例时整份拷进 `<数据目录>/nodes/`，
   * 由 settings.js 的 nodesDir 加载 —— 不走 npm install，容器内不需要联网。
   * 留空则不装节点集（实例照常可用，只是平台看不见里面）。
   */
  nodePackageDir?: string | undefined;
  /**
   * Manager 自身的容器名或 id。提供后，每创建一个实例就把 Manager 接入该实例网络，
   * 使 Manager 可达实例、而实例之间互不可达。
   * 开发态 Manager 跑在宿主上时留空。
   */
  managerContainer?: string | undefined;
  /**
   * 注入实例容器的出网代理变量（03 号文 2.10）。
   * 由 core/proxy.ts 生成 —— 其中 NO_PROXY 已补齐内部条目，不要自己拼。
   */
  proxyEnv?: readonly string[] | undefined;
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

  /**
   * 底层 dockerode 句柄，**只给安装自检用**。
   *
   * 自检要读 `version` / `info` / `listNetworks` —— 这些是环境事实查询，
   * 与本类「编排实例容器」的职责无关，为它们各包一层方法只会让这个类变胖。
   * 但也不该让业务代码拿它绕过白名单，所以命名上写明用途。
   */
  get raw(): Docker { return this.docker; }
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

  /** 实例镜像仓库名，供上层拼完整镜像名 */
  get imageRepo(): string {
    return this.opts.imageRepo;
  }

  /**
   * 本机是否已有该镜像。走只读的 images/<name>/json，不具备拉取能力。
   *
   * **只有 404 才算「没有」。** 其它错误（受限代理没放行 → 403、端点不通 → 网络错误）
   * 必须抛出去：把它们一并当成「镜像不存在」，会让一个配置问题伪装成
   * 「本机没有镜像」，照着提示去 docker pull 也解决不了，现场会卡死在这里。
   */
  async imagePresent(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return false;
      // 带上 cause：只留自己的措辞会把原始 docker 错误与堆栈丢掉，
      // 而「端点没放行」和「网络不通」在现场是完全不同的两件事
      throw new Error(
        `无法查询镜像 ${image}：${(e as Error).message}。` +
        '这不是镜像缺失，请检查 docker 端点是否放行了 images/<name>/json',
        { cause: e },
      );
    }
  }

  /**
   * 建容器前先确认镜像在本机。
   *
   * **Docker API 不会自动拉取**（命令行的 `docker create` 会，容易让人误判）。
   * 镜像缺失时 containers/create 回的是 `No such image`，那句话对现场人员
   * 毫无指导意义 —— 这里换成能照着做的说明。
   *
   * 而且 Manager 本来也拉不了：受限代理没放行 images/create，
   * 就算想「顺手帮用户拉一下」也做不到，且那样会让离线现场卡在无法排查的等待里。
   */
  async assertImagePresent(image: string): Promise<void> {
    if (await this.imagePresent(image)) return;
    throw new Error(
      `本机没有镜像 ${image}，无法创建实例。\n` +
      `有外网的机器：docker pull ${image}\n` +
      `现场无外网：在有网机器上 docker pull 后 docker save ${image} -o image.tar，` +
      `拷到现场执行 docker load -i image.tar`,
    );
  }

  /**
   * 备好实例数据目录。
   *
   * 0o770 而非 0o777：同组可读写即可，不给其它用户。Manager 与 Node-RED 官方镜像
   * 都以 uid 1000 运行，因此这里建出来的目录实例能直接写。
   */
  async ensureDataDir(instanceId: string): Promise<void> {
    const dir = instanceDataDir(this.opts.instanceDataRoot, instanceId);
    await mkdir(dir, { recursive: true, mode: 0o770 });

    /*
     * 装 `@thinglinks` 节点集。
     *
     * 直接拷文件而不是 npm install：容器内可能没有外网，而且装包会拖慢首次启动。
     * Node-RED 的 nodesDir 本来就是扫目录，不需要 package.json。
     * 每次创建都覆盖，保证节点集版本跟着 Manager 走。
     */
    if (this.opts.nodePackageDir) {
      await cp(this.opts.nodePackageDir, `${dir}/nodes`, { recursive: true, force: true });
    }
  }

  /**
   * 创建实例容器并写入 settings.js。
   * settings.js 在容器启动前经 putArchive 落进数据卷，避免运行时再改配置。
   */
  async createInstance(spec: InstanceSpec, settingsJs: string): Promise<void> {
    // managerUrl 由客户端统一补，调用方不必关心 Manager 自己是不是容器
    if (this.opts.managerUrl) spec = { ...spec, managerUrl: this.opts.managerUrl };
    assertValidSpec(spec, this.opts.portRange);
    const options = buildCreateOptions(spec, {
      network: this.instanceNetwork(spec.id),
      imageRepo: this.opts.imageRepo,
      instanceDataRoot: this.opts.instanceDataRoot,
      timezone: this.opts.timezone,
      proxyEnv: this.opts.proxyEnv ?? [],
    });
    assertSafeCreateOptions(options, { instanceDataRoot: this.opts.instanceDataRoot });

    await this.assertImagePresent(options['Image'] as string);
    await this.ensureNetwork(spec.id);
    await this.ensureDataDir(spec.id);

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
  /**
   * 把 Manager 从实例网络摘出去。
   *
   * 必须在删网络之前做：Docker 拒绝删除仍有活动端点的网络，而 Manager 正是
   * 那个端点。漏了这一步没有任何报错（删网络的失败是被吞掉的），
   * 只会一次删一个实例、攒一堆空网络。
   */
  private async detachManager(instanceId: string): Promise<void> {
    const mgr = this.opts.managerContainer;
    if (!mgr) return;
    await this.docker.getNetwork(this.instanceNetwork(instanceId))
      .disconnect({ Container: mgr, Force: true })
      .catch(() => undefined);
  }

  /**
   * 拆除实例。
   *
   * 三步各自独立：容器、网络、数据目录。**不要**改回「前一步抛错就中断」的写法 ——
   * 曾经因为容器已被手工删掉，第一步抛错，数据目录那步压根没执行，
   * 用户以为连数据一起删了，其实还躺在盘上，且没有任何提示。
   * 容器删除的真实失败仍会在最后抛出，只是不再连累后面的清理。
   */
  async remove(instanceId: string, opts: { removeData: boolean }): Promise<void> {
    let containerError: Error | null = null;
    await this.docker.getContainer(containerName(instanceId)).remove({ force: true })
      .catch((e: Error & { statusCode?: number }) => {
        // 404 = 已经不在了，属于期望结果而非失败
        if (e.statusCode !== 404) containerError = e;
      });

    // 实例网络随实例一并回收，避免残留大量空网络
    await this.detachManager(instanceId);
    await this.docker.getNetwork(this.instanceNetwork(instanceId)).remove()
      .catch((e: Error & { statusCode?: number }) => {
        // 404 同样是期望结果。常态就会响的告警会让人学会忽略告警，所以只报真异常
        if (e.statusCode !== 404) {
          console.warn(`[warn] 实例网络 ${this.instanceNetwork(instanceId)} 未能回收：${e.message}`);
        }
      });

    if (opts.removeData) {
      // 目录是我们自己建的宿主路径，直接删。不要指望 docker 帮忙回收 ——
      // 具名卷那套语义在 bind 上不成立，实测 volume rm 根本不动宿主目录内容。
      await rm(instanceDataDir(this.opts.instanceDataRoot, instanceId), {
        recursive: true,
        force: true,
      }).catch((e: Error) =>
        console.warn(`[warn] 实例数据目录未能删除：${e.message}`),
      );
    }

    if (containerError) throw containerError;
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

  /**
   * 取容器日志。
   *
   * 容器以 Tty:false 运行，Docker 返回的是多路复用流，必须解帧后才是正文 ——
   * 直接 toString 会把 8 字节帧头当内容（见 log-stream.ts）。
   */
  async logs(instanceId: string, tail = 200): Promise<string> {
    const buf = await this.docker.getContainer(containerName(instanceId)).logs({
      stdout: true, stderr: true, tail,
    });
    return dockerLogToText(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
  }

  /**
   * 跟随容器日志（`follow`）。
   *
   * 返回的是**未解帧**的原始流 —— 帧头会被切在任意块边界上，
   * 必须交给 DockerLogStream 增量解，不能逐块 toString。
   * 调用方负责在连接断开时 destroy 这个流，否则 Docker 侧会一直往里写。
   *
   * 固定带 `timestamps`：断线重连要靠时间戳续传，否则每次重连都会把
   * tail 那批历史再放一遍（实测重连三次，19 行变成 105 行）。
   * `since` 存在时忽略 tail —— 两者同时给会既补历史又续传，重复更严重。
   */
  async logStream(
    instanceId: string,
    opts: { tail?: number; since?: string } = {},
  ): Promise<NodeJS.ReadableStream> {
    const base = { stdout: true, stderr: true, follow: true as const, timestamps: true };
    return this.docker.getContainer(containerName(instanceId)).logs(
      opts.since ? { ...base, since: opts.since } : { ...base, tail: opts.tail ?? 200 },
    );
  }
}
