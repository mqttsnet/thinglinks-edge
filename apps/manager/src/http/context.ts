/**
 * HTTP 层共享上下文。
 *
 * 各路由模块只认这一个对象，不各自去 deps 里翻 —— 鉴权、CSRF、错误响应
 * 这三件事必须全站一致，散在各处迟早会出现某条路由漏掉 CSRF 的情况。
 */
import type { FastifyInstance } from 'fastify';
import type { EdgeConfig } from '../core/config.ts';
import { AuthService } from '../core/auth/service.ts';
import { InstanceRepo } from '../core/instance/repo.ts';
import type { InstanceService } from '../core/instance/service.ts';
import { containerName } from '../core/instance/container-spec.ts';
import type { Db } from '../core/db.ts';
import type { Spool } from '../core/spool/spool.ts';
import type { SpoolDrainer } from '../core/spool/drainer.ts';
import type { OutageLog } from '../core/cloud/outage.ts';
import type { CloudRuntime } from '../core/cloud/runtime.ts';
import type { CloudConfigRepo } from '../core/cloud/config-repo.ts';
import { UserRepo } from '../core/auth/user-repo.ts';
import { can, canInstance, isInstanceScoped, type Action } from '../core/auth/authz.ts';
import { SettingsRepo } from '../core/auth/settings.ts';
import type { MetricsHistory } from '../core/health/metrics-history.ts';
import type { NodeStore } from '../core/nodes/store.ts';
import type { NodeCatalog } from '../core/nodes/catalog.ts';
import type { ValueHistory } from '../core/edge/history.ts';
import type { UpstreamRegistry } from '../core/nodes/upstream.ts';
import type { NpmSourceRepo } from '../core/nodes/sources.ts';
import type { PlatformPackageService } from '../core/nodes/platform-package.ts';
import { InstanceBusyError, type InstanceOperationGate } from '../core/instance/operation-gate.ts';
import type { ProxySessionRegistry } from '../core/instance/proxy-session-registry.ts';
import type { InstanceAdminRuntime } from '../core/instance/admin-runtime.ts';

export const SID = 'tle_sid';
export const CSRF = 'tle_csrf';

export interface ServerDeps {
  config: EdgeConfig;
  db: Db;
  auth: AuthService;
  repo: InstanceRepo;
  service: InstanceService;
  /** Core 与 HTTP 共用的同一个 Admin API runtime；路由只做错误映射。 */
  adminRuntime: InstanceAdminRuntime;
  /** 所有运行期实例写操作共用的唯一闸门；路由不得自行构造。 */
  operationGate: InstanceOperationGate;
  /** 反代层现存 WebSocket 的唯一登记表；迁移核心只依赖这个 core port。 */
  proxySessions: ProxySessionRegistry;
  /** 实例上游地址；默认按容器名解析（Manager 与实例同处一个 docker 网络） */
  upstreamFor?: (instanceId: string) => string;
  /** 控制台前端产物目录。留空则不托管（宿主开发态走 Vite） */
  webRoot?: string | undefined;
  /**
   * 云端出口。微批攒够一批就调它。
   * 留空表示尚未配置云连接 —— 上行接口会如实回 `cloud: "not-configured"`，
   * 而不是假装已经发出去了。
   */
  cloudSink?: ((payload: unknown) => Promise<void>) | undefined;
  /**
   * 云连接运行期。有它时「是否已配置」以它为准，而不是看 cloudSink 在不在 ——
   * 配置可以热改，cloudSink 是个恒定的转发闭包，判断不了当前配没配。
   */
  cloud?: CloudRuntime | undefined;
  /** 云对接参数仓储。留空表示这个部署不提供云配置界面（如单测装配） */
  cloudConfig?: CloudConfigRepo | undefined;
  /**
   * 断网缓存。云端出口失败时批次落这里，链路恢复后自动补传。
   * 留空则失败即丢（并计数）—— 那是**明示**的降级，不是默认行为。
   */
  spool?: Spool | undefined;
  /**
   * 补传调度。触发口有三个（发送成功后 / 链路恢复 / 定时兜底），
   * 由 index.ts 统一持有 —— 路由层只负责在发送成功后捅一下。
   */
  drainer?: SpoolDrainer | undefined;
  /** 断网记录。留空表示这个部署不记录（如单测装配） */
  outages?: OutageLog | undefined;
  /**
   * 资源指标历史。留空表示没开后台采样 —— 趋势接口会如实回 `enabled: false`，
   * 界面据此说明「未启用」，而不是画一张空图让人以为系统坏了。
   */
  metrics?: MetricsHistory | undefined;
  /**
   * 私有节点源（01 号文 5.7）。留空则不挂载节点管理相关路由 ——
   * 单测装配用不到它，而挂一套空路由只会让「404 还是没权限」更难分辨。
   */
  nodeStore?: NodeStore | undefined;
  nodeCatalog?: NodeCatalog | undefined;
  /** 启动时已校验并建立基线的唯一平台包服务；固定包 HTTP 响应必须复用它。 */
  platformPackages: PlatformPackageService;
  /** 实例容器视角的私有源地址，用于生成 packument 里的包体 URL */
  npmRegistryUrl?: string | undefined;
  /**
   * 私有源的上游。留空即纯离线：库里没有的包一律 404，不去公网找。
   * 配了则库里没有时回源下载并入库，之后离线可用。
   */
  nodeUpstream?: UpstreamRegistry | undefined;
  /** 节点源清单仓储。页面上增删源走它 */
  nodeSources?: NpmSourceRepo | undefined;
  /**
   * 点位历史。留空或未启用时，趋势接口如实回 `enabled: false` ——
   * 界面据此说明「未启用」，而不是画一张空图让人以为系统坏了。
   */
  valueHistory?: ValueHistory | undefined;
}

