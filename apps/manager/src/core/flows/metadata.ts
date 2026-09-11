import { TemplateError } from './types.ts';

const CATEGORIES = new Set(['industrial', 'network', 'building', 'power', 'custom']);
export interface TemplateMetadataInput { category?: unknown; protocols?: unknown }

/** Metadata is data, never an authority to turn user flows into a trusted builtin. */
export function normalizeTemplateMetadata(
  input: TemplateMetadataInput,
  current: TemplateMetadataInput = {},
): { category: string; protocols: string[] } {
  const category = input.category === undefined ? (current.category ?? 'custom') : input.category;
  if (typeof category !== 'string' || !CATEGORIES.has(category)) {
    throw new TemplateError('模板分类无效');
  }
  const protocols = input.protocols === undefined ? (current.protocols ?? []) : input.protocols;
  if (!Array.isArray(protocols) || protocols.length > 32
      || protocols.some((p) => typeof p !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(p))) {
    throw new TemplateError('协议标签必须是最多 32 项的协议编码数组');
  }
  return { category, protocols: [...new Set(protocols as string[])] };
}
