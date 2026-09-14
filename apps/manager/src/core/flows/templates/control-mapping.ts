import { TemplateError } from '../types.ts';
import { MAX_TEMPLATE_SERVICES, pointIdentity, resolveServiceCode, type ResolvedPoint } from './service-mapping.ts';

export interface ControlMapping {
  cmd: string;
  param: string;
  property: string;
  serviceCode?: string;
  targetServiceCode?: string;
}
export interface ResolvedControlMapping extends ControlMapping {
  serviceCode: string;
  targetServiceCode: string;
}

/** Commands and targets have separate service identities; blank fields use the documented defaults. */
export function resolveControlMappings(input: unknown, points: ResolvedPoint[], defaultService: unknown = ''): ResolvedControlMapping[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new TemplateError('启用设备控制时应配置 1–64 个命令映射');
  const seen = new Set<string>(), services = new Set(points.map(point => point.serviceCode));
  return input.map((mapping, index) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(mapping.cmd)
      || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(mapping.param)
      || ['__proto__', 'constructor', 'prototype'].some(value => value === mapping.param || value === mapping.cmd)) throw new TemplateError(`命令第 ${index + 1} 行：命令或参数编码格式无效`);
    const serviceCode = resolveServiceCode(mapping.serviceCode, defaultService);
    const targetServiceCode = resolveServiceCode(mapping.targetServiceCode, serviceCode);
    const identity = pointIdentity(serviceCode, mapping.cmd);
    if (seen.has(identity)) throw new TemplateError('同一服务内的同一命令只能配置一个单参数映射');
    seen.add(identity); services.add(serviceCode);
    if (services.size > MAX_TEMPLATE_SERVICES) throw new TemplateError(`采集与命令合计最多映射 ${MAX_TEMPLATE_SERVICES} 个服务`);
    const targets = points.filter(point => point.serviceCode === targetServiceCode && point.property === mapping.property);
    if (targets.length !== 1) throw new TemplateError(`命令第 ${index + 1} 行：控制映射必须选择已配置且唯一的服务点位`);
    if (targets[0]!.scale === 0) throw new TemplateError('控制点位倍率不能为 0');
    return { cmd: mapping.cmd, param: mapping.param, property: mapping.property, serviceCode, targetServiceCode };
  });
}
