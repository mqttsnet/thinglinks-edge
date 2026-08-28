/**
 * 诊断路由装配。
 *
 * 这个文件是**唯一的例外**：仓库其余地方不用 barrel，但一个领域目录下
 * 有多组路由时，需要一个地方把它们一起挂上，否则 app.ts 就得逐个 import，
 * 加一组路由要改两处。这里只做转发，不含任何逻辑。
 */
import type { FastifyInstance } from 'fastify';
import type { HttpContext } from '../context.ts';
import { registerDiagBundle } from './bundle.ts';
import { registerDiagProbe } from './probe.ts';

export function registerDiag(api: FastifyInstance, ctx: HttpContext): void {
  registerDiagBundle(api, ctx);
  registerDiagProbe(api, ctx);
}
