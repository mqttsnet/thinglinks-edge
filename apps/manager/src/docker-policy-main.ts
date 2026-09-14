/** Standalone Docker execution boundary; deliberately does not initialize Manager or its database. */
import { lstat } from 'node:fs/promises';
import { policyConfigFromEnv } from './core/docker-policy/config.ts';
import { createDockerPolicyServer } from './core/docker-policy/server.ts';
import { initializePolicyStateDirectory } from './core/docker-policy/state-directory.ts';
import { lookup } from 'node:dns/promises';

async function main(): Promise<void> {
  const config = policyConfigFromEnv(process.env);
  const socketPath = '/var/run/docker.sock';
  if (!(await lstat(socketPath)).isSocket()) throw new Error('Docker socket unavailable');
  if (!(await lstat(config.dataRoot)).isDirectory()) throw new Error('Instance data root unavailable');
  initializePolicyStateDirectory(config);
  // Docker Desktop host aliases are not ordinary VM interfaces. Resolve only these
  // fixed platform names; native Mac LAN addresses remain explicit deployment input.
  for (const hostname of ['host.docker.internal', 'gateway.docker.internal']) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        lookup(hostname, { family: 4, all: true }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('lookup deadline')), 2000); }),
      ]);
      config.protectedHosts = [...new Set([...config.protectedHosts, ...addresses.map(entry => entry.address)])];
    } catch {
      // Linux deployments may not define Docker Desktop aliases. NetGuard also
      // derives VM-local addresses independently, while operator-listed hosts remain enforced.
    } finally { if (timer) clearTimeout(timer); }
  }
  const server = createDockerPolicyServer(config, { socketPath });
  server.listen(2375, '0.0.0.0');
  const stop = () => {
    server.close();
    const timer = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5_000);
    timer.unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

main().catch(() => {
  // Configuration may carry private filesystem locations. Keep startup errors fixed and actionable.
  console.error('Docker isolation policy could not start; check policy configuration, socket and data-root mounts');
  process.exitCode = 1;
});
