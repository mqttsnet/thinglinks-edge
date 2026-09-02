/**
 * Docker 客户端封装 —— 兄弟容器模式。
 *
 * Manager 通过（受限的）docker 端点在宿主上创建 Node-RED 兄弟容器，
 * 而非在自身容器内起子进程。决定性理由：升级 Manager 时实例是独立容器，
 * 现场采集不中断 —— 产线不会为了升级管理台而停止采集。
 *
 * 所有创建请求都必须经 assertSafeCreateOptions 二次校验后才下发。
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, cp, lstat, open, readFile, rename, chmod } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Docker from 'dockerode';
import {
  buildCreateOptions, buildMigrationProbeCreateOptions,
  assertSafeCreateOptions, assertSafeMigrationProbeOptions, assertValidSpec,
  assertValidId, assertImmutableImageId, BOOTSTRAP_TX_LABEL,
  MIGRATION_PROBE_LABEL, MIGRATION_TX_LABEL,
  containerName, instanceDataDir, migrationProbeDataDir,
  migrationProbeName, migrationProbeNetworkName, type InstanceSpec,
} from './container-spec.ts';
import { tarFile } from '../archive/tar.ts';
import { dockerLogToText } from './log-stream.ts';
import type { NodeRuntimeMode } from './repo.ts';

/** 平台管理的容器统一打这个标签，列举与操作一律按标签过滤 */
export const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
export const BOOTSTRAP_OWNER_FILE = '.thinglinks-bootstrap-owner';
export const MIGRATION_PROBE_OWNER_FILE = '.thinglinks-probe-owner';
const BOOTSTRAP_TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
  /**
   * 私有 npm 源在**实例网络内**的地址（01 号文 5.7）。
   * 与 managerUrl 同源同理：靠容器名解析，Manager 跑在宿主上时留空。
   */
  npmRegistry?: string | undefined;
  /** 文件复制 seam；生产使用 fs.cp，测试只记录精确源/目标。 */
  copyDir?: ((source: string, destination: string) => Promise<void>) | undefined;
  /** bootstrap 数据目录删除 seam；生产使用 fs.rm，测试注入确定性失败。 */
  removeDir?: ((path: string) => Promise<void>) | undefined;
  /** bootstrap 原子隔离/恢复 seam；生产使用 fs.rename。 */
  renameDir?: ((source: string, destination: string) => Promise<void>) | undefined;
  /** 仅供确定性竞态测试；生产不注入。 */
  afterBootstrapDataOwnershipCheck?: ((event: {
    original: string;
    quarantine: string;
    ownership: 'owned' | 'foreign';
  }) => Promise<void>) | undefined;
}

export interface InstanceStatus {
  id: string;
  name: string;
  state: string;
  running: boolean;
  imageTag: string;
  startedAt: string | null;
}

export type BootstrapResourceResidual = 'container' | 'network' | 'data';

export interface BootstrapCleanupResult {
  residuals: BootstrapResourceResidual[];
}

export interface RecreateInstanceInput {
  spec: InstanceSpec;
  settingsJs: string;
  runtimeMode: NodeRuntimeMode;
  imageId: string;
  running: boolean;
}

export interface CreateMigrationProbeInput {
  spec: InstanceSpec;
  txId: string;
  imageId: string;
  /** Exact journal-relative immutable checkpoint directory. */
  checkpointDir: string;
}

export interface MigrationProbeHandle {
  instanceId: string;
  txId: string;
  containerId: string;
  networkId: string;
  containerName: string;
  networkName: string;
  dataRoot: string;
  adminUpstream: string;
}

type ProbeCheckpointFact =
  | { path: string; exists: false }
  | { path: string; exists: true; mode: number; size: number; sha256: string };

