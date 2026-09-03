/**
 * 实例反代。
 *
 * 放在主程序内而非 nginx：只需配一个域名一张证书，nginx 配置永不变；
 * 实例 1880 不映射宿主，唯一入口是本进程，鉴权因此天然统一。
 *
 * 代理层绝不做路径重写 —— prefix === rewritePrefix。已在真实 Node-RED 5.0.4 验证：
 * 剥掉前缀会丢失尾斜杠 301，且编辑器算出的 WebSocket 路径不带实例前缀而无法路由。
 */
import type { FastifyInstance } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { AuthService } from '../../core/auth/service.ts';
import { canInstance } from '../../core/auth/authz.ts';
import { InstanceBusyError } from '../../core/instance/operation-gate.ts';
import type { ProxyWebSocketSession } from '../../core/instance/proxy-session-registry.ts';
import type { HttpContext } from '../context.ts';

export function registerProxy(app: FastifyInstance, ctx: HttpContext): void {
  const {
    config, repo, upstreamFor, currentUser, instanceIdFromUrl, users,
    operationGate, proxySessions,
  } = ctx;
  const websocketInstances = new WeakMap<object, string>();
  const upgradeReleases = new WeakMap<object, () => void>();
  const sessionUnregisters = new WeakMap<object, () => void>();

  // 浏览器看到的源。CSP 的 source 表达式必须带 host，不能只写路径
  const origin = new URL(config.externalUrl).origin;

  /**
   * 流程自己提供的路径：`settings.js` 里 `httpNodeRoot = <adminRoot>api/`。
   * 这一段的内容是**用户在流程里写的**，与管理台同源。
   */
  const flowPathOf = (id: string) => `${config.basePath}/red/${id}/api/`;

  /**
   * 给流程页面加 CSP。
   *
   * 要解决的问题：`http in` / Function 节点能在**管理台同源**下返回任意 HTML+JS。
   * 那段脚本带着管理员的会话 Cookie，且能读到双提交用的 CSRF Cookie ——
   * 于是可以伪造任意管理接口调用。这是控制台完全接管。
   *
   * 为什么不靠 Cookie 或 CSRF 修：同源之内，攻击脚本读得到 CSRF Token、
   * 发得出凭据请求，**任何 Token 技巧都挡不住**。根治办法是把实例挪到独立的源
   * （另一个端口或子域），那是架构改动，见下面的 TODO。
   *
   * 这里做的是精确削权：`connect-src` 只放行**这台实例自己的流程路径**，
   * 于是流程页面照样能调自己的后端（Dashboard 之类不受影响），
   * 但 `fetch('/api/users')` 会被浏览器直接拒掉。
   * `form-action` 一并封死，否则表单 POST 能绕过 connect-src。
   */
  const flowCsp = (id: string) => [
    `default-src 'self'`,
    `connect-src ${origin}${flowPathOf(id)}`,
    `form-action 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');

  app.register(httpProxy, {
    upstream: '',
    prefix: `${config.basePath}/red`,
    // 与 prefix 相同：保留完整路径前缀，绝不重写
    rewritePrefix: `${config.basePath}/red`,
    websocket: true,
    wsHooks: {
      onConnect: (_hookContext, source) => {
        const rawSocket = (source as unknown as { _socket?: object })._socket;
        const id = rawSocket ? websocketInstances.get(rawSocket) : undefined;
        if (!rawSocket || !id) {
          // An untracked bidirectional channel would bypass the migration fence.
          source.close(1011, 'instance operation lease missing');
          return;
        }
        const unregister = proxySessions.register(id, source as ProxyWebSocketSession);
        sessionUnregisters.set(source, unregister);
        // Registration must become visible before migration can acquire the gate.
        upgradeReleases.get(rawSocket)?.();
      },
      onDisconnect: (_hookContext, source) => {
        sessionUnregisters.get(source)?.();
        sessionUnregisters.delete(source);
      },
    },
    replyOptions: {
      getUpstream: (req) => {
        const id = instanceIdFromUrl(req.url ?? '');
        // 未知实例指向不可用地址，由代理层报错而非误转发
        return id && repo.get(id) ? upstreamFor(id) : 'http://127.0.0.1:1';
      },
      /*
       * 只给**流程提供的路径**加 CSP，编辑器那段（adminRoot 本身）不动 ——
       * 编辑器是平台自己的界面，加了反而会把它拆坏。
       */
      rewriteHeaders: (headers, req) => {
        const url = (req as { url?: string })?.url ?? '';
        const id = instanceIdFromUrl(url);
        if (id && url.startsWith(flowPathOf(id))) {
          headers['content-security-policy'] = flowCsp(id);
          // 流程返回 text/plain 时不许浏览器嗅探成 HTML 执行
          headers['x-content-type-options'] = 'nosniff';
        }
        return headers;
      },
    },
    /*
     * preHandler 同时覆盖普通请求与 WebSocket 升级 ——
     * @fastify/http-proxy 会把 upgrade 请求走正常 Fastify 路由并触发 hooks，
     * 因此鉴权与 Origin 校验都放这里。
     *
     * 注意：v11 没有 wsUpgrade 这个用户选项（同名 Symbol 是内部实现），
     * 传了会被静默忽略 —— 不要依赖它做鉴权。
     */
    preHandler: (req, reply, done) => {
      // 浏览器不对 WebSocket 施加同源策略，仅靠 Cookie 会被跨站劫持（CSWSH）
      if (!AuthService.originAllowed(req.headers.origin, config.allowedOrigins)) {
        reply.code(403).send({ error: 'Origin 不被允许' });
        return;
      }
      const user = currentUser(req);
      if (!user) {
        reply.code(401).send({ error: '未登录' });
        return;
      }
      /*
       * 反代走的是 currentUser 而不是 guard，所以强制改密要在这里单独拦一次。
       * 漏了这一处，待改密的用户虽然进不了控制台，却能直接打开 Node-RED 编辑器 ——
       * 那后面是整台实例的 admin API。
       */
      if (user.mustChangePassword) {
        reply.code(403).send({ error: '首次登录必须先修改初始口令' });
        return;
      }
      const id = instanceIdFromUrl(req.url ?? '');
      if (!id || !repo.get(id)) {
        reply.code(404).send({ error: '实例不存在' });
        return;
      }
      /*
       * 反代也必须过授权矩阵。
       *
       * 这里是**整个平台最大的越权面**：编辑器背后是完整的 Node-RED admin API，
       * 拿到它等于拿到那台实例的一切。只在 /api 上判权而放过 /red，
       * 等于把后门开在正门旁边。
       *
       * 读写要分开判，否则「只读」是假的：编辑器是同一个页面，
       * 部署流程走的是 `POST /flows`、装节点走 `POST /nodes`、
       * 手动触发 inject 走 `POST /inject/:id` —— 一律按写操作要求 operate。
       * 只判 view 的话，给了「只读」授权的人照样能改别人产线的流程，
       * 而界面上他看起来只是「能看」。
       *
       * **WebSocket 升级一律按写操作判**，尽管握手本身是 GET。
       *
       * 握手方法只描述握手，不描述握手之后的会话 —— 通道建起来就是双向的。
       * 而实例的 `httpNodeRoot` 是 `<adminRoot>api/`，与编辑器同处一个反代前缀：
       * 流程里放一个 `websocket in` 节点就能对外开一个端点，
       * 只读用户握手成功后即可往流程里灌消息。那不是「看」，是「写」。
       *
       * 代价是只读用户打开编辑器时拿不到 comms 实时事件流（调试侧栏没有消息、
       * 节点状态不刷新），编辑器会提示连接中断。这是**有意的取舍**：
       * 另一条路是只放行编辑器自己的 `<adminRoot>comms`，但那要依赖
       * 「Node-RED 的 comms 通道不可写」这个第三方内部行为 ——
       * 本项目已经在 `wsUpgrade` 上栽过一次「能用但机制是错的」，不再赌第二次。
       */
      const method = (req.method ?? 'GET').toUpperCase();
      const upgrading = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
      const writing = upgrading
        || (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS');
      const need = writing ? 'instance:operate' : 'instance:view';
      if (!canInstance(user.role, need,
                       user.role === 'admin' ? undefined : users.grantFor(user.username, id))) {
        reply.code(403).send({
          error: upgrading
            ? `只读授权：对实例 ${id} 不能建立实时通道（该通道可向流程写入）`
            : writing
              ? `只读授权：对实例 ${id} 只能查看，不能改动流程`
              : `无权访问实例 ${id}`,
        });
        return;
      }

      if (writing && upgrading) {
        /*
         * 握手只持有 lease 到 wsHooks.onConnect 把 source WebSocket 登记完成。
         * 先释放会留下一个窗口：迁移已取得 gate、快照已开始，而刚通过鉴权
         * 的 WebSocket 还没进入可 drain 的登记表。
         */
        void operationGate.run(id, 'proxy-write', async () => {
          await new Promise<void>((release) => {
            const rawSocket = req.raw.socket;
            let released = false;
            const finish = () => {
              if (released) return;
              released = true;
              rawSocket.off('close', finish);
              rawSocket.off('error', finish);
              reply.raw.off('finish', finish);
              reply.raw.off('close', finish);
              reply.raw.off('error', finish);
              upgradeReleases.delete(rawSocket);
              websocketInstances.delete(rawSocket);
              release();
            };
            websocketInstances.set(rawSocket, id);
            upgradeReleases.set(rawSocket, finish);
            rawSocket.once('close', finish);
            rawSocket.once('error', finish);
            // Covers a rejected/failed upgrade and Fastify injection tests.
            reply.raw.once('finish', finish);
            reply.raw.once('close', finish);
            reply.raw.once('error', finish);
            done();
          });
        }).catch((error: unknown) => {
          if (reply.sent) return;
          reply
            .code(error instanceof InstanceBusyError ? 409 : 500)
            .send({
              error: (error as Error).message,
              ...(error instanceof InstanceBusyError ? { code: error.code } : {}),
            });
        });
        return;
      }

      if (writing) {
        /*
         * 代理请求在 preHandler 之后才真正发往实例，所以闸门工作函数必须先
         * 调 done() 放行代理、再等待响应终止。只包住 preHandler 会在上游真正
         * 改完之前释放 lease，让迁移快照与仍在飞行的 POST 发生竞态。
         */
        void operationGate.run(id, 'proxy-write', async () => {
          await new Promise<void>((release) => {
            let released = false;
            const finish = () => {
              if (released) return;
              released = true;
              reply.raw.off('finish', finish);
              reply.raw.off('close', finish);
              reply.raw.off('error', finish);
              req.raw.off('aborted', finish);
              release();
            };
            reply.raw.once('finish', finish);
            reply.raw.once('close', finish);
            reply.raw.once('error', finish);
            req.raw.once('aborted', finish);
            done();
          });
        }).catch((error: unknown) => {
          if (reply.sent) return;
          reply
            .code(error instanceof InstanceBusyError ? 409 : 500)
            .send({
              error: (error as Error).message,
              ...(error instanceof InstanceBusyError ? { code: error.code } : {}),
            });
        });
        return;
      }
      done();
    },
  });
}
