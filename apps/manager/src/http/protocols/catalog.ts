import type { FastifyInstance } from 'fastify';
import type { HttpContext } from '../context.ts';
import { targetFor } from '../instance/flows-target.ts';
import { getInstalledModules, type AdminTarget, type InstalledModule } from '../../core/flows/admin-client.ts';
import { aggregateNodeSets } from '../../core/nodes/inventory.ts';
import type { NodeStore } from '../../core/nodes/store.ts';
import type { NodeCatalog } from '../../core/nodes/catalog.ts';
import { protocolStatuses } from '../../core/protocols/catalog.ts';
import { storedPackageFacts } from '../../core/protocols/store.ts';

export interface ProtocolDeps {
  store: NodeStore;
  catalog: NodeCatalog;
  /** Read-only runtime boundary; tests use this without a running Node-RED. */
  readModules?: (target: AdminTarget) => Promise<InstalledModule[]>;
}

export function registerProtocols(api: FastifyInstance, ctx: HttpContext, deps: ProtocolDeps): void {
  api.get(`${ctx.config.basePath}/api/protocols`, async (req, reply) => {
    if (!ctx.guard(req, reply, { csrf: false, need: 'node:view' })) return;
    return reply.send({ protocols: protocolStatuses(storedPackageFacts(deps.store, deps.catalog)) });
  });

  api.get(`${ctx.config.basePath}/api/instances/:id/protocols`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id })) return;
    const target = targetFor(ctx, id);
    if ('error' in target) return reply.code(target.code).send({ error: target.error });
    const facts = storedPackageFacts(deps.store, deps.catalog);
    try {
      const modules = await (deps.readModules ?? getInstalledModules)(target);
      const inventory = aggregateNodeSets(modules.flatMap((m) => m.nodeSets));
      return reply.send({ instanceId: id, inspected: true, protocols: protocolStatuses(facts, inventory.modules) });
    } catch {
      return reply.send({ instanceId: id, inspected: false, inspectionError: '无法读取实例节点状态，请确认实例已运行后重试。',
        protocols: protocolStatuses(facts, []) });
    }
  });
}
