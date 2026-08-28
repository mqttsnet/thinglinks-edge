/**
 * 流程模板的持久化（T4.6）。
 *
 * 只管存取。校验交给 ./parse.ts、体检交给 ./parse.ts 的 summarize、
 * 扫描交给 ./scan.ts —— 这里不重复实现任何一条规则，
 * 只负责把它们的结果一起落库，让列表页不必每次都重新算一遍。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { parseFlows, summarize } from './parse.ts';
import { scanInlineSecrets } from './scan.ts';
import {
  TemplateError,
  type FlowNode, type FlowTemplate, type FlowTemplateWithContent, type SaveTemplateInput,
} from './types.ts';

interface Row {
  id: string;
  name: string;
  description: string;
  content: string;
  node_count: number;
  tab_count: number;
  node_types: string;
  source: string;
  warnings: string;
  created_by: string;
  created_at: string;
}

const toMeta = (r: Row): FlowTemplate => ({
  id: r.id,
  name: r.name,
  description: r.description,
  nodeCount: r.node_count,
  tabCount: r.tab_count,
  nodeTypes: r.node_types === '' ? [] : r.node_types.split(','),
  source: r.source,
  warnings: JSON.parse(r.warnings) as string[],
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export class TemplateRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 保存。校验与体检都在写库之前完成，不留半份坏模板 */
  save(input: SaveTemplateInput, actor: string): FlowTemplate {
    const name = input.name.trim();
    if (name === '') throw new TemplateError('模板名称不能为空');
    if (name.length > 64) throw new TemplateError('模板名称过长（上限 64 字）');

    const flows = parseFlows(input.content);
    const s = summarize(flows);
    const warnings = scanInlineSecrets(flows);
    const id = randomUUID();

    this.#db.prepare(`
      INSERT INTO flow_template
        (id, name, description, content, node_count, tab_count, node_types, source, warnings, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, (input.description ?? '').trim(), JSON.stringify(flows),
      s.nodeCount, s.tabCount, s.nodeTypes.join(','),
      (input.source ?? 'upload').trim(), JSON.stringify(warnings), actor,
    );

    const saved = this.get(id);
    if (!saved) throw new TemplateError('保存后读不回模板，数据库异常');
    return saved;
  }

  /** 列表。**不带 content** —— 一个模板可能几百 KB，列表页不需要它 */
  list(): FlowTemplate[] {
    const rows = this.#db
      .prepare('SELECT * FROM flow_template ORDER BY created_at DESC, id')
      .all() as Row[];
    return rows.map(toMeta);
  }

  get(id: string): FlowTemplate | undefined {
    const r = this.#db.prepare('SELECT * FROM flow_template WHERE id = ?').get(id) as Row | undefined;
    return r ? toMeta(r) : undefined;
  }

  /** 取含内容的完整模板，用于套用与下载 */
  getWithContent(id: string): FlowTemplateWithContent | undefined {
    const r = this.#db.prepare('SELECT * FROM flow_template WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    return { ...toMeta(r), flows: JSON.parse(r.content) as FlowNode[] };
  }

  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM flow_template WHERE id = ?').run(id).changes > 0;
  }

  rename(id: string, name: string, description: string): FlowTemplate | undefined {
    const trimmed = name.trim();
    // 两条限制要跟 save 完全一致：只在新建时拦、改名时放行，
    // 等于把规则变成「建完再改一次就能绕过」
    if (trimmed === '') throw new TemplateError('模板名称不能为空');
    if (trimmed.length > 64) throw new TemplateError('模板名称过长（上限 64 字）');
    this.#db
      .prepare('UPDATE flow_template SET name = ?, description = ? WHERE id = ?')
      .run(trimmed, description.trim(), id);
    return this.get(id);
  }
}
