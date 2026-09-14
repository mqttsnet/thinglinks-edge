import type { CloudProductModel, TemplateParameter } from '../../api/types.ts';
import { effectiveService, servicePointKey, validServiceCode, MAX_TEMPLATE_SERVICES } from './service-identity.ts';
export type ModelFieldOption = { label: string; value: string };
export type ModelOptionResolver = (key: string, table?: string, row?: Record<string, unknown>) => ModelFieldOption[];
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
const named = (code: string, name?: string, datatype?: string): ModelFieldOption => ({
  value: code, label: [name && name !== code ? `${name}（${code}）` : code, datatype].filter(Boolean).join(' · '),
});

/** All suggestions are additive. The configured values are never cleared or replaced. */
export function modelFieldOptions(
  key: string, values: Record<string, unknown>, model: CloudProductModel | null,
  table?: string, row: Record<string, unknown> = {},
): ModelFieldOption[] {
  const services = model?.services ?? [];
  const code = effectiveService(row.serviceCode, values.serviceCode);
  const service = services.find((item) => item.serviceCode === code);
  if (key === 'serviceCode' || table === 'commands' && key === 'targetServiceCode') return services.map((item) => named(item.serviceCode, item.serviceName));
  if (table === 'points' && key === 'property') return (service?.properties ?? []).map((item) => named(item.propertyCode, item.propertyName, item.datatype));
  if (table !== 'commands') return [];
  if (key === 'cmd') return (service?.commands ?? []).map((item) => named(item.commandCode, item.commandName));
  if (key === 'param') return (service?.commands?.find((item) => item.commandCode === row.cmd)?.requests ?? [])
    .map((item) => named(item.parameterCode, item.parameterName, [item.datatype,
      [true, 1, 'true', '1'].includes(item.required ?? '') ? '必填' : '',
      item.min !== undefined && item.min !== '' ? `最小 ${item.min}` : '',
      item.max !== undefined && item.max !== '' ? `最大 ${item.max}` : '',
    ].filter(Boolean).join(' · ')));
  if (key === 'property') {
    const targetCode = effectiveService(row.targetServiceCode, code);
    const target = services.find(item => item.serviceCode === targetCode);
    return [...new Set(rows(values.points).filter(point => effectiveService(point.serviceCode, values.serviceCode) === targetCode)
      .map((point) => text(point.property)).filter(Boolean))]
      .map((property) => named(property, target?.properties?.find((item) => item.propertyCode === property)?.propertyName));
  }
  return [];
}

/** Warnings describe only a comparison with the selected product model, never runtime verification. */
export function mappingIssues(values: Record<string, unknown>, model: CloudProductModel | null): string[] {
  const issues: string[] = [];
  const points = rows(values.points);
  const groups = new Set<string>(), identities = new Set<string>();
  for (const [index, point] of points.entries()) {
    const property = text(point.property), code = effectiveService(point.serviceCode, values.serviceCode);
    if (!code) { issues.push(`点位 ${index + 1} 尚未选择服务，请填写行内服务或默认服务。`); continue; }
    if (!validServiceCode(code)) { issues.push(`点位 ${index + 1} 的服务编码格式无效。`); continue; }
    groups.add(code);
    const identity = servicePointKey(code, property);
    if (property && identities.has(identity)) issues.push(`点位 ${index + 1} 的 ${code} / ${property} 重复。`);
    identities.add(identity);
    const service = model?.services?.find(item => item.serviceCode === code);
    if (model && !service) issues.push(`点位 ${index + 1} 的服务 ${code} 未在本次物模型中找到。`);
    else if (model && property && !service?.properties?.some((item) => item.propertyCode === property)) issues.push(`点位 ${index + 1} 的属性 ${property} 未在服务 ${code} 中找到。`);
  }
  if (values.downlinkEnabled === true) for (const [index, row] of rows(values.commands).entries()) {
    const cmd = text(row.cmd), param = text(row.param), property = text(row.property);
    const code = effectiveService(row.serviceCode, values.serviceCode), targetCode = effectiveService(row.targetServiceCode, code);
    if (!code) { issues.push(`命令映射 ${index + 1} 尚未选择命令所属服务。`); continue; }
    if (!validServiceCode(code) || !validServiceCode(targetCode)) { issues.push(`命令映射 ${index + 1} 的命令或目标服务编码格式无效。`); continue; }
    groups.add(code);
    const service = model?.services?.find(item => item.serviceCode === code);
    const command = service?.commands?.find((item) => item.commandCode === cmd);
    if (model && !service) issues.push(`命令映射 ${index + 1} 的服务 ${code} 未在本次物模型中找到。`);
    else if (model && cmd && !command) issues.push(`命令映射 ${index + 1} 的命令 ${cmd} 未在服务 ${code} 中找到。`);
    else if (model && param && !command?.requests?.some((item) => item.parameterCode === param)) issues.push(`命令映射 ${index + 1} 的参数 ${param} 不属于服务 ${code} 的命令 ${cmd}。`);
    if (property && !identities.has(servicePointKey(targetCode, property))) issues.push(`命令映射 ${index + 1} 的目标 ${targetCode} / ${property} 没有对应采集点位。`);
  }
  if (groups.size > MAX_TEMPLATE_SERVICES) issues.push(`当前配置涉及 ${groups.size} 个服务，最多 ${MAX_TEMPLATE_SERVICES} 个；请拆分为多个流程。`);
  return issues;
}

const groupLabels = { device: '设备与采集', cloud: 'ThingLinks 云端映射', points: '采集点位', commands: '云端控制', advanced: '高级配置' };
export function parameterGroups(fields: TemplateParameter[], values: Record<string, unknown>) {
  return (['device', 'cloud', 'points', 'commands', 'advanced'] as const).map((id) => ({
    id, label: groupLabels[id], fields: fields.filter((field) => (field.group ?? 'device') === id
      && (!field.visibleWhen || values[field.visibleWhen.key] === field.visibleWhen.value)),
  })).filter((group) => group.fields.length);
}
export function modelQueryIdentity(values: Record<string, unknown>): string {
  const product = text(values.productIdentification);
  return product ? JSON.stringify([product, text(values.versionNo)]) : '';
}

/** Naive UI AutoComplete commits option.label, so keep the stored label as the cloud code. */
export function autocompleteChoices(options: ModelFieldOption[]) {
  return options.map(option => ({ value: option.value, label: option.value, displayLabel: option.label }));
}
