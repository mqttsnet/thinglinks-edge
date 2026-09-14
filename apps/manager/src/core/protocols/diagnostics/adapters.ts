import { createHash } from 'node:crypto';
import type { InstanceRepo } from '../../instance/repo.ts';
import type { DockerClient } from '../../instance/docker-client.ts';
import type { InstanceAdminRuntime } from '../../instance/admin-runtime.ts';
import { getInstalledModulesAuthenticated, listFlowsAuthenticated, createSingleFlow, getSingleFlow, deleteSingleFlow } from '../../flows/admin-client.ts';
import type { DiagnosticAdminPort, DiagnosticRuntimePort } from './service.ts';
const timeoutMs = 5000;
export function diagnosticGeneration(repo: InstanceRepo, instanceId: string): string | undefined {
  const instance = repo.get(instanceId);
  return instance ? createHash('sha256').update(instance.credSecret).digest('hex') : undefined;
}
export function diagnosticAdmin(runtime: InstanceAdminRuntime): DiagnosticAdminPort {
  return {
    readModules: id => getInstalledModulesAuthenticated(runtime.target(id), fetch, timeoutMs),
    listFlows: (id, reservedBytes = 0) => listFlowsAuthenticated(runtime.target(id), fetch, timeoutMs, reservedBytes),
    getFlow: (id, flowId) => getSingleFlow(runtime.target(id), flowId, fetch, timeoutMs),
    addFlow: (id, flow) => createSingleFlow(runtime.target(id), flow, fetch, timeoutMs),
    deleteFlow: (id, flowId) => deleteSingleFlow(runtime.target(id), flowId, fetch, timeoutMs),
  };
}
/** The raw daemon port is used only for immutable-ID reads, never for lifecycle mutations. */
export function diagnosticRuntime(repo: InstanceRepo, docker: DockerClient): DiagnosticRuntimePort {
  const absent = (error: unknown) => (error as {
    statusCode?: number;
  })?.statusCode === 404;
  async function bounded<T>(read: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('实例状态检查超时。')), timeoutMs); })]);
    }
    finally {
      if (timer)
        clearTimeout(timer);
    }
  }
  return {
    async inspect(id) {
      const generation = diagnosticGeneration(repo, id);
      if (!generation)
        return undefined;
      try {
        const info = await bounded(docker.containerRef(id).inspect());
        const labels = info.Config.Labels ?? {};
        if (labels['com.mqttsnet.thinglinks-edge.managed'] !== 'true' || labels['com.mqttsnet.thinglinks-edge.instance'] !== id)
          throw new Error('实例容器归属不匹配。');
        const env = info.Config.Env ?? [];
        const token = repo.ingestToken(id);
        const managerUrl = docker.expectedMigrationEnvironment().managerUrl;
        return { runtimeId: info.Id, generation, running: info.State.Running === true, callbackReady: !!token && !!managerUrl && env.filter(v => v.startsWith('TLE_INGEST_TOKEN=')).length === 1 && env.includes(`TLE_INGEST_TOKEN=${token}`) && env.filter(v => v.startsWith('TLE_MANAGER_URL=')).length === 1 && env.includes(`TLE_MANAGER_URL=${managerUrl}`) };
      }
      catch (error) {
        if (absent(error))
          return undefined;
        throw error;
      }
    },
    async exists(runtimeId) { try {
      await bounded(docker.raw.getContainer(runtimeId).inspect());
      return true;
    }
    catch (error) {
      if (absent(error))
        return false;
      throw error;
    } },
  };
}
