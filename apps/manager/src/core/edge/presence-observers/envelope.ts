import { PresenceObserverError, assertObserverId, assertObserverCounter, type PresenceEnvelope } from './types.ts';
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function invalid(): never { throw new PresenceObserverError('INVALID_PRESENCE_ENVELOPE', '采集观察封套格式无效', 400); }
function pointCount(value: unknown): number {
  if (!object(value)) invalid();
  const keys = Object.keys(value);
  if (!keys.length || keys.length > 1000 || keys.some(key => !key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid();
  return keys.length;
}

/** Explicit version marker; callers must never send the wrapper into telemetry storage or the Cloud batch. */
export function parsePresenceEnvelope(value: unknown): PresenceEnvelope | undefined {
  if (!object(value) || !Object.hasOwn(value, '__tlePresence')) return undefined;
  const meta = value.__tlePresence;
  if (!object(meta) || meta.version !== 1 || !['sample', 'status'].includes(String(meta.kind))) invalid();
  const allowed = ['version', 'observerId', 'runNonce', 'generation', 'sequence', 'kind', ...(meta.kind === 'status' ? ['online'] : ['report'])];
  if (Object.keys(meta).some(key => !allowed.includes(key))) invalid();
  assertObserverId(meta.observerId); assertObserverId(meta.runNonce);
  assertObserverCounter(meta.generation); assertObserverCounter(meta.sequence);
  if (meta.kind === 'sample') {
    if (meta.report !== undefined && typeof meta.report !== 'boolean') invalid();
    if (Object.hasOwn(value, 'services')) {
      if (Object.keys(value).some(key => !['__tlePresence', 'services'].includes(key)) || !Array.isArray(value.services)
        || !value.services.length || value.services.length > 32) invalid();
      const seen = new Set<string>(); let total = 0;
      for (const service of value.services) {
        if (!object(service) || Object.keys(service).some(key => !['serviceCode', 'values'].includes(key))) invalid();
        assertObserverId(service.serviceCode);
        if (seen.has(service.serviceCode) || ['__proto__', 'constructor', 'prototype'].includes(service.serviceCode)) invalid();
        seen.add(service.serviceCode); total += pointCount(service.values);
      }
      if (total > 300) invalid();
    } else {
      if (Object.keys(value).some(key => !['__tlePresence', 'values'].includes(key))) invalid();
      pointCount(value.values);
    }
  } else if (Object.keys(value).some(key => key !== '__tlePresence') || meta.online !== false) invalid();
  return structuredClone(value) as PresenceEnvelope;
}