const defaultUpstream = (id: string) => `http://${containerName(id)}:1880`;

export interface HttpContext {
  config: EdgeConfig;
  cloudSink: ((payload: unknown) => Promise<void>) | undefined;
  cloud: CloudRuntime | undefined;
  cloudConfig: CloudConfigRepo | undefined;
  spool: Spool | undefined;
  drainer: SpoolDrainer | undefined;
  outages: OutageLog | undefined;
  metrics: MetricsHistory | undefined;
  valueHistory: ValueHistory | undefined;
  db: Db;
  auth: AuthService;
  repo: InstanceRepo;
  service: InstanceService;
  adminRuntime: InstanceAdminRuntime;
  operationGate: InstanceOperationGate;
  proxySessions: ProxySessionRegistry;
  upstreamFor: (instanceId: string) => string;
  currentUser: (req: { cookies: Record<string, string | undefined> }) => ReturnType<AuthService['resolve']>;
  /**
   * 需登录 + 需授权。返回 undefined 表示已就地回了错误响应。
   *
   * `need` 是**必填**：新加路由时忘了声明权限会编译不过，而不是悄悄全放行。
   * 「忘了加校验」是越权漏洞最常见的成因，靠自觉防不住。
   *
   * 动作落在具体实例上时（view / operate / delete）还要额外过授权矩阵，
   * 传 `instance` 即可；不传而动作又是实例级的，会被当成越权拒掉。
   */
  guard: (
    req: any, reply: any,
    opts: {
      csrf: boolean; need: Action; instance?: string;
      allowPending?: boolean;
      /** 放行「还没绑两步验证」的会话。只有绑定相关的那几条路由该传 */
      allowEnroll?: boolean;
    },
  ) => ReturnType<AuthService['resolve']>;
  /** 授权矩阵仓储，用户管理路由要用 */
  users: UserRepo;
  /** 系统设置。每次读都回库里最新的值，改完立刻生效 */
  settings: SettingsRepo;
  /** 单点判权，给需要「能看但不一定能改」的接口用（设置页就是） */
  can: (user: { role: string }, action: Action) => boolean;
  /**
   * 这个用户能不能看见某台实例。
   *
   * 与 `guard` 分工：guard 管**单台实例**的路由（拿得到 id，拦得住）；
   * 这个用于**列表与聚合类**接口 —— 那类接口天然没有「某一台」可判，
   * guard 拦不住，漏过滤就是把别人的实例名连同读数一起端出去。
   */
  canSeeInstance: (user: { username: string; role: string }, instanceId: string) => boolean;
  /** 列表过滤的通用写法，省得每处各写一遍 filter */
  visibleOnly: <T extends { instanceId: string }>(
    user: { username: string; role: string }, items: T[],
  ) => T[];
  fail: (reply: any, e: unknown) => unknown;
  instanceIdFromUrl: (url: string) => string | undefined;
}

