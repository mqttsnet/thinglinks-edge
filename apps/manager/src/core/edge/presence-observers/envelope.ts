import { PresenceObserverError, assertObserverId, assertObserverCounter, type PresenceEnvelope } from './types.ts';
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function invalid(): never { throw new PresenceObserverError('INVALID_PRESENCE_ENVELOPE', '采集观察封套格式无效', 400); }

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
    if (Object.keys(value).some(key => !['__tlePresence', 'values'].includes(key)) || !object(value.values)) invalid();
    const keys = Object.keys(value.values);
    if (!keys.length || keys.length > 1000 || keys.some(key => !key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid();
  } else if (Object.keys(value).some(key => key !== '__tlePresence') || meta.online !== false) invalid();
  return structuredClone(value) as PresenceEnvelope;
}
