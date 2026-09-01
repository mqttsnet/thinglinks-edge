/**
 * 访问实例 Admin API 所需的目标信息（T4.6）。
 *
 * 「导出流程」「套用模板」两组路由都要拼这个，抽出来避免两处各写一份 ——
 * 两份迟早漂移，而漂移的表现是「导得出来但套不上去」这种怪事。
 */
import { AdminApiError, type AdminTarget } from '../../core/flows/admin-client.ts';
import { TemplateError } from '../../core/flows/types.ts';
import { InstanceAdminRuntimeError } from '../../core/instance/admin-runtime.ts';
import type { HttpContext } from '../context.ts';

export type TargetOrError = AdminTarget | { error: string; code: number };

export function targetFor(ctx: HttpContext, id: string): TargetOrError {
  try {
    return ctx.adminRuntime.target(id);
  } catch (error) {
    if (!(error instanceof InstanceAdminRuntimeError)) throw error;
    const code = error.reason === 'instance-not-found' ? 404 : 500;
    return { error: error.message, code };
  }
}

/** 统一的错误映射：实例连不上是 502（我们没问题、上游有问题），不是 500 */
export function failTemplate(reply: any, e: unknown) {
  if (e instanceof TemplateError) return reply.code(400).send({ error: e.message });
  if (e instanceof AdminApiError) {
    return reply.code(e.status >= 400 && e.status < 500 ? 400 : 502).send({ error: e.message });
  }
  throw e;
}
