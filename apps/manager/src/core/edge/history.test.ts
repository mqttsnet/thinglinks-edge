import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { FieldRegistry } from './registry.ts';
import { ValueHistory, shouldStore, limitsFromEnv, DEFAULT_LIMITS } from './history.ts';

const L = { maxRows: 1000, minGapSec: 300 };

// ── 写入策略（纯函数，这里是最该测透的地方）──────────

test('值变了就存', () => {
  assert.equal(shouldStore({ value: '1', quality: 'good', histAt: '2026-01-01T00:00:00Z' },
    { value: '2', quality: 'good', at: '2026-01-01T00:00:01Z' }, L), true);
});

test('质量码变了也存 —— 值没变但从 good 掉到 bad 是关键事件', () => {
  assert.equal(shouldStore({ value: '1', quality: 'good', histAt: '2026-01-01T00:00:00Z' },
    { value: '1', quality: 'bad', at: '2026-01-01T00:00:01Z' }, L), true);
});

test('值没变且刚存过就跳过 —— 这条是省 SD 卡的全部意义', () => {
  assert.equal(shouldStore({ value: '1', quality: 'good', histAt: '2026-01-01T00:00:00Z' },
    { value: '1', quality: 'good', at: '2026-01-01T00:01:00Z' }, L), false);
});

test('值没变但超过 minGapSec 要留锚点', () => {
  // 不留的话，恒定信号在图上是一条从远古拉过来的直线，
  // 区分不了「一直没变」和「早就没数据了」
  assert.equal(shouldStore({ value: '1', quality: 'good', histAt: '2026-01-01T00:00:00Z' },
    { value: '1', quality: 'good', at: '2026-01-01T00:05:00Z' }, L), true);
});

test('从没存过历史的点位，第一条必存', () => {
  assert.equal(shouldStore({ value: '1', quality: 'good' },
    { value: '1', quality: 'good', at: '2026-01-01T00:00:00Z' }, L), true);
});

test('时间戳解析不出来时宁可存 —— 漏存丢信息，多存只占空间', () => {
  assert.equal(shouldStore({ value: '1', quality: 'good', histAt: 'not-a-date' },
    { value: '1', quality: 'good', at: '2026-01-01T00:00:00Z' }, L), true);
});

test('maxRows 为 0 表示关闭记录，什么都不存', () => {
  assert.equal(shouldStore({}, { value: '1', quality: 'good', at: '2026-01-01T00:00:00Z' },
    { maxRows: 0, minGapSec: 300 }), false);
});

// ── 存取与裁剪 ────────────────────────────────────

function bed(limits = L) {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO instance (id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret, notes)
     VALUES ('a','a','t',512,0.5,'/red/a/','s','')`,
  ).run();
  const history = new ValueHistory(db, limits);
  return { db, history, registry: new FieldRegistry(db, history) };
}

test('值变化时逐条入历史，取回来是时间正序', () => {
  const { registry, history } = bed();
  for (let i = 0; i < 5; i++) {
    registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: i,
      at: `2026-01-01T00:00:0${i}Z` }]);
  }
  const r = history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' });
  assert.deepEqual(r.points.map((p) => p.value), [0, 1, 2, 3, 4]);
  assert.equal(r.points[0]!.at, '2026-01-01T00:00:00Z');
  assert.equal(r.rows, 5);
});

test('值不变时不重复入库（同一秒内连报）', () => {
  const { registry, history } = bed();
  for (let i = 0; i < 20; i++) {
    registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: 42,
      at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` }]);
  }
  // 只有第一条落库，其余都被判为「没变且没超 minGapSec」
  assert.equal(history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' }).rows, 1);
});

test('当前值照常更新 —— 不存历史不等于不记当前值', () => {
  const { registry } = bed();
  registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: 1, at: '2026-01-01T00:00:00Z' }]);
  registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: 1, at: '2026-01-01T00:00:01Z' }]);
  const tag = registry.tags('a').find((t) => t.tagId === 't1')!;
  assert.equal(tag.lastValue, 1);
  assert.equal(tag.lastAt, '2026-01-01T00:00:01Z');
});

test('超上限从最旧的开始丢', () => {
  const { registry, history } = bed({ maxRows: 10, minGapSec: 0 });
  for (let i = 0; i < 30; i++) {
    registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: i,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }]);
  }
  history.prune(1);                       // 测试里立刻裁剪，不等攒批
  const r = history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' });
  assert.equal(r.rows, 10);
  // 留下的是最新的 10 条
  assert.deepEqual(r.points.map((p) => p.value), [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
});

test('series 回报最早时刻与容量 —— 界面要能说清「只有最近这些」', () => {
  const { registry, history } = bed({ maxRows: 5, minGapSec: 0 });
  for (let i = 0; i < 3; i++) {
    registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: i,
      at: `2026-01-01T00:00:0${i}Z` }]);
  }
  const r = history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' });
  assert.equal(r.oldest, '2026-01-01T00:00:00Z');
  assert.equal(r.maxRows, 5);
});

test('时间范围过滤', () => {
  const { registry, history } = bed({ maxRows: 100, minGapSec: 0 });
  for (let i = 0; i < 6; i++) {
    registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: i,
      at: `2026-01-01T00:00:0${i}Z` }]);
  }
  const r = history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1',
    since: '2026-01-01T00:00:02Z', until: '2026-01-01T00:00:04Z' });
  assert.deepEqual(r.points.map((p) => p.value), [2, 3, 4]);
});

test('limit 有硬上限，不会因为传个大数就把浏览器压垮', () => {
  const { registry, history } = bed({ maxRows: 100000, minGapSec: 0 });
  for (let i = 0; i < 20; i++) {
    registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: i,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }]);
  }
  assert.equal(history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1', limit: 5 })
    .points.length, 5);
  // 超上限的请求被夹到 5000，不报错
  assert.doesNotThrow(() =>
    history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1', limit: 999999 }));
});

test('关闭历史时一条都不写，但采集照常', () => {
  const { registry, history } = bed({ maxRows: 0, minGapSec: 300 });
  assert.equal(history.enabled, false);
  registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: 1 }]);
  assert.equal(history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' }).rows, 0);
  assert.equal(registry.tags('a').find((t) => t.tagId === 't1')?.lastValue, 1);
});

test('删实例时历史跟着走，不留孤儿', () => {
  const { db, registry, history } = bed({ maxRows: 100, minGapSec: 0 });
  registry.recordValues('a', [{ nodeId: 'n1', tagId: 't1', value: 1 }]);
  assert.equal(history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' }).rows, 1);
  db.prepare("DELETE FROM instance WHERE id = 'a'").run();
  assert.equal(history.series({ instanceId: 'a', nodeId: 'n1', tagId: 't1' }).rows, 0);
});

test('环境变量非法时回落默认值而不是让进程起不来', () => {
  assert.deepEqual(limitsFromEnv({}), DEFAULT_LIMITS);
  assert.equal(limitsFromEnv({ EDGE_HISTORY_MAX_ROWS: '-1' }).maxRows, DEFAULT_LIMITS.maxRows);
  assert.equal(limitsFromEnv({ EDGE_HISTORY_MAX_ROWS: 'abc' }).maxRows, DEFAULT_LIMITS.maxRows);
  assert.equal(limitsFromEnv({ EDGE_HISTORY_MAX_ROWS: '0' }).maxRows, 0);
  assert.equal(limitsFromEnv({ EDGE_HISTORY_MIN_GAP_SEC: '60' }).minGapSec, 60);
});
