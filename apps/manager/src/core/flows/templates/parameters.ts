import { TemplateError } from '../types.ts';
import type { TemplateParameter } from './types.ts';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TemplateError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function parameterDefaults(fields: TemplateParameter[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => [
      f.key,
      f.default !== undefined
        ? structuredClone(f.default)
        : f.type === 'table'
          ? []
          : f.type === 'boolean'
            ? false
            : f.type === 'number'
              ? null
              : '',
    ]),
  );
}

/** Validate at the recipe boundary, before values can become executable flow configuration. */
export function validateParameters(
  fields: TemplateParameter[],
  input: unknown,
  label = '参数',
): Record<string, unknown> {
  const values = record(input ?? {}, label);
  const allowed = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (UNSAFE_KEYS.has(key) || !allowed.has(key)) throw new TemplateError(`${label}包含未知字段：${key}`);
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const name = `${label} / ${field.label}`;
    const value = values[field.key] === undefined ? structuredClone(field.default) : values[field.key];
    if (value === undefined || (field.type === 'text' && value === '')) {
      if (field.required) throw new TemplateError(`${name}不能为空`);
      result[field.key] = value ?? (field.type === 'text' ? '' : undefined);
      continue;
    }
    switch (field.type) {
      case 'text': {
        if (typeof value !== 'string' || value.length > (field.max ?? 2048)) {
          throw new TemplateError(`${name}必须是长度不超过 ${field.max ?? 2048} 的文本`);
        }
        const text = value.trim();
        if (field.required && !text) throw new TemplateError(`${name}不能为空`);
        result[field.key] = text;
        break;
      }
      case 'number':
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max)
        ) {
          throw new TemplateError(`${name}必须是范围内的有效数字`);
        }
        result[field.key] = value;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') throw new TemplateError(`${name}必须为是或否`);
        result[field.key] = value;
        break;
      case 'select':
        if (!field.options?.some((o) => o.value === value)) throw new TemplateError(`${name}不是可选值`);
        result[field.key] = value;
        break;
      case 'table':
        if (!Array.isArray(value) || value.length < (field.min ?? 0) || value.length > (field.max ?? 64)) {
          throw new TemplateError(`${name}应有 ${field.min ?? 0}–${field.max ?? 64} 行`);
        }
        if (field.columns?.some((c) => c.type === 'table')) throw new TemplateError('不支持嵌套点位表');
        result[field.key] = value.map((row, i) =>
          validateParameters(field.columns ?? [], record(row, name), `${name}第 ${i + 1} 行`),
        );
        break;
    }
  }
  return result;
}
