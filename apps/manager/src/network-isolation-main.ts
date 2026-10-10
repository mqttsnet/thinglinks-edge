/** Privileged network boundary. This entry never exposes a Docker socket or shell API. */
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNetworkIsolationConfig, assertRuntimeCapabilities } from './core/network-isolation/config.ts';
import { FileDescriptorStore } from './core/network-isolation/store.ts';
import { NetworkFirewall, createCommandRunner } from './core/network-isolation/firewall.ts';
import { NetworkIsolationController } from './core/network-isolation/controller.ts';
import { startNetworkIsolationServers } from './core/network-isolation/server.ts';

export async function runNetworkIsolation(env: NodeJS.ProcessEnv = process.env): Promise<{ close(): Promise<void> }> {
  const config = parseNetworkIsolationConfig(env);
  if (process.platform !== 'linux') throw new Error('网络保护入口只能运行于独立 Linux 容器');
  assertRuntimeCapabilities(process.platform, process.getuid?.(), await readFile('/proc/self/status', 'utf8'));
  const writableRoot = await access('/etc/passwd', constants.W_OK).then(() => true, () => false);
  const socketExposed = await Promise.all(['/var/run/docker.sock', '/run/docker.sock'].map(path => access(path).then(() => true, () => false)));
  if (writableRoot || socketExposed.some(Boolean)) throw new Error('网络保护容器必须只读且不得挂载 Docker socket');
  const store = new FileDescriptorStore(config.stateDir);
  const ownerId = await store.ownerId();
  const firewall = new NetworkFirewall(createCommandRunner(), config.healthPort, ownerId, config.extraProtectedHosts);
  const controller = new NetworkIsolationController(store, firewall);
  await controller.initialize();
  const servers = await startNetworkIsolationServers(controller, config);
  const timer = setInterval(() => { void controller.reconcile().catch(() => { console.error('network isolation reconciliation incomplete'); }); }, config.reconcileMs);
  timer.unref();
  return { close: async () => {
    clearInterval(timer);
    // Kernel protection survives crashes, planned restarts and ordinary shutdown.
    // Only an explicit authorized unregister operation removes an instance policy.
    await servers.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runNetworkIsolation().then(service => {
    const close = () => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  }).catch(error => { console.error(error instanceof Error ? error.message : 'network isolation startup failed'); process.exitCode = 1; });
}
