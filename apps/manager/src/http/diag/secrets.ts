/**
 * 运行时确实持有的秘密（T4.5）。
 *
 * 主密钥、每个实例的接入令牌与 Node-RED 口令、云侧的口令与密钥材料 ——
 * 这些是**按值脱敏**与**导出前自检**的依据。
 *
 * 单独成文件是因为诊断包与单次探测都要用，而它是这一层唯一碰凭据的地方：
 * 集中在一处，将来加了新的凭据来源，只有这一个文件要改，
 * 漏改的后果（诊断包里带出明文）也只需要盯这一处。
 */
import type { HttpContext } from '../context.ts';

/**
 * 取不到某一项就跳过那一项，但**绝不因为取不到而放弃自检**：
 * 宁可少一个已知值，不可少一道闸。
 */
export function collectSecrets(ctx: HttpContext): (string | undefined)[] {
  const out: (string | undefined)[] = [process.env['MASTER_KEY']];
  try {
    for (const id of ctx.repo.list().map((i) => i.id)) {
      out.push(ctx.repo.ingestToken(id));
      for (const c of ctx.repo.credentials(id)) out.push(c.password);
    }
  } catch { /* 库读不到就只用已收集到的部分 */ }
  try {
    const c = ctx.cloudConfig?.get();
    if (c) {
      out.push(c.password, c.cipher.signKey, c.cipher.encryptKey, c.cipher.encryptVector);
      if (c.tls?.key) out.push(c.tls.key);
    }
  } catch { /* 同上 */ }
  return out;
}

/** 探测目标数量上限。放开了就是个对内网的端口扫描器，不能不设限 */
export const MAX_TARGETS = 8;
export const MAX_TIMEOUT_MS = 15_000;
