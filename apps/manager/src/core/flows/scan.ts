/**
 * 模板里的内联凭据扫描（T4.6）。
 *
 * 实测 Node-RED 5.0.4：`GET /flows` **不会**带出 credentials（它们单独存在
 * 加密的 flows_cred.json 里），所以按规范声明的凭据是安全的。
 * 但 function 节点里硬编码的密钥会原样带出来 —— 模板最常见的用途就是
 * 跨项目分发，这种密钥会跟着传出去。
 *
 * **只告警不剥离**：剥离会把 function 的代码改坏，那比泄漏更难查。
 */
import { redact } from '../diag/redact.ts';
import type { FlowNode } from './types.ts';

/**
 * 复用诊断脱敏那套模式：拿 `redact` 跑一遍，**看它有没有改动**。
 * 改了就说明命中了 `password=` / `apiKey:` / `Authorization:` 之类的形态。
 *
 * 逐节点扫而不是整体扫，是为了能报出「哪个节点」——
 * 只说「模板里有密钥」而不说在哪，等于让人自己翻几百个节点。
 */
export function scanInlineSecrets(flows: FlowNode[]): string[] {
  const hits: string[] = [];
  for (const n of flows) {
    const text = JSON.stringify(n);
    if (redact(text) !== text) {
      const label = n.name || n.label || n.id;
      hits.push(`${n.type} 「${label}」`);
    }
  }
  return hits;
}
