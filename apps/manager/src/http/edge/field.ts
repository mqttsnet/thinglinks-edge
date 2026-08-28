/**
 * 现场台账的**读**接口（控制台用）。
 *
 * 与 ./ingest.ts 分开的理由是**鉴权方式不同**，这是一条真实的边界：
 *
 *   · `/api/edge/*`  —— 实例用**接入令牌**往里写（长期运行的自动化流程，没有「登录」）
 *   · `/api/field/*` —— 人用**管理会话**往外读，要过角色与实例授权矩阵
 *
 * 混在一个文件里，改动时很容易把某条路由挂到错误的鉴权上，
 * 而那种错误不会报错 —— 只会让某个接口悄悄变成谁都能调。
 */
import type { FastifyInstance } from 'fastify';
import { FieldRegistry } from '../../core/edge/registry.ts';
import { probeFlows } from '../../core/edge/southbound.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpContext } from '../context.ts';

export function registerField(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, visibleOnly } = ctx;
  const registry = new FieldRegistry(db);

  /**
   * 读台账的鉴权。
   *
   * 不指定实例时判 `field:view`（看全厂汇总）；指定了就必须过**那台实例**的
   * 授权矩阵 —— 否则只要有 field:view，换个 instanceId 就能读到别人的台账。
   */
  const fieldGuard = (req: any, reply: any, instanceId: string | undefined) =>
    (instanceId === undefined
      ? guard(req, reply, { csrf: false, need: 'field:view' })
      : guard(req, reply, { csrf: false, need: 'instance:view', instance: instanceId }));

  // ── 控制台读取（走管理会话，不是接入令牌）────────────────
  api.get(`${config.basePath}/api/field/devices`, async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    const user = fieldGuard(req, reply, instanceId);
    if (!user) return;
    return reply.send({ devices: visibleOnly(user, registry.devices(instanceId)) });
  });

  api.get(`${config.basePath}/api/field/tags`, async (req, reply) => {
    const { instanceId, nodeId } = req.query as { instanceId?: string; nodeId?: string };
    const user = fieldGuard(req, reply, instanceId);
    if (!user) return;
    return reply.send({ tags: visibleOnly(user, registry.tags(instanceId, nodeId)) });
  });

  /*
   * 南向探测（06 号文方案 A）。解析实例的 flows.json 反推用户用原生
   * modbus / OPC UA / S7 节点接的设备 —— **尽力而为，不是可靠台账**。
   *
   * 结果恒带 `managed: false`，并把「认不出的节点类型」一并返回。
   * 界面必须标「未纳管」，且不能把这些数字和真实台账加在一起显示 ——
   * 让用户以为看到的是全部，是诚信问题（06 号文原话）。
   */
  api.get(`${config.basePath}/api/field/southbound`, async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    // 这条**必须**指名实例：它读的是那台实例的 flows.json，
    // 里面是设备 IP 与寄存器地址，比台账更敏感
    if (!instanceId) {
      if (!guard(req, reply, { csrf: false, need: 'field:view' })) return;
      return reply.code(400).send({ error: '缺少 instanceId' });
    }
    if (!guard(req, reply, { csrf: false, need: 'instance:view', instance: instanceId })) return;

    const flowsPath = join(config.instanceDataRoot, instanceId, 'flows.json');
    const raw = await readFile(flowsPath, 'utf8').catch(() => undefined);
    if (raw === undefined) {
      // 实例还没部署过流程时没有这个文件，属正常，不是错误
      return reply.send({ ...probeFlows(null), reason: '该实例尚无 flows.json（未部署过流程）' });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      return reply.send({ ...probeFlows(null), reason: 'flows.json 不是合法 JSON，无法探测' });
    }
    return reply.send(probeFlows(parsed));
  });

  api.get(`${config.basePath}/api/field/summary`, async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    const user = fieldGuard(req, reply, instanceId);
    if (!user) return;
    /*
     * 两类数字**必须分开返回**，不能相加：
     * `managed` 是节点集回报的可信台账（有当前值、有质量码）；
     * `probed` 是从 flows.json 反推的尽力探测（没有运行时数据，可能漏）。
     * 加在一起显示会让用户以为那是同一种东西。
     */
    // 汇总数字同样只能覆盖看得见的实例，否则「全厂多少台设备」会被越权读出来
    const devices = visibleOnly(user, registry.devices(instanceId));
    const tags = visibleOnly(user, registry.tags(instanceId));
    return reply.send({
      managed: {
        devices: devices.length,
        online: devices.filter((d) => d.online).length,
        tags: tags.length,
      },
      note: '「已纳管」来自 @thinglinks 节点主动回报，含当前值与质量码；'
          + '用原生 modbus/opcua/s7 节点采集的部分请看 /api/field/southbound，那是尽力探测，未纳管',
    });
  });
}
