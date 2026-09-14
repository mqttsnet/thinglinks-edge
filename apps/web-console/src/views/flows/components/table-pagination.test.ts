import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendTableRow, deleteTableRow, paginateRows, tableRowLimit, updateTableCell } from './table-pagination.ts';

const points = () => Array.from({ length: 300 }, (_, index) => ({ property: `point_${index + 1}`, source: String(index) }));

test('300 rows are shown in bounded pages with absolute row identities', () => {
  const rows = points();
  const first = paginateRows(rows, 1), middle = paginateRows(rows, 7), last = paginateRows(rows, 12);
  assert.equal(first.items.length, 25); assert.equal(first.pageCount, 12);
  assert.equal(middle.items[0]?.index, 150); assert.equal(middle.items[0]?.value, rows[150]);
  assert.equal(last.items.at(-1)?.index, 299); assert.equal(last.end, 300);
  assert.equal(paginateRows(rows, 99).page, 12);
  assert.equal(paginateRows(rows, -1).page, 1);
  assert.deepEqual(paginateRows([], 12).items, []);
});

test('editing or deleting on later pages preserves every other row and the original collection', () => {
  const rows = points(), index = paginateRows(rows, 12).items[0]!.index;
  const updated = updateTableCell(rows, index, 'source', '999');
  assert.equal(updated.length, 300); assert.equal(updated[275]?.source, '999');
  assert.equal(rows[275]?.source, '275');
  assert.equal(updated[0], rows[0]); assert.equal(updated[299], rows[299]);
  const deleted = deleteTableRow(updated, index);
  assert.equal(deleted.length, 299); assert.equal(deleted[275]?.property, 'point_277');
  assert.equal(rows.length, 300);
  assert.equal(paginateRows(deleted.slice(0, 275), 12).page, 11);
});

test('adding a row locates the new final page and stops at the schema row limit', () => {
  const rows = points().slice(0, 25);
  const result = appendTableRow(rows, { property: 'new', source: '25' }, 300);
  assert.equal(result.rows.length, 26); assert.equal(result.page, 2);
  assert.equal(paginateRows(result.rows, result.page).items[0]?.value.property, 'new');
  assert.equal(appendTableRow(points(), { property: 'overflow', source: '300' }, 300).rows.length, 300);
  assert.equal(tableRowLimit({ max: 8 }), 8); assert.equal(tableRowLimit({ max: 300 }), 300);
});
