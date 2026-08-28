/**
 * 流程模板的共享类型与错误（T4.6）。
 *
 * 单独成文件，让 parse / scan / compat / repo 四个模块互不依赖 ——
 * 它们各自只 import 这里，改其中一个不会牵动另外三个。
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Node-RED 节点对象。除 id/type 外一律透传，不做结构假设 */
export interface FlowNode {
  id: string;
  type: string;
  z?: string;
  label?: string;
  name?: string;
  [k: string]: unknown;
}

export interface TemplateSummary {
  nodeCount: number;
  /** 标签页数量，等于「几张流程图」 */
  tabCount: number;
  /** 去重后的节点类型，排序后便于比对 */
  nodeTypes: string[];
}

export interface FlowTemplate extends TemplateSummary {
  id: string;
  name: string;
  description: string;
  source: string;
  warnings: string[];
  createdBy: string;
  createdAt: string;
}

/** 含内容的完整模板。列表接口不回这个字段 —— 一个模板可能好几百 KB */
export interface FlowTemplateWithContent extends FlowTemplate {
  flows: FlowNode[];
}

export interface SaveTemplateInput {
  name: string;
  description?: string;
  /** flows 原文或已解析的数组 */
  content: unknown;
  /** 来源实例 id；从上传的文件建模板时填 'upload' */
  source?: string;
}
