/**
 * HTTP 层共享上下文。
 *
 * 各路由模块只认这一个对象，不各自去 deps 里翻 —— 鉴权、CSRF、错误响应
 * 这三件事必须全站一致，散在各处迟早会出现某条路由漏掉 CSRF 的情况。
 */
import type { FastifyInstance } from 'fastify';
import type { EdgeConfig } from '../core/config.ts';
import { AuthService } from '../core/auth.ts';
import { InstanceRepo } from '../core/instance-repo.ts';
import type { InstanceService } from '../core/instance-service.ts';
import { containerName } from '../core/container-spec.ts';
import type { Db } from '../core/db.ts';
import type { Spool } from '../core/spool/spool.ts';
import type { MetricsHistory } from '../core/metrics-history.ts';

export const SID = 'tle_sid';
export const CSRF = 'tle_csrf';

export interface ServerDeps {
  config: EdgeConfig;
  db: Db;
  auth: AuthService;
  repo: InstanceRepo;
  service: InstanceService;
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
   * 断网缓存。云端出口失败时批次落这里，链路恢复后自动补传。
   * 留空则失败即丢（并计数）—— 那是**明示**的降级，不是默认行为。
   */
  spool?: Spool | undefined;
  /**
   * 资源指标历史。留空表示没开后台采样 —— 趋势接口会如实回 `enabled: false`，
   * 界面据此说明「未启用」，而不是画一张空图让人以为系统坏了。
   */
  metrics?: MetricsHistory | undefined;
}

const defaultUpstream = (id: string) => `http://${containerName(id)}:1880`;

export interface HttpContext {
  config: EdgeConfig;
  cloudSink: ((payload: unknown) => Promise<void>) | undefined;
  spool: Spool | undefined;
  metrics: MetricsHistory | undefined;
  db: Db;
  auth: AuthService;
  repo: InstanceRepo;
  service: InstanceService;
  upstreamFor: (instanceId: string) => string;
  currentUser: (req: { cookies: Record<string, string | undefined> }) => ReturnType<AuthService['resolve']>;
  /** 需登录；改状态的接口额外校验 CSRF。返回 undefined 表示已就地回了错误响应 */
  guard: (req: any, reply: any, opts: { csrf: boolean }) => ReturnType<AuthService['resolve']>;
  fail: (reply: any, e: unknown) => unknown;
  instanceIdFromUrl: (url: string) => string | undefined;
}

export function createContext(deps: ServerDeps): HttpContext {
  const { config, auth } = deps;
  const currentUser = (req: { cookies: Record<string, string | undefined> }) =>
    auth.resolve(req.cookies[SID]);

  return {
    config,
    cloudSink: deps.cloudSink,
    spool: deps.spool,
    metrics: deps.metrics,
    db: deps.db,
    auth,
    repo: deps.repo,
    service: deps.service,
    upstreamFor: deps.upstreamFor ?? defaultUpstream,
    currentUser,
    guard: (req, reply, opts) => {
      const user = currentUser(req);
      if (!user) { reply.code(401).send({ error: '未登录' }); return undefined; }
      if (opts.csrf && !AuthService.csrfOk(req.headers['x-csrf-token'], req.cookies[CSRF])) {
        reply.code(403).send({ error: 'CSRF 校验失败' }); return undefined;
      }
      return user;
    },
    fail: (reply, e) => reply.code(400).send({ error: (e as Error).message }),
    instanceIdFromUrl: (url: string) => {
      const re = new RegExp(`^${config.basePath}/red/([^/?]+)`);
      return re.exec(url)?.[1];
    },
  };
}

/** 路由模块的统一形状 */
export type RouteModule = (scope: FastifyInstance, ctx: HttpContext) => void;
