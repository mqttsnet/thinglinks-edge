export interface ObserverScope { instanceId: string; nodeId: string; observerId: string }
export interface ObserverAggregate { instanceId: string; nodeId: string; state: boolean | undefined }
export interface ObserverEventBase { runNonce: string; generation: number; sequence: number }
export type ObserverEvent = ObserverEventBase & ({ kind: 'sample'; report?: boolean } | { kind: 'status'; online: false });
export interface ObserverAcceptance { accepted: boolean; reason?: 'stale' | 'duplicate'; state: boolean | undefined; freshData: boolean }
export interface ObserverChallenge { ticket: string; expectedRevision: number; expiresAt: number }
export interface ObserverActivation { observerId: string; runNonce: string; generation: number; nextSequence: number; leaseExpiresAt: number }
export type PresenceEnvelope = {
  __tlePresence: ObserverEventBase & { version: 1; observerId: string; kind: 'sample'; report?: boolean };
  values: Record<string, unknown>;
} | {
  __tlePresence: ObserverEventBase & { version: 1; observerId: string; kind: 'sample'; report?: boolean };
  services: { serviceCode: string; values: Record<string, unknown> }[];
} | {
  __tlePresence: ObserverEventBase & { version: 1; observerId: string; kind: 'status'; online: false };
};

export class PresenceObserverError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.name = 'PresenceObserverError'; this.code = code; this.status = status; }
}
export function assertObserverId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new PresenceObserverError('INVALID_OBSERVER_ID', '采集观察者标识无效', 400);
  }
}
export function assertObserverCounter(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PresenceObserverError('INVALID_OBSERVER_SEQUENCE', '采集观察代次或序列无效', 400);
  }
}
