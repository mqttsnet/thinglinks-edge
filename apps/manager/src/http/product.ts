import type { RouteModule } from './context.ts';
import { loadProductConfig, type ProductConfig } from '../core/product/config.ts';
import { GithubReleases } from '../core/product/releases.ts';

export function registerProduct(scope: Parameters<RouteModule>[0], ctx: Parameters<RouteModule>[1], options: {
  product?: ProductConfig; releases?: Pick<GithubReleases, 'read'>;
} = {}): void {
  const product = options.product ?? loadProductConfig();
  const releases = options.releases ?? new GithubReleases(product.githubRepository);
  // Login needs branding before authentication. Return only the dedicated public config.
  scope.get(`${ctx.config.basePath}/api/product`, async () => ({ product }));
  scope.post(`${ctx.config.basePath}/api/product/releases`, async (request, reply) => {
    if (!ctx.guard(request, reply, { csrf: true, need: 'system:view' })) return;
    if (!product.releasesEnabled || !ctx.settings.get().updateCheckEnabled) {
      return reply.send({ state: 'disabled', releases: [], checkedAt: '', message: '当前部署已关闭联网更新信息，可查看本版本说明或访问项目发布页。' });
    }
    return reply.send(await releases.read());
  });
}