const PROBE_CHECKPOINT_FILES = new Set([
  'settings.js', 'settings.js.backup', 'flows.json', 'flows.json.backup',
  'flows_cred.json', 'flows_cred.json.backup', 'package.json', 'package.json.backup',
  'package-lock.json', 'package-lock.json.backup', '.config.nodes.json',
  '.config.nodes.json.backup', '.config.modules.json', '.config.modules.json.backup',
]);

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

  /** Non-secret deployment identity expected in every migratable instance container. */
  expectedMigrationEnvironment(): { managerUrl: string; npmRegistry: string } {
    return {
      managerUrl: this.opts.managerUrl ?? '',
      npmRegistry: this.opts.npmRegistry ?? '',
    };
  }

  /** Strict read-only migration inspection; raw environment remains in-memory only. */
  async inspectMigrationRuntime(instanceId: string): Promise<{
    running: boolean;
    imageId: string;
    environment: string[];
  }> {
    assertValidId(instanceId);
    const info = await this.docker.getContainer(containerName(instanceId)).inspect();
    const labels = info.Config.Labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[INSTANCE_LABEL] !== instanceId) {
      throw new Error(`容器 ${containerName(instanceId)} 归属不匹配，拒绝迁移检查`);
    }
    return {
      running: info.State.Running === true,
      imageId: info.Image,
      environment: (info.Config.Env ?? []).filter(
        (entry): entry is string => typeof entry === 'string',
      ),
    };
  }

  private requireBootstrapTxId(txId: string): void {
    if (!BOOTSTRAP_TX_ID.test(txId)) throw new Error('bootstrap tx id 无效');
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
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

  async ensureNetwork(instanceId: string): Promise<string> {
    const name = this.instanceNetwork(instanceId);
    const found = await this.docker.listNetworks({ filters: { name: [name] } });
    if (found.some((n) => n.Name === name)) {
      return (await this.assertOwnedNetwork(instanceId)).Id;
    }
    const created = await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: instanceId },
    });
    return created.id;
  }

  /** 网络名可被宿主上其它人抢占，标签才是实例归属的权威。 */
  private async assertOwnedNetwork(instanceId: string): Promise<Docker.NetworkInspectInfo> {
    const network = await this.docker.getNetwork(this.instanceNetwork(instanceId)).inspect();
    this.assertNetworkOwnership(instanceId, network);
    return network;
  }

  private assertNetworkOwnership(instanceId: string, network: Docker.NetworkInspectInfo): void {
    const labels = network.Labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[INSTANCE_LABEL] !== instanceId) {
      throw new Error(
        `实例网络 ${this.instanceNetwork(instanceId)} 归属不匹配，拒绝接入：` +
        `需要 ${MANAGED_LABEL}=true 且 ${INSTANCE_LABEL}=${instanceId}`,
      );
    }
  }

  private static hasContainer(network: Docker.NetworkInspectInfo, containerId: string): boolean {
    return Object.keys(network.Containers ?? {}).some((id) => id === containerId);
  }

  private assertBootstrapNetworkOwnership(
    instanceId: string,
    txId: string,
    networkId: string,
    network: Docker.NetworkInspectInfo,
  ): void {
    this.assertNetworkOwnership(instanceId, network);
    if (network.Id !== networkId || network.Labels?.[BOOTSTRAP_TX_LABEL] !== txId) {
      throw new Error(`bootstrap network owner mismatch for ${instanceId}`);
    }
  }

  /** 把 Manager 接入实例网络，使其可达实例；实例之间仍互不可达 */
  private async attachManager(instanceId: string, signal?: AbortSignal): Promise<void> {
    const mgr = this.opts.managerContainer;
    if (!mgr) return;
    if (signal?.aborted) throw signal.reason;
    const managerRef = this.docker.getContainer(mgr);
    const manager = signal
      ? await managerRef.inspect({ abortSignal: signal })
      : await managerRef.inspect();
    const network = await this.assertOwnedNetwork(instanceId);
    if (signal?.aborted) throw signal.reason;
    // 先按名字核验当前对象，再固定到不可变的容器/网络 ID；之后绝不再用名字连接。
    const networkRef = this.docker.getNetwork(network.Id);
    if (DockerClient.hasContainer(network, manager.Id)) return;
    try {
      // dockerode 5 会把 args.opts.abortSignal 转发给 modem，但 @types 尚未声明该字段。
      await networkRef.connect({ Container: manager.Id, abortSignal: signal } as Docker.NetworkConnectOptions & {
        abortSignal?: AbortSignal;
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Docker 可能在 inspect 与 connect 之间完成了另一次并发接入；只以当前
      // Manager 的精确容器 ID 已在该网络为准，不能靠错误文案猜测。
      const after = await networkRef.inspect().catch(() => undefined);
      if (after) this.assertNetworkOwnership(instanceId, after);
      if (after && after.Id === network.Id && DockerClient.hasContainer(after, manager.Id)) return;
      throw error;
    }
  }

  /** Bootstrap 专用：固定到 createNetwork 返回的 ID，绝不按同名网络重新解析。 */
  private async attachManagerToBootstrapNetwork(
    instanceId: string,
    txId: string,
    networkId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const mgr = this.opts.managerContainer;
    if (!mgr) return;
    if (signal?.aborted) throw signal.reason;
    const managerRef = this.docker.getContainer(mgr);
    const manager = signal
      ? await managerRef.inspect({ abortSignal: signal })
      : await managerRef.inspect();
    const networkRef = this.docker.getNetwork(networkId);
    const network = await networkRef.inspect();
    this.assertBootstrapNetworkOwnership(instanceId, txId, networkId, network);
    if (signal?.aborted) throw signal.reason;
    if (DockerClient.hasContainer(network, manager.Id)) return;
    try {
      await networkRef.connect({ Container: manager.Id, abortSignal: signal } as Docker.NetworkConnectOptions & {
        abortSignal?: AbortSignal;
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const after = await networkRef.inspect().catch(() => undefined);
      if (after) this.assertBootstrapNetworkOwnership(instanceId, txId, networkId, after);
      if (after && DockerClient.hasContainer(after, manager.Id)) return;
      throw error;
    }
  }

  /**
   * 启动恢复时把当前 Manager 补接回一个既有实例的独立网络。
   *
   * Manager 被单独重建后，Docker 会移除旧容器的网络端点；实例本身仍在运行，
   * 因此不会重新走 createInstance() 里的接入路径。复用同一幂等连接逻辑，
   * 只恢复 Manager 到该实例网络的可达性，不会创建网络或触碰实例容器。
   */
  async reconnectManager(instanceId: string, signal?: AbortSignal): Promise<void> {
    await this.attachManager(instanceId, signal);
  }

  /** 实例镜像仓库名，供上层拼完整镜像名 */
  get imageRepo(): string {
    return this.opts.imageRepo;
  }

  /**
   * 新实例补偿的所有权前提：首个副作用前，三类实例命名资源必须都不存在。
   * 这样后续出现的资源才属于本次 bootstrap；旧的孤儿资源绝不被当成本次产物删除。
   */
  async assertBootstrapResourcesAbsent(instanceId: string): Promise<void> {
    assertValidId(instanceId);
    try {
      await this.docker.getContainer(containerName(instanceId)).inspect();
      throw new Error(`实例 ${instanceId} 已有同名容器，拒绝覆盖`);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    try {
      await this.docker.getNetwork(this.instanceNetwork(instanceId)).inspect();
      throw new Error(`实例 ${instanceId} 已有同名网络，拒绝覆盖`);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    try {
      await lstat(instanceDataDir(this.opts.instanceDataRoot, instanceId));
      throw new Error(`实例 ${instanceId} 已有数据目录，拒绝覆盖`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * 本机是否已有该镜像。走只读的 images/<name>/json，不具备拉取能力。
   *
   * **只有 404 才算「没有」。** 其它错误（受限代理没放行 → 403、端点不通 → 网络错误）
   * 必须抛出去：把它们一并当成「镜像不存在」，会让一个配置问题伪装成
   * 「本机没有镜像」，照着提示去 docker pull 也解决不了，现场会卡死在这里。
   */
  /**
   * tag → 完整镜像名。升级前要判断新版本在不在本机，而 tag 到镜像名的拼法
   * 只有本类知道（imageRepo 是它的配置）—— 让调用方自己拼迟早拼错一处。
   */
  imageRef(tag: string): string {
    return `${this.opts.imageRepo}:${tag}`;
  }

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
  async ensureDataDir(instanceId: string, runtimeMode: NodeRuntimeMode): Promise<void> {
    const dir = instanceDataDir(this.opts.instanceDataRoot, instanceId);
    await mkdir(dir, { recursive: true, mode: 0o770 });

    /*
     * 装 `@thinglinks` 节点集。
     *
     * 直接拷文件而不是 npm install：容器内可能没有外网，而且装包会拖慢首次启动。
     * Node-RED 的 nodesDir 本来就是扫目录，不需要 package.json。
     * 每次创建都覆盖，保证节点集版本跟着 Manager 走。
     */
    if (runtimeMode === 'legacy' && this.opts.nodePackageDir) {
      const copyDir = this.opts.copyDir
        ?? ((source: string, destination: string) => cp(source, destination, { recursive: true, force: true }));
      await copyDir(this.opts.nodePackageDir, `${dir}/nodes`);
    }
  }

  /**
   * 全新实例专用数据根创建：child mkdir 必须独占成功，随后持久化 tx owner marker。
   * 普通升级/legacy 仍走 ensureDataDir，永远不会获得 bootstrap owner。
   */
  async prepareBootstrapDataDir(instanceId: string, txId: string): Promise<void> {
    assertValidId(instanceId);
    this.requireBootstrapTxId(txId);
    await mkdir(this.opts.instanceDataRoot, { recursive: true, mode: 0o770 });
    const dir = instanceDataDir(this.opts.instanceDataRoot, instanceId);
    await mkdir(dir, { mode: 0o770 });

    const marker = await open(`${dir}/${BOOTSTRAP_OWNER_FILE}`, 'wx', 0o600);
    try {
      await marker.writeFile(txId, 'utf8');
      await marker.sync();
    } finally {
      await marker.close();
    }
    await this.syncDirectory(dir);
    await this.syncDirectory(this.opts.instanceDataRoot);
  }

  private async bootstrapDataOwnershipAt(
    dir: string,
    txId: string,
  ): Promise<'absent' | 'owned' | 'foreign'> {
    let dirStat;
    try {
      dirStat = await lstat(dir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'foreign';
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return 'foreign';

    const markerPath = `${dir}/${BOOTSTRAP_OWNER_FILE}`;
    let markerStat;
    try {
      markerStat = await lstat(markerPath);
    } catch {
      return 'foreign';
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return 'foreign';
    try {
      return await readFile(markerPath, 'utf8') === txId ? 'owned' : 'foreign';
    } catch {
      return 'foreign';
    }
  }

  private async bootstrapDataOwnership(
    instanceId: string,
    txId: string,
  ): Promise<'absent' | 'owned' | 'foreign'> {
    return this.bootstrapDataOwnershipAt(
      instanceDataDir(this.opts.instanceDataRoot, instanceId),
      txId,
    );
  }

  private bootstrapQuarantineDir(instanceId: string, txId: string): string {
    return `${this.opts.instanceDataRoot}/.thinglinks-bootstrap-quarantine-${instanceId}-${txId}`;
  }

  private async renameBootstrapDir(source: string, destination: string): Promise<void> {
    const renameDir = this.opts.renameDir ?? rename;
    await renameDir(source, destination);
    await this.syncDirectory(this.opts.instanceDataRoot);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * 原子把当前路径隔离为 tx 专属 quarantine，之后只验证/删除 quarantine。
   * 原路径在 rename 后出现的任何对象都视为外来替换并保持不动。
   */
  private async cleanupBootstrapData(
    instanceId: string,
    txId: string,
  ): Promise<boolean> {
    const original = instanceDataDir(this.opts.instanceDataRoot, instanceId);
    const quarantine = this.bootstrapQuarantineDir(instanceId, txId);
    let residual = false;

    let quarantineExists = await this.pathExists(quarantine).catch(() => {
      residual = true;
      return false;
    });
    let originalExists = await this.pathExists(original).catch(() => {
      residual = true;
      return true;
    });

    if (!quarantineExists && originalExists) {
      try {
        await this.renameBootstrapDir(original, quarantine);
      } catch {
        residual = true;
      }
      quarantineExists = await this.pathExists(quarantine).catch(() => {
        residual = true;
        return false;
      });
      originalExists = await this.pathExists(original).catch(() => {
        residual = true;
        return true;
      });
    }

    if (!quarantineExists) return residual || originalExists;

    const ownership = await this.bootstrapDataOwnershipAt(quarantine, txId);
    if (ownership !== 'absent') {
      await this.opts.afterBootstrapDataOwnershipCheck?.({
        original,
        quarantine,
        ownership,
      });
    }
    if (ownership !== 'owned') {
      // Foreign evidence is never auto-restored: even rename onto an empty directory may replace it.
      return true;
    }

    try {
      const removeDir = this.opts.removeDir
        ?? ((path: string) => rm(path, { recursive: true, force: false }));
      await removeDir(quarantine);
    } catch {
      residual = true;
    }
    if (await this.pathExists(quarantine).catch(() => true)) residual = true;
    // A same-name replacement created after quarantine is foreign and must never be deleted.
    if (await this.pathExists(original).catch(() => true)) residual = true;
    return residual;
  }

  private hasBootstrapLabels(
    labels: Record<string, string> | undefined,
    instanceId: string,
    txId: string,
  ): boolean {
    return labels?.[MANAGED_LABEL] === 'true'
      && labels[INSTANCE_LABEL] === instanceId
      && labels[BOOTSTRAP_TX_LABEL] === txId;
  }

  private bootstrapLabelFilters(instanceId: string, txId: string): { label: string[] } {
    return {
      label: [
        `${MANAGED_LABEL}=true`,
        `${INSTANCE_LABEL}=${instanceId}`,
        `${BOOTSTRAP_TX_LABEL}=${txId}`,
      ],
    };
  }

  private async discoverBootstrapContainerIds(
    instanceId: string,
    txId: string,
  ): Promise<{ ok: boolean; ids: string[] }> {
    try {
      const items = await this.docker.listContainers({
        all: true,
        filters: this.bootstrapLabelFilters(instanceId, txId),
      });
      return {
        ok: true,
        ids: items
          .filter((item) => this.hasBootstrapLabels(item.Labels, instanceId, txId))
          .map((item) => item.Id),
      };
    } catch {
      return { ok: false, ids: [] };
    }
  }

  private async discoverBootstrapNetworkIds(
    instanceId: string,
    txId: string,
  ): Promise<{ ok: boolean; ids: string[] }> {
    try {
      const items = await this.docker.listNetworks({
        filters: this.bootstrapLabelFilters(instanceId, txId),
      });
      return {
        ok: true,
        ids: items
          .filter((item) => this.hasBootstrapLabels(item.Labels, instanceId, txId))
          .map((item) => item.Id),
      };
    } catch {
      return { ok: false, ids: [] };
    }
  }

  private async createBootstrapNetwork(instanceId: string, txId: string): Promise<string> {
    const created = await this.docker.createNetwork({
      Name: this.instanceNetwork(instanceId),
      Driver: 'bridge',
      Labels: {
        [MANAGED_LABEL]: 'true',
        [INSTANCE_LABEL]: instanceId,
        [BOOTSTRAP_TX_LABEL]: txId,
      },
    });
    return created.id;
  }

  /** 新实例专用创建路径；tx owner 不存在于普通 createInstance 的签名中。 */
  async createBootstrapInstance(
    spec: InstanceSpec,
    settingsJs: string,
    txId: string,
  ): Promise<void> {
    this.requireBootstrapTxId(txId);
    if (this.opts.managerUrl) spec = { ...spec, managerUrl: this.opts.managerUrl };
    if (this.opts.npmRegistry) spec = { ...spec, npmRegistry: this.opts.npmRegistry };
    assertValidSpec(spec, this.opts.portRange);
    await this.assertImagePresent(this.imageRef(spec.imageTag));
    if (await this.bootstrapDataOwnership(spec.id, txId) !== 'owned') {
      throw new Error(`实例 ${spec.id} 的 bootstrap 数据 owner 不匹配`);
    }
    // 不查找或复用同名网络：createNetwork 的独占冲突关闭 preflight→create 竞态。
    const networkId = await this.createBootstrapNetwork(spec.id, txId);
    const options = buildCreateOptions(spec, {
      network: networkId,
      imageRepo: this.opts.imageRepo,
      instanceDataRoot: this.opts.instanceDataRoot,
      timezone: this.opts.timezone,
      proxyEnv: this.opts.proxyEnv ?? [],
      bootstrapTxId: txId,
    });
    assertSafeCreateOptions(options, { instanceDataRoot: this.opts.instanceDataRoot });
    const container = await this.docker.createContainer(options as Docker.ContainerCreateOptions);
    await this.attachManagerToBootstrapNetwork(spec.id, txId, networkId);
    await container.putArchive(
      tarFile('settings.js', settingsJs, { uid: NODE_RED_UID, gid: NODE_RED_UID, mode: 0o644 }),
      { path: '/data' },
    );
  }

  /**
   * 创建实例容器并写入 settings.js。
   * settings.js 在容器启动前经 putArchive 落进数据卷，避免运行时再改配置。
   */
  async createInstance(
    spec: InstanceSpec,
    settingsJs: string,
    runtimeMode: NodeRuntimeMode,
  ): Promise<void> {
    // managerUrl / npmRegistry 由客户端统一补，调用方不必关心 Manager 自己是不是容器
    if (this.opts.managerUrl) spec = { ...spec, managerUrl: this.opts.managerUrl };
    if (this.opts.npmRegistry) spec = { ...spec, npmRegistry: this.opts.npmRegistry };
    assertValidSpec(spec, this.opts.portRange);
    await this.assertImagePresent(this.imageRef(spec.imageTag));
    const networkId = await this.ensureNetwork(spec.id);
    const options = buildCreateOptions(spec, {
      network: networkId,
      imageRepo: this.opts.imageRepo,
      instanceDataRoot: this.opts.instanceDataRoot,
      timezone: this.opts.timezone,
      proxyEnv: this.opts.proxyEnv ?? [],
    });
    assertSafeCreateOptions(options, { instanceDataRoot: this.opts.instanceDataRoot });
    await this.ensureDataDir(spec.id, runtimeMode);

    const container = await this.docker.createContainer(options as Docker.ContainerCreateOptions);
    await this.attachManager(spec.id);
    await container.putArchive(
      tarFile('settings.js', settingsJs, { uid: NODE_RED_UID, gid: NODE_RED_UID, mode: 0o644 }),
      { path: '/data' },
    );
  }

  /**
   * Same-image repair primitive. The caller supplies the complete repository-derived
   * spec and the already inspected immutable image id; this layer never reconstructs
   * ports, limits, identities, settings, or runtime mode from an instance id.
   */
  async recreateInstance(input: RecreateInstanceInput): Promise<void> {
    let spec = input.spec;
    assertImmutableImageId(input.imageId);
    if (this.opts.managerUrl) spec = { ...spec, managerUrl: this.opts.managerUrl };
    if (this.opts.npmRegistry) spec = { ...spec, npmRegistry: this.opts.npmRegistry };
    assertValidSpec(spec, this.opts.portRange);

    // Prove the exact immutable image is present before deleting the old container.
    await this.assertImagePresent(input.imageId);
    await this.remove(spec.id, { removeData: false });
    const networkId = await this.ensureNetwork(spec.id);
    const options = buildCreateOptions(spec, {
      network: networkId,
      imageRepo: this.opts.imageRepo,
      instanceDataRoot: this.opts.instanceDataRoot,
      timezone: this.opts.timezone,
      proxyEnv: this.opts.proxyEnv ?? [],
      imageIdOverride: input.imageId,
    });
    assertSafeCreateOptions(options, { instanceDataRoot: this.opts.instanceDataRoot });
    await this.ensureDataDir(spec.id, input.runtimeMode);
    const container = await this.docker.createContainer(options as Docker.ContainerCreateOptions);
    await this.attachManager(spec.id);
    await container.putArchive(
      tarFile('settings.js', input.settingsJs, {
        uid: NODE_RED_UID, gid: NODE_RED_UID, mode: 0o644,
      }),
      { path: '/data' },
    );
    if (input.running) await this.start(spec.id);
  }

  private probeCheckpointRoot(input: CreateMigrationProbeInput): string {
    const expected = `.thinglinks-migration/${input.spec.id}/${input.txId}`;
    if (input.checkpointDir !== expected) throw new Error('probe checkpoint identity mismatch');
    const root = resolve(this.opts.instanceDataRoot, input.checkpointDir);
    const rel = relative(resolve(this.opts.instanceDataRoot, '.thinglinks-migration'), root);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('probe checkpoint path escapes root');
    return root;
  }

  private async restoreProbeWorkRoot(input: CreateMigrationProbeInput): Promise<string> {
    this.requireBootstrapTxId(input.txId);
    const checkpointRoot = this.probeCheckpointRoot(input);
    const checkpointStat = await lstat(checkpointRoot);
    const manifestPath = join(checkpointRoot, 'manifest.json');
    const manifestStat = await lstat(manifestPath);
    if (
      !checkpointStat.isDirectory() || checkpointStat.isSymbolicLink()
      || !manifestStat.isFile() || manifestStat.isSymbolicLink()
    ) throw new Error('probe checkpoint root is untrusted');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version?: unknown; instanceId?: unknown; txId?: unknown; files?: unknown;
    };
    if (
      raw.version !== 1
      || raw.instanceId !== input.spec.id
      || raw.txId !== input.txId
      || !Array.isArray(raw.files)
      || raw.files.length !== PROBE_CHECKPOINT_FILES.size
    ) throw new Error('probe checkpoint manifest identity mismatch');
    const facts = raw.files as ProbeCheckpointFact[];
    const seen = new Set<string>();
    for (const fact of facts) {
      if (
        !fact || typeof fact !== 'object' || typeof fact.path !== 'string'
        || !PROBE_CHECKPOINT_FILES.has(fact.path) || seen.has(fact.path)
        || typeof fact.exists !== 'boolean'
      ) throw new Error('probe checkpoint manifest file set mismatch');
      seen.add(fact.path);
    }
    if (seen.size !== PROBE_CHECKPOINT_FILES.size) {
      throw new Error('probe checkpoint manifest file set mismatch');
    }

    const workRoot = migrationProbeDataDir(
      this.opts.instanceDataRoot, input.spec.id, input.txId,
    );
    const probesRoot = resolve(this.opts.instanceDataRoot, '.thinglinks-probes');
    const instanceRoot = resolve(probesRoot, input.spec.id);
    const ensureTrustedDirectory = async (path: string, parent: string) => {
      const rel = relative(parent, path);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('probe directory escapes root');
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('probe directory is untrusted');
    };
    const managerRoot = resolve(this.opts.instanceDataRoot);
    const managerRootStat = await lstat(managerRoot);
    if (!managerRootStat.isDirectory() || managerRootStat.isSymbolicLink()) {
      throw new Error('Manager instance data root is untrusted');
    }
    await ensureTrustedDirectory(probesRoot, managerRoot);
    await chmod(probesRoot, 0o700);
    await ensureTrustedDirectory(instanceRoot, probesRoot);
    await chmod(instanceRoot, 0o700);
    await mkdir(workRoot, { mode: 0o700 });
    await chmod(workRoot, 0o700);
    const owner = await open(join(workRoot, MIGRATION_PROBE_OWNER_FILE), 'wx', 0o600);
    try {
      await owner.writeFile(input.txId, 'utf8');
      await owner.sync();
    } finally {
      await owner.close();
    }
    for (const fact of facts) {
      if (!fact.exists) continue;
      if (
        !Number.isInteger(fact.mode) || !Number.isSafeInteger(fact.size)
        || fact.size < 0 || !/^[a-f0-9]{64}$/.test(fact.sha256)
      ) throw new Error('probe checkpoint file fact invalid');
      const source = join(checkpointRoot, 'files', fact.path);
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('probe checkpoint file is untrusted');
      const bytes = await readFile(source);
      if (
        bytes.length !== fact.size
        || (stat.mode & 0o777) !== fact.mode
        || createHash('sha256').update(bytes).digest('hex') !== fact.sha256
      ) throw new Error('probe checkpoint file fact changed');
      const target = await open(join(workRoot, fact.path), 'wx', fact.mode);
      try {
        await target.writeFile(bytes);
        await chmod(join(workRoot, fact.path), fact.mode);
        await target.sync();
      } finally {
        await target.close();
      }
    }
    await this.syncDirectory(workRoot);
    await this.syncDirectory(instanceRoot);
    return workRoot;
  }

  private probeLabels(instanceId: string, txId: string): Record<string, string> {
    return {
      [MANAGED_LABEL]: 'true',
      [INSTANCE_LABEL]: instanceId,
      [MIGRATION_TX_LABEL]: txId,
      [MIGRATION_PROBE_LABEL]: 'true',
    };
  }

  private assertProbeLabels(
    labels: Record<string, string> | undefined,
    instanceId: string,
    txId: string,
  ): void {
    const expected = this.probeLabels(instanceId, txId);
    if (Object.entries(expected).some(([key, value]) => labels?.[key] !== value)) {
      throw new Error('migration probe ownership mismatch');
    }
  }

  /** Create/start an isolated stopped-copy probe by exact tx-owned immutable ids. */
  async createMigrationProbe(input: CreateMigrationProbeInput): Promise<MigrationProbeHandle> {
    this.requireBootstrapTxId(input.txId);
    let spec = input.spec;
    if (this.opts.managerUrl) spec = { ...spec, managerUrl: this.opts.managerUrl };
    if (this.opts.npmRegistry) spec = { ...spec, npmRegistry: this.opts.npmRegistry };
    assertValidSpec(spec, this.opts.portRange);
    assertImmutableImageId(input.imageId);
    await this.assertImagePresent(input.imageId);
    const dataRoot = await this.restoreProbeWorkRoot(input);
    const networkName = migrationProbeNetworkName(spec.id, input.txId);
    const labels = this.probeLabels(spec.id, input.txId);
    const createdNetwork = await this.docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labels,
    });
    const networkId = createdNetwork.id;
    const options = buildMigrationProbeCreateOptions(spec, {
      instanceDataRoot: this.opts.instanceDataRoot,
      imageRepo: this.opts.imageRepo,
      timezone: this.opts.timezone,
      proxyEnv: this.opts.proxyEnv ?? [],
      txId: input.txId,
      imageId: input.imageId,
      networkId,
    });
    assertSafeMigrationProbeOptions(options, {
      instanceDataRoot: this.opts.instanceDataRoot,
      instanceId: spec.id,
      txId: input.txId,
    });
    const container = await this.docker.createContainer(options as Docker.ContainerCreateOptions);
    if (this.opts.managerContainer) {
      const network = await this.docker.getNetwork(networkId).inspect();
      this.assertProbeLabels(network.Labels, spec.id, input.txId);
      if (network.Id !== networkId) throw new Error('migration probe network id changed');
      const manager = await this.docker.getContainer(this.opts.managerContainer).inspect();
      await this.docker.getNetwork(networkId).connect({ Container: manager.Id });
    }
    await container.start();
    return {
      instanceId: spec.id,
      txId: input.txId,
      containerId: container.id,
      networkId,
      containerName: migrationProbeName(spec.id, input.txId),
      networkName,
      dataRoot,
      adminUpstream: `http://${migrationProbeName(spec.id, input.txId)}:1880`,
    };
  }

  async writeMigrationProbeSettings(
    handle: MigrationProbeHandle,
    settingsJs: string,
  ): Promise<void> {
    await this.docker.getContainer(handle.containerId).putArchive(
      tarFile('settings.js', settingsJs, {
        uid: NODE_RED_UID, gid: NODE_RED_UID, mode: 0o644,
      }),
      { path: '/data' },
    );
  }

  async restartMigrationProbe(handle: MigrationProbeHandle): Promise<void> {
    await this.docker.getContainer(handle.containerId).restart({ t: 10 });
  }

  /** Remove and verify the three probe resources independently by immutable identity. */
  async cleanupMigrationProbe(handle: MigrationProbeHandle): Promise<BootstrapCleanupResult> {
    this.requireBootstrapTxId(handle.txId);
    if (
      handle.containerName !== migrationProbeName(handle.instanceId, handle.txId)
      || handle.networkName !== migrationProbeNetworkName(handle.instanceId, handle.txId)
      || handle.dataRoot !== migrationProbeDataDir(
        this.opts.instanceDataRoot, handle.instanceId, handle.txId,
      )
    ) throw new Error('migration probe handle identity mismatch');
    const residuals = new Set<BootstrapResourceResidual>();

    const container = this.docker.getContainer(handle.containerId);
    try {
      const inspected = await container.inspect();
      if (inspected.Id !== handle.containerId) throw new Error('probe container id changed');
      this.assertProbeLabels(inspected.Config.Labels, handle.instanceId, handle.txId);
      await container.remove({ force: true });
      try {
        await container.inspect();
        residuals.add('container');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
    }

    const network = this.docker.getNetwork(handle.networkId);
    try {
      const inspected = await network.inspect();
      if (inspected.Id !== handle.networkId) throw new Error('probe network id changed');
      this.assertProbeLabels(inspected.Labels, handle.instanceId, handle.txId);
      await this.detachManager(network, handle.instanceId);
      await network.remove();
      try {
        await network.inspect();
        residuals.add('network');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
    }

    try {
      const stat = await lstat(handle.dataRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('probe data root untrusted');
      const owner = await readFile(join(handle.dataRoot, MIGRATION_PROBE_OWNER_FILE), 'utf8');
      if (owner !== handle.txId) throw new Error('probe data owner mismatch');
      const removeDir = this.opts.removeDir
        ?? ((path: string) => rm(path, { recursive: true, force: false }));
      await removeDir(handle.dataRoot);
      try {
        await lstat(handle.dataRoot);
        residuals.add('data');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') residuals.add('data');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') residuals.add('data');
    }
    const ordered: BootstrapResourceResidual[] = ['container', 'network', 'data'];
    return { residuals: ordered.filter((item) => residuals.has(item)) };
  }

  /** Startup/in-process recovery when only the durable instance+tx identity survived. */
  async cleanupMigrationProbeByTx(
    instanceId: string,
    txId: string,
  ): Promise<BootstrapCleanupResult> {
    assertValidId(instanceId);
    this.requireBootstrapTxId(txId);
    const residuals = new Set<BootstrapResourceResidual>();
    const filters = {
      label: [
        `${MANAGED_LABEL}=true`,
        `${INSTANCE_LABEL}=${instanceId}`,
        `${MIGRATION_TX_LABEL}=${txId}`,
        `${MIGRATION_PROBE_LABEL}=true`,
      ],
    };
    try {
      const containers = await this.docker.listContainers({ all: true, filters });
      for (const item of containers) {
        if (Object.entries(this.probeLabels(instanceId, txId)).some(
          ([key, value]) => item.Labels?.[key] !== value,
        )) {
          residuals.add('container');
          continue;
        }
        const ref = this.docker.getContainer(item.Id);
        try {
          const inspected = await ref.inspect();
          this.assertProbeLabels(inspected.Config.Labels, instanceId, txId);
          await ref.remove({ force: true });
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
        }
      }
      const late = await this.docker.listContainers({ all: true, filters });
      if (late.some((item) => Object.entries(this.probeLabels(instanceId, txId)).every(
        ([key, value]) => item.Labels?.[key] === value,
      ))) residuals.add('container');
    } catch {
      residuals.add('container');
    }
    try {
      const networks = await this.docker.listNetworks({ filters });
      for (const item of networks) {
        if (Object.entries(this.probeLabels(instanceId, txId)).some(
          ([key, value]) => item.Labels?.[key] !== value,
        )) {
          residuals.add('network');
          continue;
        }
        const ref = this.docker.getNetwork(item.Id);
        try {
          const inspected = await ref.inspect();
          this.assertProbeLabels(inspected.Labels, instanceId, txId);
          await this.detachManager(ref, instanceId);
          await ref.remove();
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
        }
      }
      const late = await this.docker.listNetworks({ filters });
      if (late.some((item) => Object.entries(this.probeLabels(instanceId, txId)).every(
        ([key, value]) => item.Labels?.[key] === value,
      ))) residuals.add('network');
    } catch {
      residuals.add('network');
    }
    const dataRoot = migrationProbeDataDir(this.opts.instanceDataRoot, instanceId, txId);
    try {
      const stat = await lstat(dataRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('probe data untrusted');
      if (await readFile(join(dataRoot, MIGRATION_PROBE_OWNER_FILE), 'utf8') !== txId) {
        throw new Error('probe data owner mismatch');
      }
      const removeDir = this.opts.removeDir
        ?? ((path: string) => rm(path, { recursive: true, force: false }));
      await removeDir(dataRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') residuals.add('data');
    }
    try {
      await lstat(dataRoot);
      residuals.add('data');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') residuals.add('data');
    }
    const ordered: BootstrapResourceResidual[] = ['container', 'network', 'data'];
    return { residuals: ordered.filter((item) => residuals.has(item)) };
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
  private async detachManager(networkRef: Docker.Network, instanceId: string): Promise<void> {
    const mgr = this.opts.managerContainer;
    if (!mgr) return;
    try {
      const manager = await this.docker.getContainer(mgr).inspect();
      await networkRef.disconnect({ Container: manager.Id, Force: true });
    } catch (e) {
      const error = e as Error & { statusCode?: number };
      if (error.statusCode !== 404) {
        console.warn(`[warn] 实例网络 ${this.instanceNetwork(instanceId)} 未能摘除 Manager：${error.message}`);
      }
    }
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
    try {
      const container = await this.docker.getContainer(containerName(instanceId)).inspect();
      const labels = container.Config.Labels ?? {};
      if (labels[MANAGED_LABEL] !== 'true' || labels[INSTANCE_LABEL] !== instanceId) {
        console.warn(
          `[warn] 容器 ${containerName(instanceId)} 归属不匹配，保留不动：` +
          `需要 ${MANAGED_LABEL}=true 且 ${INSTANCE_LABEL}=${instanceId}`,
        );
      } else {
        await this.docker.getContainer(container.Id).remove({ force: true });
      }
    } catch (e) {
      const error = e as Error & { statusCode?: number };
      // 404 = 已经不在了，属于期望结果而非失败
      if (error.statusCode !== 404) {
        containerError = error;
        console.warn(`[warn] 容器 ${containerName(instanceId)} 未能核验或删除，保留不动：${error.message}`);
      }
    }

    // 网络名不是权限边界。只有核验过标签归属的 network ID 才允许摘端点或删除。
    let ownedNetwork: Docker.NetworkInspectInfo | undefined;
    try {
      ownedNetwork = await this.assertOwnedNetwork(instanceId);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) {
        console.warn(`[warn] 实例网络 ${this.instanceNetwork(instanceId)} 未能核验归属，保留不动：${(e as Error).message}`);
      }
    }
    if (ownedNetwork) {
      const networkRef = this.docker.getNetwork(ownedNetwork.Id);
      await this.detachManager(networkRef, instanceId);
      await networkRef.remove()
        .catch((e: Error & { statusCode?: number }) => {
          if (e.statusCode !== 404) {
            console.warn(`[warn] 实例网络 ${this.instanceNetwork(instanceId)} 未能回收：${e.message}`);
          }
        });
    }

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

  /**
   * 全新实例失败后的严格补偿：三类资源分别删除，再分别核验确实不存在。
   * 只返回受控资源名，不把 Docker/fs 原始错误或环境细节带入持久化日志。
   */
  async cleanupBootstrap(instanceId: string, txId: string): Promise<BootstrapCleanupResult> {
    assertValidId(instanceId);
    this.requireBootstrapTxId(txId);
    const residuals = new Set<BootstrapResourceResidual>();

    const discoveredContainers = await this.discoverBootstrapContainerIds(instanceId, txId);
    if (!discoveredContainers.ok) residuals.add('container');
    const containerIds = new Set(discoveredContainers.ids);
    try {
      const named = await this.docker.getContainer(containerName(instanceId)).inspect();
      if (this.hasBootstrapLabels(named.Config.Labels, instanceId, txId)) {
        containerIds.add(named.Id);
      } else {
        residuals.add('container');
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
    }
    for (const containerId of containerIds) {
      const containerRef = this.docker.getContainer(containerId);
      try {
        const inspected = await containerRef.inspect();
        if (!this.hasBootstrapLabels(inspected.Config.Labels, instanceId, txId)) {
          residuals.add('container');
          continue;
        }
        await containerRef.remove({ force: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
      }
      try {
        await containerRef.inspect();
        residuals.add('container');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
      }
    }
    try {
      await this.docker.getContainer(containerName(instanceId)).inspect();
      residuals.add('container');
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('container');
    }
    // Detection-only second pass: late/renamed exact-label resources wait for the next recovery pass.
    const lateContainers = await this.discoverBootstrapContainerIds(instanceId, txId);
    if (!lateContainers.ok || lateContainers.ids.length > 0) residuals.add('container');

    const discoveredNetworks = await this.discoverBootstrapNetworkIds(instanceId, txId);
    if (!discoveredNetworks.ok) residuals.add('network');
    const networkIds = new Set(discoveredNetworks.ids);
    try {
      const named = await this.docker.getNetwork(this.instanceNetwork(instanceId)).inspect();
      if (this.hasBootstrapLabels(named.Labels, instanceId, txId)) {
        networkIds.add(named.Id);
      } else {
        residuals.add('network');
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
    }
    for (const networkId of networkIds) {
      const networkRef = this.docker.getNetwork(networkId);
      try {
        const inspected = await networkRef.inspect();
        if (!this.hasBootstrapLabels(inspected.Labels, instanceId, txId)) {
          residuals.add('network');
          continue;
        }
        await this.detachManager(networkRef, instanceId);
        await networkRef.remove();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
      }
      try {
        await networkRef.inspect();
        residuals.add('network');
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
      }
    }
    try {
      await this.docker.getNetwork(this.instanceNetwork(instanceId)).inspect();
      residuals.add('network');
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) residuals.add('network');
    }
    // Never widen this pass into a retry/prune; newly discovered IDs are residual evidence only.
    const lateNetworks = await this.discoverBootstrapNetworkIds(instanceId, txId);
    if (!lateNetworks.ok || lateNetworks.ids.length > 0) residuals.add('network');

    if (await this.cleanupBootstrapData(instanceId, txId)) residuals.add('data');

    const ordered: BootstrapResourceResidual[] = ['container', 'network', 'data'];
    return { residuals: ordered.filter((kind) => residuals.has(kind)) };
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
    const labels = info.Config.Labels ?? {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[INSTANCE_LABEL] !== instanceId) {
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
