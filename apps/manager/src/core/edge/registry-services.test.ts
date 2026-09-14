import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../db.ts';
import { FieldRegistry } from './registry.ts';
import { ValueHistory } from './history.ts';

const instance = (db: Database.Database) => db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
test('service-qualified same-name properties keep independent values, units and histories', () => {
  const db = openDb(':memory:'); instance(db);
  const history = new ValueHistory(db, { maxRows: 100, minGapSec: 300 }); const registry = new FieldRegistry(db, history);
  try {
    registry.upsertDevice('i', { nodeId: 'd', name: 'Device' });
    registry.upsertTag('i', { nodeId: 'd', serviceCode: 'A', tagId: 'temperature', unit: 'C' });
    registry.upsertTag('i', { nodeId: 'd', serviceCode: 'B', tagId: 'temperature', unit: 'K' });
    registry.recordValues('i', [
      { nodeId: 'd', serviceCode: 'A', tagId: 'temperature', value: 21, at: '2026-09-14T00:00:00Z' },
      { nodeId: 'd', serviceCode: 'B', tagId: 'temperature', value: 294, at: '2026-09-14T00:00:00Z' },
    ]);
    registry.recordValues('i', [{ nodeId: 'd', serviceCode: 'A', tagId: 'temperature', value: 22, at: '2026-09-14T00:01:00Z' }]);
    assert.deepEqual(registry.tags('i', 'd').map(p => [p.serviceCode, p.lastValue, p.unit]), [['A', 22, 'C'], ['B', 294, 'K']]);
    assert.equal(registry.tags('i', 'd', 'B').length, 1);
    assert.deepEqual(history.series({ instanceId: 'i', nodeId: 'd', serviceCode: 'A', tagId: 'temperature' }).points.map(p => p.value), [21, 22]);
    assert.deepEqual(history.series({ instanceId: 'i', nodeId: 'd', serviceCode: 'B', tagId: 'temperature' }).points.map(p => p.value), [294]);
    assert.deepEqual(history.series({ instanceId: 'i', nodeId: 'd', tagId: 'temperature' }).points, [], 'legacy query must not mix services');
  } finally { db.close(); }
});

test('v21 preserves legacy current values and history without guessing a service or changing history row order', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, 20); instance(db);
  db.prepare("INSERT INTO field_tag(instance_id,node_id,tag_id,name,last_value,quality,last_at,hist_at) VALUES('i','d','temperature','old','19','good','old-at','old-hist')").run();
  db.prepare("INSERT INTO field_value_history(instance_id,node_id,tag_id,at,value) VALUES('i','d','temperature','old-at','19')").run();
  const oldRow = db.prepare('SELECT rowid FROM field_value_history').get();
  try {
    assert.equal(migrate(db), 21);
    const registry = new FieldRegistry(db);
    assert.deepEqual(registry.tags('i', 'd', '').map(p => [p.serviceCode, p.lastValue, p.name]), [['', 19, 'old']]);
    assert.deepEqual(db.prepare('SELECT rowid FROM field_value_history').get(), oldRow);
    registry.recordValues('i', [{ nodeId: 'd', serviceCode: 'A', tagId: 'temperature', value: 22 }]);
    assert.equal(registry.tags('i', 'd').length, 2);
    assert.deepEqual(new ValueHistory(db).series({ instanceId: 'i', nodeId: 'd', tagId: 'temperature' }).points.map(p => p.value), [19]);
    db.prepare("DELETE FROM instance WHERE id='i'").run();
    assert.equal(registry.tags().length, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM field_value_history').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
