/**
 * 访问实例 Admin API 所需的目标信息（T4.6）。
 *
 * 「导出流程」「套用模板」两组路由都要拼这个，抽出来避免两处各写一份 ——
 * 两份迟早漂移，而漂移的表现是「导得出来但套不上去」这种怪事。
 */
import { AdminApiError, type AdminTarget } from '../../core/flows/admin-client.ts';
import { TemplateError } from '../../core/flows/types.ts';
import type { HttpContext } from '../context.ts';

export type TargetOrError = AdminTarget | { error: string; code: number };

export function targetFor(ctx: HttpContext, id: string): TargetOrError {
  const inst = ctx.repo.get(id);
  if (!inst) return { error: `实例 ${id} 不存在`, code: 404 };
  const cred = ctx.repo.credentials(id)[0];
  if (!cred) return { error: `实例 ${id} 无可用账号`, code: 500 };
  return {
    upstream: ctx.upstreamFor(id),
    adminRoot: inst.adminRoot,
    username: cred.username,
    password: cred.password,
  };
}

/** 统一的错误映射：实例连不上是 502（我们没问题、上游有问题），不是 500 */
export function failTemplate(reply: any, e: unknown) {
  if (e instanceof TemplateError) return reply.code(400).send({ error: e.message });
  if (e instanceof AdminApiError) {
    return reply.code(e.status >= 400 && e.status < 500 ? 400 : 502).send({ error: e.message });
  }
  throw e;
}
