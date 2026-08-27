/**
 * ThingLinks Edge Manager —— 入口。
 *
 * 当前阶段只做 Node-RED 多实例这条垂直切片，兄弟容器模式。
 * 其余能力（南向接入、云边协同、告警）按 tasks/plan.md 后置。
 */
import { loadConfig } from './core/config.ts';
import { openDb } from './core/db.ts';
import { requireMasterKey, deriveKey, generatePassword } from './core/crypto.ts';
import { AuthService } from './core/auth.ts';
import { InstanceRepo } from './core/instance-repo.ts';
import { InstanceService } from './core/instance-service.ts';
import { DockerClient } from './core/docker-client.ts';
import { buildServer } from './server.ts';
import { join } from 'node:path';

export const VERSION = '0.1.0';

export function describe(): string {
  return `ThingLinks Edge Manager v${VERSION}`;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const key = deriveKey(requireMasterKey(), 'thinglinks-edge:instance-cred');
  const db = openDb(join(config.dataDir, 'edge.db'));

  const auth = new AuthService(db);
  const repo = new InstanceRepo(db, key);

  // 首次启动生成随机初始口令并打印一次；标记必须改密
  const initialPassword = process.env['INITIAL_PASSWORD'] ?? generatePassword();
  if (auth.ensureInitialUser('admin', initialPassword)) {
    console.log(`[init] 已创建初始账号 admin，初始口令：${initialPassword}`);
    console.log('[init] 首次登录后必须修改口令，之后此口令即失效。');
  }

  const docker = new DockerClient({
    network: process.env['INSTANCE_NETWORK'] ?? 'thinglinks-edge',
    imageRepo: process.env['NODE_RED_IMAGE_REPO'] ?? 'nodered/node-red',
    portRange: config.portRange,
  });
  const service = new InstanceService({
    db, repo, docker,
    basePath: config.basePath,
    portRange: config.portRange,
    allowedImageTags: (process.env['ALLOWED_IMAGE_TAGS'] ??
      '5.0.4-24-minimal,4.1.13-22-minimal').split(',').map((s) => s.trim()).filter(Boolean),
  });

  const app = buildServer({ config, db, auth, repo, service });
  await app.listen({ host: config.listenAddr, port: config.listenPort });
  console.log(
    `[ready] ${describe()} 监听 ${config.listenAddr}:${config.listenPort}` +
      ` · 外部地址 ${config.externalUrl}`,
  );
}

// 直接运行时启动服务；被 import 时只导出
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  main().catch((e) => {
    console.error('[fatal]', (e as Error).message);
    process.exit(1);
  });
}
