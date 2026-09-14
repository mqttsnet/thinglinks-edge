import { TemplateError } from '../types.ts';
import { MAX_TEMPLATE_POINTS } from './limits.ts';

export const MAX_TEMPLATE_SERVICES = 32;

export interface ResolvedPoint extends Record<string, unknown> {
  source: string;
  property: string;
  serviceCode: string;
}

/** Blank row values inherit the default. A missing final service is never guessed. */
export function resolveServiceCode(value: unknown, defaultService: unknown = ''): string {
  const serviceCode = String(value ?? '').trim() || String(defaultService ?? '').trim();
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(serviceCode) || ['__proto__', 'prototype', 'constructor'].includes(serviceCode)) {
    throw new TemplateError('服务编码不能为空，且只能包含字母、数字、下划线、点或短横线');
  }
  return serviceCode;
}

/** A structured key prevents collisions when service identifiers contain separators. */
export function pointIdentity(serviceCode: string, property: string): string {
  return JSON.stringify([serviceCode, property]);
}

export function resolvePoints(points: Record<string, unknown>[], defaultService: unknown = ''): ResolvedPoint[] {
  if (!points.length || points.length > MAX_TEMPLATE_POINTS) throw new TemplateError(`采集点位总数应为 1–${MAX_TEMPLATE_POINTS} 个`);
  const targets = new Set<string>(), services = new Set<string>();
  return points.map((point, index) => {
    try {
      const serviceCode = resolveServiceCode(point.serviceCode, defaultService);
      const property = String(point.property ?? '');
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(property) || ['__proto__', 'prototype', 'constructor'].includes(property)) {
        throw new TemplateError('物模型属性编码格式不合法');
      }
      const identity = pointIdentity(serviceCode, property);
      if (targets.has(identity)) throw new TemplateError(`物模型属性编码重复：${serviceCode}/${property}`);
      targets.add(identity); services.add(serviceCode);
      if (services.size > MAX_TEMPLATE_SERVICES) throw new TemplateError(`单个采集模板最多映射 ${MAX_TEMPLATE_SERVICES} 个服务`);
      return { ...point, source: String(point.source), property, serviceCode };
    } catch (error) {
      throw new TemplateError(`点位第 ${index + 1} 行：${(error as Error).message}`);
    }
  });
}

export interface RawPointRead { source: string; alias: string; dataType: unknown }

/** Native aliases are compile-time wiring, never Cloud property names or saved point addresses. */
export function rawPointMappings(points: ResolvedPoint[]): {
  reads: RawPointRead[];
  points: (ResolvedPoint & { rawAlias: string })[];
} {
  const reads: RawPointRead[] = [], bySource = new Map<string, RawPointRead>();
  const mapped = points.map(point => {
    const key = JSON.stringify([point.source, point.dataType]);
    let read = bySource.get(key);
    if (!read) {
      read = { source: point.source, alias: `raw_${reads.length}`, dataType: point.dataType };
      reads.push(read); bySource.set(key, read);
    }
    return { ...point, rawAlias: read.alias };
  });
  return { reads, points: mapped };
}
