/**
 * 流程模板的持久化（T4.6）。
 *
 * 只管存取。校验交给 ./parse.ts、体检交给 ./parse.ts 的 summarize、
 * 扫描交给 ./scan.ts —— 这里不重复实现任何一条规则，
 * 摘要随内容落库；读取时按当前扫描规则重算告警，不改写历史归档。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { parseFlows, summarize } from './parse.ts';
import { normalizeTemplateMetadata, type TemplateMetadataInput } from './metadata.ts';
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
  category: string;
  protocols: string;
  trusted_metadata: string;
}

type TrustedMetadata = Pick<FlowTemplate, 'requirements' | 'derivedFrom' | 'parameters' | 'parameterValues' | 'notes'>;

const SCAN_INCOMPLETE = '扫描未完成，请人工核对';

/** Read the archived JSON without transforming nodes or stripping fields. Never invent empty flows. */
function storedFlows(content: string): FlowNode[] {
  try {
    const value: unknown = JSON.parse(content);
    if (!Array.isArray(value) || value.some(node => !node || typeof node !== 'object' || Array.isArray(node)
      || typeof node.id !== 'string' || typeof node.type !== 'string')) throw new Error('invalid flow structure');
    return value as FlowNode[];
  } catch {
    throw new TemplateError(`模板内容无法读取；${SCAN_INCOMPLETE}`);
  }
}

/** Scanner upgrades affect the response only. Stored warnings remain historical evidence. */
function currentWarnings(row: Row, content?: FlowNode[]): string[] {
  try {
    return scanInlineSecrets(content ?? storedFlows(row.content));
  } catch {
    let previous: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.warnings);
      if (Array.isArray(parsed)) previous = parsed.filter((item): item is string => typeof item === 'string');
    } catch { /* A broken historical cache must still produce an explicit incomplete warning. */ }
    return previous.includes(SCAN_INCOMPLETE) ? previous : [...previous, SCAN_INCOMPLETE];
  }
}

const toMeta = (r: Row, content?: FlowNode[]): FlowTemplate => ({
  id: r.id,
  name: r.name,
  description: r.description,
  nodeCount: r.node_count,
  tabCount: r.tab_count,
  nodeTypes: r.node_types === '' ? [] : r.node_types.split(','),
  source: r.source,
  warnings: currentWarnings(r, content),
  createdBy: r.created_by,
  createdAt: r.created_at,
  origin: 'custom',
  category: r.category,
  protocols: JSON.parse(r.protocols) as string[],
  ...JSON.parse(r.trusted_metadata) as TrustedMetadata,
});

export class TemplateRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 保存。校验与体检都在写库之前完成，不留半份坏模板 */
  save(input: SaveTemplateInput, actor: string): FlowTemplate {
    return this.#save(input, actor, {});
  }

  /** Called only with a server-rendered builtin; HTTP never accepts dependency claims from a body. */
  saveConfiguredBuiltin(
    template: FlowTemplateWithContent,
    input: { name: string; description?: string; category?: string; protocols?: string[] },
    actor: string,
  ): FlowTemplate {
    if (template.origin !== 'builtin' || !template.revision || !template.requirements?.length) {
      throw new TemplateError('配置副本需要有效的内置模板及组件依赖');
    }
    return this.#save({
      ...input, content: template.flows, source: template.id,
      category: input.category ?? template.category ?? 'custom',
      protocols: input.protocols ?? template.protocols ?? [],
    }, actor, {
      requirements: template.requirements,
      derivedFrom: { templateId: template.id, revision: template.revision },
      ...(template.parameterValues ? { parameterValues: template.parameterValues } : {}),
      ...(template.parameters ? { parameters: template.parameters } : {}),
      ...(template.notes ? { notes: template.notes } : {}),
    });
  }

  #save(input: SaveTemplateInput, actor: string, trusted: TrustedMetadata): FlowTemplate {
    const name = input.name.trim();
    if (name === '') throw new TemplateError('模板名称不能为空');
    if (name.length > 64) throw new TemplateError('模板名称过长（上限 64 字）');

    const metadata = normalizeTemplateMetadata(input);
    const flows = parseFlows(input.content);
    const s = summarize(flows);
    const warnings = scanInlineSecrets(flows);
    const id = randomUUID();

    this.#db.prepare(`
      INSERT INTO flow_template
        (id, name, description, content, node_count, tab_count, node_types, source, warnings, created_by, category, protocols, trusted_metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, (input.description ?? '').trim(), JSON.stringify(flows),
      s.nodeCount, s.tabCount, s.nodeTypes.join(','),
      (input.source ?? 'upload').trim(), JSON.stringify(warnings), actor,
      metadata.category, JSON.stringify(metadata.protocols), JSON.stringify(trusted),
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
    return rows.map(row => toMeta(row));
  }

  get(id: string): FlowTemplate | undefined {
    const r = this.#db.prepare('SELECT * FROM flow_template WHERE id = ?').get(id) as Row | undefined;
    return r ? toMeta(r) : undefined;
  }

  /** 取含内容的完整模板，用于套用与下载 */
  getWithContent(id: string): FlowTemplateWithContent | undefined {
    const r = this.#db.prepare('SELECT * FROM flow_template WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    const flows = storedFlows(r.content);
    return { ...toMeta(r, flows), flows };
  }

  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM flow_template WHERE id = ?').run(id).changes > 0;
  }

  rename(id: string, name: string, description: string, metadata: TemplateMetadataInput = {}): FlowTemplate | undefined {
    const trimmed = name.trim();
    // 两条限制要跟 save 完全一致：只在新建时拦、改名时放行，
    // 等于把规则变成「建完再改一次就能绕过」
    if (trimmed === '') throw new TemplateError('模板名称不能为空');
    if (trimmed.length > 64) throw new TemplateError('模板名称过长（上限 64 字）');
    const existing = this.get(id);
    const normalized = normalizeTemplateMetadata(metadata, existing);
    this.#db
      .prepare('UPDATE flow_template SET name = ?, description = ?, category = ?, protocols = ? WHERE id = ?')
      .run(trimmed, description.trim(), normalized.category, JSON.stringify(normalized.protocols), id);
    return this.get(id);
  }
}
