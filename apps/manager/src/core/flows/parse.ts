/**
 * flows 解析与体检（T4.6）。
 *
 * 存进来之前就确认它是个合法的 flows 数组，而不是等到套用时才由 Node-RED 拒绝 ——
 * 那时候目标实例的流程可能已经被清掉了。
 */
import { TemplateError, type FlowNode, type TemplateSummary } from './types.ts';

/**
 * 解析 flows。
 *
 * 接受字符串或已解析的数组两种形态：前者来自上传的文件，后者来自实例的
 * Admin API 响应。两条路都要过同一套校验，不能因为「来自我们自己的实例」就放行 ——
 * 实例里的流程也可能被人手工改坏。
 */
export function parseFlows(input: unknown): FlowNode[] {
  let value = input;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') throw new TemplateError('模板内容为空');
    try {
      value = JSON.parse(text);
    } catch (e) {
      throw new TemplateError(`模板不是合法 JSON：${(e as Error).message}`);
    }
  }
  if (!Array.isArray(value)) {
    throw new TemplateError('模板必须是节点数组（Node-RED 的 flows.json 顶层是数组）');
  }

  const seen = new Set<string>();
  for (const [i, raw] of value.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TemplateError(`第 ${i + 1} 个元素不是节点对象`);
    }
    const node = raw as Record<string, unknown>;
    if (typeof node['id'] !== 'string' || node['id'] === '') {
      throw new TemplateError(`第 ${i + 1} 个节点缺少 id`);
    }
    if (typeof node['type'] !== 'string' || node['type'] === '') {
      throw new TemplateError(`节点 ${node['id']} 缺少 type`);
    }
    /*
     * id 重复必须当场拒绝。Node-RED 遇到重复 id 不会报错，它按后来居上覆盖 ——
     * 于是套用后少了几个节点，而界面上什么提示都没有。
     */
    if (seen.has(node['id'])) {
      throw new TemplateError(`节点 id 重复：${node['id']}（Node-RED 会静默覆盖，必须先修好）`);
    }
    seen.add(node['id']);
  }
  return value as FlowNode[];
}

/** 体检：节点数、标签页数、用到的类型 */
export function summarize(flows: FlowNode[]): TemplateSummary {
  const types = new Set<string>();
  let tabCount = 0;
  for (const n of flows) {
    types.add(n.type);
    if (n.type === 'tab') tabCount += 1;
  }
  return { nodeCount: flows.length, tabCount, nodeTypes: [...types].sort() };
}
