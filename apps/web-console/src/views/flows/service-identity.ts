export const MAX_TEMPLATE_SERVICES = 32;
export const serviceText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const effectiveService = (value: unknown, fallback: unknown): string => serviceText(value) || serviceText(fallback);
export const validServiceCode = (value: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
export const servicePointKey = (serviceCode: string, property: string): string => JSON.stringify([serviceCode, property]);
