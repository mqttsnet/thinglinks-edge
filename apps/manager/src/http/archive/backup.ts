/**
 * 备份下载（T4.3）。
 *
 * 只提供**备份**，不提供在线恢复：恢复要覆盖正被 Manager 打开的库，
 * 在线做等于自找损坏。恢复走 CLI，恢复完再启动 —— 见 `core/backup.ts` 注释。
 */
import type { FastifyInstance } from 'fastify';
import { createBackup, inspectBackup } from '../../core/archive/backup.ts';
import { recordAudit } from '../../core/db.ts';
import type { HttpContext } from '../context.ts';

export function registerBackup(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, repo, guard } = ctx;

  const build = async () => {
    const instances = repo.list().map((i) => ({ id: i.id, name: i.name, imageTag: i.imageTag }));
    const schemaVersion = (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      { version: number } | undefined)?.version ?? 0;
    return createBackup({
      db, key: repo.key, instanceDataRoot: config.instanceDataRoot, instances, schemaVersion,
    });
  };

  /*
   * 用 POST 而不是 GET：备份里含全部实例凭据（加密的，但仍是敏感物），
   * 走 CSRF 校验的写操作通道更稳妥，也不会被浏览器预取或缓存。
   */
  api.post(`${config.basePath}/api/backup`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true, need: 'backup:run' });
    if (!user) return;
    const tar = await build();
    const name = `thinglinks-edge-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.tar`;
    recordAudit(db, {
      actor: user.username, action: 'backup', target: name,
      detail: `${tar.length} 字节`, result: 'ok',
    });
    return reply
      .header('content-type', 'application/x-tar')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(tar);
  });

  /** 只看内容不下载，供控制台展示「上次备份包含什么」 */
  api.post(`${config.basePath}/api/backup/inspect`, async (req, reply) => {
    if (!guard(req, reply, { csrf: true, need: 'backup:run' })) return;
    return reply.send(await inspectBackup(await build()));
  });
}
