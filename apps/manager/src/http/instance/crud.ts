/** 实例：列表、创建、启停、删除、凭据重置、健康、日志。 */
import type { FastifyInstance } from 'fastify';
import { DockerLogStream, splitTimestamp } from '../../core/instance/log-stream.ts';
import type { HttpContext } from '../context.ts';

export function registerInstances(api: FastifyInstance, ctx: HttpContext): void {
  // guard / fail 统一取自上下文：鉴权与错误响应必须全站一致
  const { config, service, guard, fail, users } = ctx;

  /*
   * 列表类接口必须按授权矩阵**逐条过滤**。
   * 只在详情接口上判权是不够的 —— 列表把未授权实例的 id、名称、端口都摆出来了，
   * 那本身就是信息泄漏，而且用户会去点一个必然 403 的东西。
   */
  const visible = <T extends { id: string }>(user: { username: string; role: string }, items: T[]): T[] =>
    user.role === 'admin' ? items
      : items.filter((i) => users.grantFor(user.username, i.id) !== undefined);

  api.get(`${config.basePath}/api/instances`, async (req, reply) => {
    const user = guard(req, reply, { csrf: false, need: 'instance:list' });
    if (!user) return;
    const list = visible(user, await service.list());
    return reply.send({
      instances: list.map((i) => ({ ...i, openUrl: `${config.basePath}/red/${i.id}/sso` })),
    });
  });

  api.get(`${config.basePath}/api/instances/:id`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: (req.params as { id: string }).id })) return;
    const view = await service.get((req.params as { id: string }).id);
    return view ? reply.send({ instance: view }) : reply.code(404).send({ error: '实例不存在' });
  });

  /** 端口推荐 —— 只作建议，用户可自行填写 */
  api.get(`${config.basePath}/api/ports/recommend`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'instance:create' })) return;
    const count = Number((req.query as { count?: string }).count ?? '20');
    if (!Number.isInteger(count) || count < 0 || count > 200) {
      return reply.code(400).send({ error: 'count 需为 0-200 的整数' });
    }
    return reply.send({ recommended: service.recommendPorts(count) });
  });

  /** 可选的实例镜像版本 + 本机是否已有。前端据此标灰缺失版本，不再自己硬编码列表 */
  api.get(`${config.basePath}/api/images`, async (req, reply) => {
    // 这个列表只在「新建实例」弹窗里用，权限跟着建实例走；
    // instance:view 是实例级动作、缺实例即拒，这里没有实例可指
    if (!guard(req, reply, { csrf: false, need: 'instance:create' })) return;
    return reply.send({ images: await service.imageOptions() });
  });

  api.post(`${config.basePath}/api/instances`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'instance:create' });
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const view = await service.create({
        id: String(b['id'] ?? ''),
        name: String(b['name'] ?? ''),
        imageTag: String(b['imageTag'] ?? ''),
        memoryMb: Number(b['memoryMb'] ?? 512),
        cpus: Number(b['cpus'] ?? 0.5),
        // 端口映射逐条显式传入。这里只做形状归一，取值合法性交给
        // validatePortMappings —— 校验集中一处，HTTP 层不重复判断
        ports: Array.isArray(b['ports'])
          ? (b['ports'] as unknown[]).map((raw) => {
              const r = (raw ?? {}) as Record<string, unknown>;
              return {
                hostPort: Number(r['hostPort']),
                containerPort: Number(r['containerPort']),
                protocol: r['protocol'] === 'udp' ? ('udp' as const) : ('tcp' as const),
                hostIp: String(r['hostIp'] ?? '127.0.0.1'),
                purpose: String(r['purpose'] ?? ''),
              };
            })
          : [],
        actor: user.username,
      });
      return reply.code(201).send({ instance: view });
    } catch (e) { return fail(reply, e); }
  });

  for (const action of ['start', 'stop'] as const) {
    api.post(`${config.basePath}/api/instances/:id/${action}`, async (req, reply) => {
      const user = guard(req, reply, { csrf: true, need: 'instance:operate', instance: (req.params as { id: string }).id });
      if (!user) return;
      try {
        await service[action]((req.params as { id: string }).id, user.username);
        return reply.code(204).send();
      } catch (e) { return fail(reply, e); }
    });
  }

  api.delete(`${config.basePath}/api/instances/:id`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'instance:delete', instance: (req.params as { id: string }).id });
    if (!user) return;
    // 删数据卷必须显式指定，绝不默认删数据
    const removeData = (req.query as { removeData?: string }).removeData === 'true';
    try {
      await service.remove((req.params as { id: string }).id, { removeData, actor: user.username });
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  api.post(`${config.basePath}/api/instances/:id/credentials/:username/reset`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'instance:operate', instance: (req.params as { id: string }).id });
    if (!user) return;
    const { id, username } = req.params as { id: string; username: string };
    try {
      const password = await service.resetCredential(id, username, user.username);
      // 新口令只在此处返回一次，之后仅以密文留存
      return reply.send({ password });
    } catch (e) { return fail(reply, e); }
  });

  // ── 健康 ────────────────────────────────────────────────

  api.get(`${config.basePath}/api/health`, async (req, reply) => {
    const user = guard(req, reply, { csrf: false, need: 'instance:list' });
    if (!user) return;
    const [all, host] = await Promise.all([service.healthAll(), service.hostStats()]);
    const instances = visible(user, all);
    const summary = {
      total: instances.length,
      healthy: instances.filter((i) => i.verdict === 'healthy').length,
      degraded: instances.filter((i) => i.verdict === 'degraded').length,
      down: instances.filter((i) => i.verdict === 'down').length,
    };
    return reply.send({ summary, host, instances });
  });

  api.get(`${config.basePath}/api/instances/:id/health`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: (req.params as { id: string }).id })) return;
    try {
      return reply.send({ health: await service.health((req.params as { id: string }).id) });
    } catch (e) { return fail(reply, e); }
  });

  api.get(`${config.basePath}/api/instances/:id/logs`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: (req.params as { id: string }).id })) return;
    const tail = Number((req.query as { tail?: string }).tail ?? '200');
    try {
      const text = await service.logs((req.params as { id: string }).id, Math.min(Math.max(tail, 1), 2000));
      return reply.type('text/plain; charset=utf-8').send(text);
    } catch (e) { return fail(reply, e); }
  });

  /*
   * 实时日志（SSE）。
   *
   * 选 SSE 而不是 WebSocket：日志是单向的，SSE 走普通 HTTP、浏览器自带重连，
   * 也不需要像 WS 那样单独处理 Origin —— 反代那条链路的 CSWSH 防护
   * 是为双向通道准备的，这里用不上。
   *
   * 鉴权与快照接口同一套 guard；GET 不校验 CSRF。
   */
  api.get(`${config.basePath}/api/instances/:id/logs/stream`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: (req.params as { id: string }).id })) return;
    const { id } = req.params as { id: string };
    const tail = Number((req.query as { tail?: string }).tail ?? '200');

    /*
     * 断线续传。EventSource 重连时会自动带上 Last-Event-ID（我们下面发的 id 就是
     * 行时间戳），据此改用 `since` 续传 —— 否则每次重连都重放一遍 tail 历史，
     * 实测断一次连，19 行变成 105 行。
     */
    const sinceId = String(req.headers['last-event-id'] ?? '').trim();

    let upstream: NodeJS.ReadableStream;
    try {
      upstream = await service.logStream(
        id,
        sinceId ? { since: sinceId } : { tail: Math.min(Math.max(tail, 1), 2000) },
      );
    } catch (e) { return fail(reply, e); }

    /*
     * 接管原始响应。x-accel-buffering 是给中间可能存在的 nginx 看的 ——
     * 缓冲一开，实时日志就会攒够一整块才吐，表现为「界面卡住不动」。
     */
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.hijack();

    reply.raw.write('retry: 3000\n\n');

    const demux = new DockerLogStream();
    const send = (line: { stream: string; text: string }) => {
      const { ts, text } = splitTimestamp(line.text);
      // Docker 的 since 只精确到秒，边界那一秒会被重发；这里按补齐后的时间戳丢掉已发过的
      if (sinceId && ts && ts <= sinceId) return;
      if (ts) reply.raw.write(`id: ${ts}\n`);
      reply.raw.write(`data: ${JSON.stringify({ stream: line.stream, text })}\n\n`);
    };

    // 心跳：链路上任何一层的空闲超时都会悄悄掐断长连接，注释行足够保活
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    const close = () => {
      clearInterval(heartbeat);
      // 不 destroy 上游，Docker 侧会一直往一个没人读的流里写
      (upstream as unknown as { destroy?: () => void }).destroy?.();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    upstream.on('data', (chunk: Buffer) => demux.push(chunk).forEach(send));
    upstream.on('end', () => { demux.flush().forEach(send); close(); });
    upstream.on('error', close);
    req.raw.on('close', close);
  });
}
