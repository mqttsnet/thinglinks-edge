/**
 * 实例反代。
 *
 * 实例 1880 不映射宿主；管理入口和各实例独立浏览器来源均通过本代理鉴权。
 *
 * 代理层绝不做路径重写 —— prefix === rewritePrefix。已在真实 Node-RED 5.0.4 验证：
 * 剥掉前缀会丢失尾斜杠 301，且编辑器算出的 WebSocket 路径不带实例前缀而无法路由。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import httpProxy from '@fastify/http-proxy';
import type { WebSocket } from 'ws';
import { AuthService } from '../../core/auth/service.ts';
import { canInstance } from '../../core/auth/authz.ts';
import { InstanceBusyError } from '../../core/instance/operation-gate.ts';
import type { ProxySessionAuthorization, ProxyWebSocketSession } from '../../core/instance/proxy-session-registry.ts';
import { SID, type HttpContext } from '../context.ts';
import { editorScope } from './editor-access.ts';
import { instanceRequestHeaders, instanceResponseHeaders } from './proxy-headers.ts';

export function registerProxy(app: FastifyInstance, ctx: HttpContext): void {
  const {
    config, repo, upstreamFor, currentUser, instanceIdFromUrl, users,
    operationGate, proxySessions,
  } = ctx;
  const websocketInstances = new WeakMap<object, { id: string; authorization: ProxySessionAuthorization; registered: boolean }>();
  const upgradeReleases = new WeakMap<object, () => void>();
  const sessionUnregisters = new WeakMap<object, () => void>();
  const sessionAuthorizations = new WeakMap<object, ProxySessionAuthorization>();

  const admitSocket = (source: WebSocket, target: WebSocket): boolean => {
    const rawSocket = (source as unknown as { _socket?: object })._socket;
    const pending = rawSocket ? websocketInstances.get(rawSocket) : undefined;
    const authorization = pending?.authorization ?? sessionAuthorizations.get(source);
    const unregister = authorization?.register(source as ProxyWebSocketSession);
    if (!unregister) {
      // http-proxy sends buffered frames after onConnect returns. Closing only the
      // client leaves one write able to reach a just-opened target after revocation.
      source.terminate();
      target.terminate();
      return false;
    }
    if (pending) pending.registered = true;
    if (!sessionUnregisters.has(source)) {
      sessionAuthorizations.set(source, authorization!);
      sessionUnregisters.set(source, unregister);
      source.once('close', () => {
        unregister();
        sessionAuthorizations.delete(source);
        sessionUnregisters.delete(source);
      });
    }
    return true;
  };

  // 浏览器看到的源。CSP 的 source 表达式必须带 host，不能只写路径
  const origin = new URL(config.externalUrl).origin;
  const editorPromptUrl = (id: string) => {
    const url = new URL(config.externalUrl);
    url.pathname = `${config.basePath}/instances`;
    url.search = new URLSearchParams({ editor: id }).toString();
    url.hash = ''; url.username = ''; url.password = '';
    return url.toString();
  };

  /**
   * 流程自己提供的路径：`settings.js` 里 `httpNodeRoot = <adminRoot>api/`。
   * 这一段的内容是**用户在流程里写的**，与管理台同源。
   */
  const flowPathOf = (id: string) => `${config.basePath}/red/${id}/api/`;

  const isFlowRequest = (id: string, url: string): boolean => {
    try {
      const path = new URL(decodeURIComponent(url.split('?')[0]!), origin).pathname;
      const root = flowPathOf(id);
      return path === root.slice(0, -1) || path.startsWith(root);
    } catch { return false; }
  };

  // Flow HTML is untrusted application content. An opaque origin prevents it
  // reading Manager/other editors' storage; the API's JSON responses are unchanged.
  // Dashboards requiring cookies or browser storage need an independent origin.
  const flowCsp = (id: string) => [
    `sandbox allow-scripts`,
    `default-src 'none'`,
    `script-src 'unsafe-inline' ${origin}${flowPathOf(id)}`,
    `style-src 'unsafe-inline' ${origin}${flowPathOf(id)}`,
    `img-src data: ${origin}${flowPathOf(id)}`,
    `connect-src ${origin}${flowPathOf(id)}`,
    `worker-src 'none'`,
    `object-src 'none'`,
    `frame-src 'none'`,
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
    wsClientOptions: {
      handshakeTimeout: 10_000,
      // http-proxy v11 supports this hook at runtime but omits it from its types.
      ...{ rewriteRequestHeaders: (_headers: IncomingHttpHeaders, request: FastifyRequest) => {
        const headers = instanceRequestHeaders(request.headers);
        // The WebSocket client generates its own handshake and negotiates protocols.
        for (const name of Object.keys(headers)) {
          if (name === 'host' || name === 'connection' || name === 'upgrade' || name.startsWith('sec-websocket-')) delete headers[name];
        }
        return headers;
      } },
    },
    wsHooks: {
      onConnect: (_hookContext, source, target) => {
        const rawSocket = (source as unknown as { _socket?: object })._socket;
        admitSocket(source, target);
        // Registration must become visible before migration can acquire the gate.
        if (rawSocket) upgradeReleases.get(rawSocket)?.();
      },
      onIncomingMessage: (_hookContext, source, target) => { admitSocket(source, target); },
      onOutgoingMessage: (_hookContext, source, target) => { admitSocket(source, target); },
      onDisconnect: (_hookContext, source) => {
        sessionUnregisters.get(source)?.();
        sessionUnregisters.delete(source);
        sessionAuthorizations.delete(source);
      },
    },
    replyOptions: {
      rewriteRequestHeaders: (_req, headers) => instanceRequestHeaders(headers),
      getUpstream: (req) => {
        const id = instanceIdFromUrl(req.url ?? '');
        // 未知实例指向不可用地址，由代理层报错而非误转发
        return id && repo.get(id) ? upstreamFor(id) : 'http://127.0.0.1:1';
      },
      /*
       * 管理来源的流程页面必须沙箱化；原生编辑器依赖同源存储，
       * 由外层 editor-origin gate 保证只在该实例的独立来源提供。
       */
      rewriteHeaders: (upstreamHeaders, req) => {
        const headers = instanceResponseHeaders(upstreamHeaders);
        const url = (req as { url?: string })?.url ?? '';
        const id = instanceIdFromUrl(url);
        if (id && !isFlowRequest(id, url)) headers['cache-control'] = 'no-store';
        if (id && isFlowRequest(id, url)) {
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
      // Runtime origins are accepted only on their own receiving socket, never
      // as trusted origins for Manager APIs or another instance's listener.
      const requestedId = instanceIdFromUrl(req.url ?? '');
      const localPort = req.raw.socket.localPort;
      const isolatedOriginAllowed = requestedId && localPort !== undefined
        && ctx.editorOrigins?.runtimeInstance(localPort) === requestedId
        && ctx.editorOrigins.matchesOrigin(requestedId, req.headers.origin);
      // Browsers do not apply the same-origin policy to WebSocket handshakes.
      if (!isolatedOriginAllowed && !AuthService.originAllowed(req.headers.origin, config.allowedOrigins)) {
        reply.code(403).send({ error: 'Origin 不被允许' });
        return;
      }
      if (req.headers['service-worker'] === 'script' || req.headers['sec-fetch-dest'] === 'serviceworker') {
        reply.code(403).send({ error: '实例不能在管理台来源注册 Service Worker' });
        return;
      }
      const user = currentUser(req);
      if (!user) {
        if (requestedId && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate'
          && !isFlowRequest(requestedId, req.url)) {
          reply.header('cache-control', 'no-store').redirect(editorPromptUrl(requestedId));
        } else reply.code(401).send({ error: '未登录' });
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
      if (user.mustEnroll2fa) {
        reply.code(403).send({ error: '系统已要求启用两步验证，请先完成绑定', code: 'TOTP_ENROLL_REQUIRED' });
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
      const flowRequest = isFlowRequest(id, req.url);
      const writing = flowRequest || upgrading
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

      const sessionId = req.cookies?.[SID] ?? '';
      if (!flowRequest && !ctx.editorAccess.check({ sessionId, username: user.username, instanceId: id, scope: editorScope(ctx, user, id) })) {
        reply.header('cache-control', 'no-store');
        if (!upgrading && method === 'GET' && req.headers.accept?.includes('text/html')) {
          reply.redirect(editorPromptUrl(id));
        } else reply.code(403).send({ error: '请先验证该实例的编辑器密码', code: 'EDITOR_PASSWORD_REQUIRED' });
        return;
      }

      if (!flowRequest && method === 'POST' && req.url.split('?')[0] === `${repo.get(id)!.adminRoot}auth/revoke`) {
        ctx.editorAccess.revokeSession(sessionId, id);
        proxySessions.closeSession(sessionId, id);
      }

      if (writing && upgrading) {
        const authorization = proxySessions.authorize({ instanceId: id, username: user.username, sessionId }, () => {
          const current = ctx.auth.peek(sessionId);
          if (!current || current.username !== user.username || current.mustChangePassword || current.mustEnroll2fa
            || !canInstance(current.role, 'instance:operate', current.role === 'admin' ? undefined : users.grantFor(current.username, id))) return false;
          return flowRequest || !!ctx.editorAccess.check({ sessionId, username: current.username, instanceId: id, scope: editorScope(ctx, current, id) });
        });
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
              const pending = websocketInstances.get(rawSocket);
              if (!pending?.registered) authorization.release();
              websocketInstances.delete(rawSocket);
              release();
            };
            websocketInstances.set(rawSocket, { id, authorization, registered: false });
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
          authorization.release();
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
