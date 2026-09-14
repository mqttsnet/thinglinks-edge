import type { FieldTagRecord } from '../../api/types.ts';
import { paginateRows } from '../flows/components/table-pagination.ts';
export const fieldServiceLabel = (serviceCode: string): string => serviceCode || '旧记录（服务未记录）';
export const fieldTagKey = (tag: Pick<FieldTagRecord, 'instanceId' | 'nodeId' | 'serviceCode' | 'tagId'>): string =>
  JSON.stringify([tag.instanceId, tag.nodeId, tag.serviceCode || '', tag.tagId]);
export function fieldServiceOptions(tags: FieldTagRecord[]) {
  const counts = new Map<string, number>();
  for (const tag of tags) counts.set(tag.serviceCode || '', (counts.get(tag.serviceCode || '') ?? 0) + 1);
  return [{ label: `全部服务（${tags.length} 个点位）`, value: '*' },
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, label: `${fieldServiceLabel(value)}（${count}）` }))];
}
export function fieldTagPage(tags: FieldTagRecord[], serviceCode: string, page: number) {
  const filtered = tags.filter(tag => serviceCode === '*' || (tag.serviceCode || '') === serviceCode)
    .sort((a, b) => (a.serviceCode || '').localeCompare(b.serviceCode || '') || a.tagId.localeCompare(b.tagId));
  return { ...paginateRows(filtered, page), total: filtered.length };
}
