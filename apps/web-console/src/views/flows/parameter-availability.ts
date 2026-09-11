import type { FlowTemplate, TemplateParameter } from '../../api/types.ts';
import { isBuiltin, parameterEditingAllowed, type TemplateConfigurationSource } from './template-model.ts';

/** Restrictions come from the current builtin catalogue, never from editable category/protocol tags. */
export function availabilityFields(template: FlowTemplate, catalogue: FlowTemplate[]): TemplateParameter[] {
  const sourceId = isBuiltin(template) ? template.id : template.derivedFrom?.templateId;
  const source = catalogue.find(item => item.id === sourceId && isBuiltin(item));
  const reasons = new Map(source?.parameters?.map(field => [field.key, field.disabledReason]));
  return (template.parameters ?? []).map(field => {
    const reason = reasons.get(field.key) ?? field.disabledReason;
    return reason ? { ...field, disabledReason: reason } : field;
  });
}
export function parameterDisabled(field: TemplateParameter, value: unknown, busy: boolean): boolean {
  if (busy) return true;
  if (!field.disabledReason) return false;
  return !(field.type === 'boolean' && field.default === false && value === true);
}
export function unavailableParameterIssues(fields: TemplateParameter[], values: Record<string, unknown>): string[] {
  return [...new Set(fields.filter(field => field.disabledReason && field.type === 'boolean'
    && field.default === false && values[field.key] === true).map(field => field.disabledReason!))];
}

/** Preserved snapshots keep their content, but still show current restrictions from their trusted source. */
export function snapshotControlWarnings(
  template: FlowTemplate, catalogue: FlowTemplate[], source: TemplateConfigurationSource,
): string[] {
  const sourceId = template.derivedFrom?.templateId;
  if (template.origin !== 'custom' || !sourceId || parameterEditingAllowed(template, source)) return [];
  const current = catalogue.find(item => item.id === sourceId
    && item.origin !== 'custom' && isBuiltin(item));
  const control = current?.parameters?.find(field => field.key === 'downlinkEnabled' && field.type === 'boolean');
  if (!control?.disabledReason || template.parameterValues?.downlinkEnabled === false) return [];
  return [control.disabledReason];
}
