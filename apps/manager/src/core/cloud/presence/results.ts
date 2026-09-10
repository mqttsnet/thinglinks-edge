type Item = Record<string, unknown>;
const object = (value: unknown): Item | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Item : undefined;

/** Never infer per-device success from the envelope status. Reject ambiguous or unexpected identifiers. */
export function matchingResults(value: unknown, requested: string[]): Map<string, Item> {
  const body = object(value);
  if (body?.['statusCode'] !== 0 || !Array.isArray(body['data'])) throw new Error('云端拓扑响应失败或缺少逐设备结果');
  const wanted = new Set(requested);
  const found = new Map<string, Item>();
  const duplicates = new Set<string>();
  for (const raw of body['data']) {
    const item = object(raw);
    const id = item?.['deviceId'];
    if (typeof id !== 'string' || !wanted.has(id)) throw new Error('云端拓扑响应包含请求范围外的设备');
    if (found.has(id)) duplicates.add(id);
    found.set(id, item!);
  }
  for (const id of duplicates) found.delete(id);
  // Missing/duplicate/failed records remain unconfirmed; independently valid items can progress.
  return found;
}

export function ownedDevices(value: unknown, requested: string[], gatewayId: string): Set<string> {
  const owned = new Set<string>();
  for (const [id, item] of matchingResults(value, requested)) {
    const info = object(item['deviceInfo']);
    if (item['statusCode'] === 0 && info?.['nodeType'] === 2 && info['gatewayId'] === gatewayId) owned.add(id);
  }
  return owned;
}

export function successfulDevices(value: unknown, requested: string[]): Set<string> {
  return new Set([...matchingResults(value, requested)].filter(([, item]) => item['statusCode'] === 0).map(([id]) => id));
}
