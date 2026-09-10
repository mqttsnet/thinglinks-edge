import { createHash } from 'node:crypto';
import type { NodeStore } from '../nodes/store.ts';
import type { NodeCatalog } from '../nodes/catalog.ts';
import { PROTOCOL_ARCHIVE_PINS } from './catalog.ts';
import type { NodeRequirement, ProtocolPackageFacts } from './types.ts';

/** Request-local memoization avoids reading the shared Modbus tarball twice. */
export function storedPackageFacts(store: NodeStore, catalog: NodeCatalog) {
  const memo = new Map<string, ProtocolPackageFacts>();
  return (requirement: NodeRequirement): ProtocolPackageFacts => {
    const key = `${requirement.module}@${requirement.version}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let bytes: Buffer | undefined;
    try { bytes = store.tarball(requirement.module, requirement.version); } catch { /* unreadable is unavailable */ }
    const pin = PROTOCOL_ARCHIVE_PINS.find((p) => p.module === requirement.module && p.version === requirement.version);
    const approval = catalog.get(requirement.module);
    const facts: ProtocolPackageFacts = {
      packagePresent: bytes !== undefined,
      integrityValid: !!bytes && !!pin
        && `sha512-${createHash('sha512').update(bytes).digest('base64')}` === pin.integrity,
      approval: !approval ? 'missing' : !approval.version ? 'unrestricted'
        : approval.version === requirement.version ? 'exact' : 'other',
    };
    memo.set(key, facts);
    return facts;
  };
}
