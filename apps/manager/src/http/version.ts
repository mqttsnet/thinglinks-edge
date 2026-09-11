/**
 * 版本信息与升级检查。
 *
 * 控制台据此做两件事：页脚显示当前版本；升级后首次打开弹一次「本次变更」。
 *
 * 为什么升级说明由**升级后**弹，而不是升级前提示：
 * 现场做升级的人（实施/运维）和日常用系统的人（作业人员）往往不是同一个。
 * 后者只会发现界面变了却不知道变了什么 —— 升级后的说明才是给他们看的。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteModule } from './context.ts';
import { VERSION, UpdateChecker } from '../core/version.ts';

/**
 * 使用者变更说明的存放目录。
 *
 * 与开发者变更日志同处 `changelogs/`，单一来源：
 *   `vX.Y.Z.md`        开发者（英文、含实现细节）
 *   `vX.Y.Z.zh-CN.md`  使用者（中文、只讲对操作的影响）—— 就是这里读的
 *
 * 读不到不算错：老版本可能没写使用者说明，此时不弹窗即可，
 * 不该因为缺一个文档文件就让接口失败。
 */
function resolveChangelogDir(): string {
  const explicit = process.env['CHANGELOG_DIR']?.trim();
  if (explicit) return explicit;

  // 容器里编译产物在 /app/dist/http/，开发态源码在 apps/manager/src/http/ ——
  // 两者到 changelogs 的相对深度不同，逐个试而不是猜一个。
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../changelogs', '../../../../changelogs']) {
    const dir = resolve(here, rel);
    if (existsSync(dir)) return dir;
  }
  return '';
}

const CHANGELOG_DIR = resolveChangelogDir();
if (CHANGELOG_DIR === '') {
  // 说出来。静默返回空只会表现成「升级后没弹说明」，没人会想到是路径没找到
  console.warn('[warn] 未找到 changelogs 目录，升级说明将不显示。可用 CHANGELOG_DIR 指定');
}

async function readReleaseNotes(version: string): Promise<string> {
  if (CHANGELOG_DIR === '') return '';
  try {
    return (await readFile(join(CHANGELOG_DIR, `v${version}.zh-CN.md`), 'utf8')).trim();
  } catch {
    // 该版本没写使用者说明属正常（老版本），不弹窗即可
    return '';
  }
}

export function registerVersion(scope: Parameters<RouteModule>[0], ctx: Parameters<RouteModule>[1]): void {
  const checker = new UpdateChecker({ url: ctx.config.updateCheckUrl });

  scope.get(`${ctx.config.basePath}/api/version`, async (req, reply) => {
    // 版本号是页脚常显信息，任何登录者都该看得到。
    // 用 system:view 而不是 instance:view —— 后者是**实例级**动作，缺实例即拒，
    // 这条路由没有实例可指，用了会永远 403。
    if (!ctx.guard(req, reply, { csrf: false, need: 'system:view' })) return;

    const notes = await readReleaseNotes(VERSION);

    /*
     * 设置里的开关是**第二道闸**，压在 URL 之上：
     * URL 是部署期决定的（配了才有得查），开关是运维随时能关的。
     * 工业现场对「设备自己往外连」很敏感，出了事要能立刻停掉，
     * 而不是去改 compose 再重启一遍。
     */
    if (!ctx.settings.get().updateCheckEnabled) {
      return reply.send({ version: VERSION, notes, update: { enabled: false } });
    }

    // 未启用时直接回，不引入任何网络等待
    if (!checker.enabled) {
      return reply.send({ version: VERSION, notes, update: { enabled: false } });
    }
    // 检查失败不影响本接口成功：版本号是本地事实，联网结果是附加信息
    const update = await checker.check().catch((e: Error) => ({
      enabled: true, error: `检查更新失败：${e.message}`,
    }));
    return reply.send({ version: VERSION, notes, update });
  });
}
