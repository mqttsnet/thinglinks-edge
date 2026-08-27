/**
 * 版本信息与升级检查。
 *
 * 控制台据此做两件事：页脚显示当前版本；升级后首次打开弹一次「本次变更」。
 *
 * 为什么升级说明由**升级后**弹，而不是升级前提示：
 * 现场做升级的人（实施/运维）和日常用系统的人（作业人员）往往不是同一个。
 * 后者只会发现界面变了却不知道变了什么 —— 升级后的说明才是给他们看的。
 */
import type { RouteModule } from './context.ts';
import { VERSION, UpdateChecker } from '../core/version.ts';

export function registerVersion(scope: Parameters<RouteModule>[0], ctx: Parameters<RouteModule>[1]): void {
  const checker = new UpdateChecker({ url: ctx.config.updateCheckUrl });

  scope.get(`${ctx.config.basePath}/api/version`, async (req, reply) => {
    if (!ctx.guard(req, reply, { csrf: false })) return;

    // 未启用时直接回，不引入任何网络等待
    if (!checker.enabled) {
      return reply.send({ version: VERSION, update: { enabled: false } });
    }
    // 检查失败不影响本接口成功：版本号是本地事实，联网结果是附加信息
    const update = await checker.check().catch((e: Error) => ({
      enabled: true, error: `检查更新失败：${e.message}`,
    }));
    return reply.send({ version: VERSION, update });
  });
}
