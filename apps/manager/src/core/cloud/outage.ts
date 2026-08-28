/**
 * 断网记录（08 号文第 8 节）。
 *
 * 现场问「昨晚断了多久、丢没丢、补完没有」时，光靠当前状态答不上来 ——
 * 那时候链路早恢复了，指标也归零了。所以每次断网留一条，**跨重启留存**。
 *
 * **一次断网有三个时刻，不是两个**：
 *
 *   断开 ──────► 链路恢复 ──────► 积压补完
 *        断网时长          补传耗时
 *
 * 中间那段是「连上了但还在追欠账」，现场最关心的恰恰是它 ——
 * 只记断开和恢复，会让人以为一恢复就没事了，而积压可能还要补半小时。
 *
 * 记录由链路状态变化驱动，不轮询：`begin` 在掉线时调，`restore` 在连上时调，
 * `finish` 在积压清零时调。三者都幂等，重复调用不会串出多余记录。
 */
import type { Db } from '../db.ts';

export type OutageStatus = 'ongoing' | 'restoring' | 'done';

export interface OutageRecord {
  id: number;
  /** 掉线时刻 */
  startedAt: string;
  /** 链路恢复时刻；仍在断网中时为 null */
  restoredAt: string | null;
  /** 积压补完时刻；还在补传时为 null */
  drainedAt: string | null;
  /** 断网时长（秒）。仍在断网中时为 null */
  outageSec: number | null;
  /** 补传耗时（秒）。还没补完时为 null */
  recoverySec: number | null;
  /** 断网期间积压的峰值条数 —— 「影响范围」看这个 */
  peakPending: number;
  /** 期间落进缓存的批次数 */
  spooled: number;
  /** 恢复后补传出去的批次数 */
  replayed: number;
  /** 期间因缓存写满被丢弃的条数。**非 0 就是真丢了数据** */
  dropped: number;
  status: OutageStatus;
  note: string;
}

interface Row {
  id: number;
  started_at: string;
  restored_at: string | null;
  drained_at: string | null;
  peak_pending: number;
  spooled: number;
  replayed: number;
  dropped: number;
  status: OutageStatus;
  note: string;
}

const secBetween = (a: string | null, b: string | null): number | null =>
  (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);

const toRecord = (r: Row): OutageRecord => ({
  id: r.id,
  startedAt: r.started_at,
  restoredAt: r.restored_at,
  drainedAt: r.drained_at,
  outageSec: secBetween(r.started_at, r.restored_at),
  recoverySec: secBetween(r.restored_at, r.drained_at),
  peakPending: r.peak_pending,
  spooled: r.spooled,
  replayed: r.replayed,
  dropped: r.dropped,
  status: r.status,
  note: r.note,
});

export class OutageLog {
  #db: Db;
  #now: () => string;

  /** `now` 可注入，测试里要构造确定的时长 */
  constructor(db: Db, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  /** 当前未结束的那条（ongoing 或 restoring）；没有则 undefined */
  open(): OutageRecord | undefined {
    const r = this.#db.prepare(
      "SELECT * FROM cloud_outage WHERE status != 'done' ORDER BY id DESC LIMIT 1",
    ).get() as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  /**
   * 掉线。已有未结束记录时**不新开一条** —— 连接抖动会在几秒内
   * 掉线重连好几次，每次都开一条会把列表刷成噪音，真正那次长断网反而被淹掉。
   */
  begin(note = ''): OutageRecord {
    const existing = this.open();
    if (existing) return existing;
    const at = this.#now();
    const info = this.#db.prepare(
      'INSERT INTO cloud_outage (started_at, status, note) VALUES (?, ?, ?)',
    ).run(at, 'ongoing', note);
    return this.#byId(Number(info.lastInsertRowid))!;
  }

  /**
   * 链路恢复。此时**断网结束但补传才刚开始**，所以状态进入 restoring 而不是 done。
   * 没有未结束记录时什么也不做 —— 首次启动就连上属于正常，不该凭空造一条。
   */
  restore(): OutageRecord | undefined {
    const cur = this.open();
    if (!cur || cur.status !== 'ongoing') return cur;
    this.#db.prepare("UPDATE cloud_outage SET restored_at = ?, status = 'restoring' WHERE id = ?")
      .run(this.#now(), cur.id);
    return this.#byId(cur.id);
  }

  /**
   * 积压补完，整条记录到此结束。
   *
   * 只在 restoring 状态下生效：还没恢复就说「补完了」是自相矛盾的，
   * 那种状态多半是调用方搞错了顺序，宁可不动也不要写出一条读不懂的记录。
   */
  finish(): OutageRecord | undefined {
    const cur = this.open();
    if (!cur || cur.status !== 'restoring') return cur;
    this.#db.prepare("UPDATE cloud_outage SET drained_at = ?, status = 'done' WHERE id = ?")
      .run(this.#now(), cur.id);
    return this.#byId(cur.id);
  }

  /** 更新积压峰值。取最大值而不是覆盖 —— 峰值才代表影响范围 */
  observePending(pending: number): void {
    const cur = this.open();
    if (!cur) return;
    if (pending <= cur.peakPending) return;
    this.#db.prepare('UPDATE cloud_outage SET peak_pending = ? WHERE id = ?').run(pending, cur.id);
  }

  /** 累加计数。字段名受限于枚举，避免把列名拼进 SQL */
  bump(field: 'spooled' | 'replayed' | 'dropped', n = 1): void {
    const cur = this.open();
    if (!cur || n <= 0) return;
    const col = { spooled: 'spooled', replayed: 'replayed', dropped: 'dropped' }[field];
    this.#db.prepare(`UPDATE cloud_outage SET ${col} = ${col} + ? WHERE id = ?`).run(n, cur.id);
  }

  /** 最近若干条，最新在前。控制台「最近断网记录」直接用它 */
  recent(limit = 20): OutageRecord[] {
    const rows = this.#db.prepare(
      'SELECT * FROM cloud_outage ORDER BY id DESC LIMIT ?',
    ).all(Math.min(Math.max(limit, 1), 200)) as Row[];
    return rows.map(toRecord);
  }

  /**
   * 进程重启时的收尾。
   *
   * 重启前那条未结束的记录，其 `restoring` 状态在内存里的补传进度已经没了。
   * 不能就这么挂着 —— 它会一直显示「补传中」而实际上没人在补。
   * 标注一下并交回给正常流程：链路一连上就会重新触发补传，
   * 积压清零时照常 finish。
   */
  adoptAfterRestart(): OutageRecord | undefined {
    const cur = this.open();
    if (!cur) return undefined;
    const note = cur.note === '' ? 'Manager 在此期间重启过' : `${cur.note}；Manager 在此期间重启过`;
    this.#db.prepare('UPDATE cloud_outage SET note = ? WHERE id = ?').run(note, cur.id);
    return this.#byId(cur.id);
  }

  #byId(id: number): OutageRecord | undefined {
    const r = this.#db.prepare('SELECT * FROM cloud_outage WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }
}