export function createContext(deps: ServerDeps): HttpContext {
  const { config, auth } = deps;
  const users = new UserRepo(deps.db);
  const settings = new SettingsRepo(deps.db);
  const currentUser = (req: { cookies: Record<string, string | undefined> }) =>
    auth.resolve(req.cookies[SID]);

  return {
    config,
    users,
    settings,
    can: (user, action) => can(user.role, action),
    cloudSink: deps.cloudSink,
    cloud: deps.cloud,
    cloudConfig: deps.cloudConfig,
    spool: deps.spool,
    drainer: deps.drainer,
    outages: deps.outages,
    metrics: deps.metrics,
    valueHistory: deps.valueHistory,
    db: deps.db,
    auth,
    repo: deps.repo,
    service: deps.service,
    adminRuntime: deps.adminRuntime,
    operationGate: deps.operationGate,
    proxySessions: deps.proxySessions,
    upstreamFor: deps.upstreamFor ?? defaultUpstream,
    currentUser,
    canSeeInstance: (user, instanceId) =>
      user.role === 'admin' || users.grantFor(user.username, instanceId) !== undefined,
    visibleOnly: (user, items) =>
      user.role === 'admin' ? items
        : items.filter((i) => users.grantFor(user.username, i.instanceId) !== undefined),
    guard: (req, reply, opts) => {
      const user = currentUser(req);
      if (!user) { reply.code(401).send({ error: '未登录' }); return undefined; }
      if (opts.csrf && !AuthService.csrfOk(req.headers['x-csrf-token'], req.cookies[CSRF])) {
        reply.code(403).send({ error: 'CSRF 校验失败' }); return undefined;
      }

      /*
       * 强制改密必须在**后端**拦。
       *
       * 之前只有 Vue 路由守卫在做这件事 —— 那只是界面上的引导，
       * 会话本身完全有效：拿着初始口令直接 curl 后端接口就能绕过去。
       * 而初始口令是**无人值守装机时由 INITIAL_PASSWORD 给的那一个**，
       * 它写在编排文件或 CI 变量里，见过它的人比该有权限的人多。
       *
       * 例外只有会话自身那三条（me / logout / change-password），
       * 它们不走 guard，天然放行 —— 否则用户会被锁死在无法改密的死循环里。
       */
      if (user.mustChangePassword && opts.allowPending !== true) {
        reply.code(403).send({
          error: '首次登录必须先修改初始口令，改完才能使用其它功能',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
        return undefined;
      }

      /*
       * 全站强制两步验证、而这个人还没绑 —— 同样拦在后端。
       *
       * 顺序在改密之后：先把初始口令换掉，再绑第二因子。反过来的话，
       * 用户会拿着 INITIAL_PASSWORD 那个初始口令去绑定，等于给一把
       * 已经躺在编排文件里的钥匙加了第二道锁。
       *
       * 例外是绑定本身那几条路由（`allowEnroll`）—— 不放行就成了死循环：
       * 要绑定得先能调接口，能调接口又得先绑定。
       */
      if (user.mustEnroll2fa && opts.allowEnroll !== true) {
        reply.code(403).send({
          error: '系统已要求启用两步验证，请先完成绑定',
          code: 'TOTP_ENROLL_REQUIRED',
        });
        return undefined;
      }

      if (isInstanceScoped(opts.need)) {
        // 实例级动作必须指名实例；没指名说明路由写错了，按拒绝处理而不是放行
        if (opts.instance === undefined) {
          reply.code(403).send({ error: `权限不足：${opts.need} 需要指定实例` });
          return undefined;
        }
        const grant = user.role === 'admin'
          ? undefined
          : users.grantFor(user.username, opts.instance);
        if (!canInstance(user.role, opts.need, grant)) {
          reply.code(403).send({ error: `权限不足：${opts.need} 于实例 ${opts.instance}` });
          return undefined;
        }
        return user;
      }

      if (!can(user.role, opts.need)) {
        reply.code(403).send({ error: `权限不足：${opts.need}` });
        return undefined;
      }
      return user;
    },
    fail: (reply, e) => reply
      .code(e instanceof InstanceBusyError ? 409 : 400)
      .send({
        error: (e as Error).message,
        ...(e instanceof InstanceBusyError ? { code: e.code } : {}),
      }),
    instanceIdFromUrl: (url: string) => {
      const re = new RegExp(`^${config.basePath}/red/([^/?]+)`);
      return re.exec(url)?.[1];
    },
  };
}

/** 路由模块的统一形状 */
export type RouteModule = (scope: FastifyInstance, ctx: HttpContext) => void;
