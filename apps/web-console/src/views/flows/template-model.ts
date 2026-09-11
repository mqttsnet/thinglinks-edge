import type { ApplyPreview, FlowTemplate, TemplateApplyOptions, TemplateDeployMode, TemplateParameter } from '../../api/types.ts';

export const categoryOptions = [
  { label: '工业采集', value: 'industrial' }, { label: '网络设备', value: 'network' },
  { label: '楼宇自动化', value: 'building' }, { label: '电力规约', value: 'power' },
  { label: '自定义', value: 'custom' },
];
export function categoryLabel(category?: string): string {
  return categoryOptions.find((item) => item.value === (category ?? 'custom'))?.label ?? category ?? '自定义';
}
export function isBuiltin(template: FlowTemplate): boolean {
  return template.origin === 'builtin' || template.id.startsWith('builtin:');
}
export interface TemplateFilters { source: string; category: string; protocol: string; search: string }
export function filterTemplates(templates: FlowTemplate[], filters: TemplateFilters): FlowTemplate[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return templates.filter((template) =>
    (!filters.source || (isBuiltin(template) ? 'builtin' : 'custom') === filters.source)
    && (!filters.category || (template.category ?? 'custom') === filters.category)
    && (!filters.protocol || template.protocols?.includes(filters.protocol))
    && (!query || [template.name, template.description, ...(template.protocols ?? [])]
      .join(' ').toLocaleLowerCase().includes(query)));
}

/** Defaults are copied so editing one point never mutates catalogue metadata or the next dialog. */
export function initialParameters(fields: TemplateParameter[] = []): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.key,
    field.default !== undefined ? JSON.parse(JSON.stringify(field.default))
      : field.type === 'table' ? [] : field.type === 'boolean' ? false
        : field.type === 'number' || field.type === 'select' ? null : '',
  ]));
}
export const newTableRow = initialParameters;

export function previewAllowsDeploy(
  template: FlowTemplate, preview: ApplyPreview | null, requestedMode: TemplateDeployMode = 'replace',
): boolean {
  if (!preview || preview.deployable === false || preview.dependencyIssues?.length) return false;
  // An older server ignores unknown request fields and replaces flows. Never mistake that for append.
  if (requestedMode === 'append' && preview.mode !== 'append') return false;
  if (preview.mode && preview.mode !== requestedMode) return false;
  if (isBuiltin(template) || template.requirements?.length) return preview.deployable === true && preview.compat.checked && preview.compat.ok;
  return true;
}

/** A parameter/target/mode change also invalidates responses which are still in flight. */
export function createPreviewGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    invalidate: () => { generation++; },
    current: (ticket: number) => ticket === generation,
  };
}


/** Only server-owned builtin definitions and trusted configured copies can expose editable parameters. */
export function configurableTemplate(template: FlowTemplate): boolean {
  if (template.origin === 'builtin' || template.origin === undefined && template.id.startsWith('builtin:')) return true;
  return template.origin === 'custom' && Boolean(template.derivedFrom?.templateId.startsWith('builtin:')
    && template.derivedFrom.revision && template.parameters?.length && template.parameterValues
    && typeof template.parameterValues === 'object' && !Array.isArray(template.parameterValues));
}
export function templateParameters(template: FlowTemplate): Record<string, unknown> {
  if (!configurableTemplate(template)) return {};
  const values = initialParameters(template.parameters);
  for (const field of template.parameters ?? []) {
    const saved = template.parameterValues?.[field.key];
    if (saved !== undefined) values[field.key] = JSON.parse(JSON.stringify(saved));
  }
  return values;
}
export function sourceBuiltinId(template: FlowTemplate): string | undefined {
  if (!configurableTemplate(template)) return undefined;
  return isBuiltin(template) ? template.id : template.derivedFrom?.templateId;
}
export type TemplateConfigurationSource = 'parameters' | 'snapshot';
export function configurableCopy(template: FlowTemplate): boolean {
  return template.origin === 'custom' && configurableTemplate(template);
}
export function parameterEditingAllowed(template: FlowTemplate, source: TemplateConfigurationSource): boolean {
  return configurableTemplate(template) && (!configurableCopy(template) || source === 'parameters');
}
export function effectiveTemplateParameters(
  template: FlowTemplate, edited: Record<string, unknown>, source: TemplateConfigurationSource,
): Record<string, unknown> {
  return configurableCopy(template) && source === 'snapshot' ? templateParameters(template) : edited;
}
export function templateApplyOptions(
  template: FlowTemplate, mode: TemplateDeployMode, parameters: Record<string, unknown>, expectedRevision?: string,
  source: TemplateConfigurationSource = 'parameters',
): TemplateApplyOptions {
  return { mode, ...(parameterEditingAllowed(template, source) ? { parameters } : {}), ...(expectedRevision ? { expectedRevision } : {}) };
}
export function deploymentFeedback(preview: ApplyPreview, eligible: boolean, applying: boolean) {
  if (applying) return { type: 'info' as const, text: '正在部署，请稍候' };
  if (!eligible) return { type: 'warning' as const, text: '部署条件尚未满足' };
  return preview.compat.checked && preview.compat.ok
    ? { type: 'success' as const, text: '部署检查通过' }
    : { type: 'warning' as const, text: '可继续部署，请核对以下提示' };
}
