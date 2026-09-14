/** Only the visible page is rendered; all edits retain the complete parameter array. */
export const TABLE_PAGE_SIZE = 25;

export function tableRowLimit(schema: { max?: number }): number {
  return typeof schema.max === 'number' && Number.isSafeInteger(schema.max) && schema.max > 0 ? schema.max : 300;
}

export function paginateRows<T>(rows: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const start = (page - 1) * TABLE_PAGE_SIZE;
  const end = Math.min(start + TABLE_PAGE_SIZE, rows.length);
  return { page, pageCount, start, end, items: rows.slice(start, end).map((value, offset) => ({ value, index: start + offset })) };
}

export function updateTableCell(rows: Record<string, unknown>[], index: number, key: string, value: unknown): Record<string, unknown>[] {
  return rows.map((row, position) => position === index ? { ...row, [key]: value } : row);
}

export function deleteTableRow<T>(rows: T[], index: number): T[] {
  return rows.filter((_, position) => position !== index);
}

export function appendTableRow<T>(rows: T[], row: T, max: number): { rows: T[]; page: number } {
  const next = rows.length < max ? [...rows, row] : rows;
  return { rows: next, page: Math.max(1, Math.ceil(next.length / TABLE_PAGE_SIZE)) };
}
