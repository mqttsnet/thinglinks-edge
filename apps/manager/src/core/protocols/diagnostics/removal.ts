import type { DockerClient } from '../../instance/docker-client.ts';
import type { InstanceRemovalLifecycle } from '../../instance/service.ts';
import { DiagnosticError } from './types.ts';
import type { ProtocolDiagnosticStore } from './store.ts';

/** Requests are not deletion evidence. This hook independently verifies the completed purge. */
export function diagnosticRemovalLifecycle(store: ProtocolDiagnosticStore, docker: DockerClient): InstanceRemovalLifecycle {
  return {
    beforeRemove(instanceId, { removeData }) {
      const pending = store.unfinished().some(task => task.instanceId === instanceId);
      if (pending && !removeData) throw new DiagnosticError('DIAGNOSTIC_CLEANUP_REQUIRED', '仍有未清理的诊断连接，请先重试清理，或选择同时删除实例数据。', 409);
      return pending;
    },
    async afterDataRemoved(instanceId) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The existing read-only verifier checks named container/network 404 and data path ENOENT.
        // Also reject surviving renamed owned containers; their client may still be running.
        await Promise.race([
          (async () => {
            await docker.assertBootstrapResourcesAbsent(instanceId);
            const survivors = await docker.raw.listContainers({ all: true, filters: { label: [
              'com.mqttsnet.thinglinks-edge.managed=true',
              `com.mqttsnet.thinglinks-edge.instance=${instanceId}`,
            ] } });
            if (survivors.length) throw new Error('实例仍有受管容器。');
          })(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('删除结果核验超时。')), 15000); }),
        ]);
        store.settlePurgedInstance(instanceId);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
