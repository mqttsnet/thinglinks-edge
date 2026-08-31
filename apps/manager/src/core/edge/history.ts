/**
 * 点位历史 —— 断网期间现场也要能看趋势。
 *
 * 起因很具体：断网时最想看的恰恰是「刚才那半小时到底发生了什么」，而在此之前
 * 平台只存 `field_tag.last_value`（当前值），一断网就只剩一个孤零零的数。
 * spool 里确实压着数据，但它是只写只补传的顺序日志，查不了。
 *
 * ## 两条硬约束决定了这个模块的全部设计
 *
 * 1. **SD 卡写入量**。现场盒子多数跑在 SD 卡或廉价 eMMC 上，写放大直接折寿。
 *    所以「每来一个值就存一条」是不能接受的默认行为 —— 见 {@link shouldStore}。
 * 2. **磁盘容量**。按条数封顶而不是按天数，理由写在 db.ts 的 v11 迁移里：
 *    同样保留 7 天，10 个点位和 500 个点位差两个数量级，只有条数可预期。
 *
 * ## 明确不做的
 *
 * 不做降采样、不做聚合、不做压缩编码。那是时序库的活，而这里的定位是
 * 「现场排障时能翻回去看一眼」，不是历史数据仓库 —— 真要长期存储与分析，
 * 数据本来就该上云，那条路已经通了（微批 + 断网续传）。
 * 在边缘再造半个时序库，是拿最不该复杂的地方去承担最不必要的复杂度。
 */
import type { Db } from '../db.ts';

export interface HistoryLimits {
  /**
   * 全库历史条数上限，超出后从最旧的开始丢。
   * 0 表示**关闭历史记录**（不是不限，是不记）—— 极低配设备可以这样。
   */
  maxRows: number;
  /**
   * 值没变时，最长多久也要留一个采样点（秒）。
   *
   * 为什么不是「值没变就永远不存」：那样一条恒定信号在图上会是一条从远古
   * 拉到现在的直线，看不出「这段时间它确实还在上报」。留个锚点才能区分
   * 「一直没变」和「早就没数据了」——现场判断设备死活靠的就是这个区别。
   */
  minGapSec: number;
}

export const DEFAULT_LIMITS: HistoryLimits = {
  // 每条约 100 字节（含索引），50 万条约 50 MB —— 边缘盒子扛得住的量级
  maxRows: 500_000,
  minGapSec: 300,
};

/** 上一条已存历史的快照，用来判断这次要不要落盘 */
export interface PrevSample {
  /** 上次记录的值（JSON 串），从未记过为 undefined */
  value?: string | undefined;
  quality?: string | undefined;
  /** 上次**存进历史**的时刻；只更新过当前值、没存过历史时为 undefined */
  histAt?: string | undefined;
}

/**
 * 要不要把这个采样点存进历史。
 *
 * 纯函数，没有 IO —— 这条策略是整个模块里最该被测透的部分，
 * 而它一旦要连着数据库才能测，就会变成没人愿意补用例的地方。
 *
 * 存的条件只有两个，满足其一即存：
 *   · **值或质量码变了** —— 变化才是信息
 *   · **距上次存历史超过 minGapSec** —— 给恒定信号留锚点，见 minGapSec 的说明
 */
export function shouldStore(
  prev: PrevSample, next: { value: string; quality: string; at: string },
  limits: HistoryLimits = DEFAULT_LIMITS,
): boolean {
  if (limits.maxRows <= 0) return false;
  if (prev.value !== next.value || prev.quality !== next.quality) return true;
  if (!prev.histAt) return true;
  const gapMs = Date.parse(next.at) - Date.parse(prev.histAt);
  // 时间解析不出来时宁可存 —— 漏存是丢信息，多存只是多占一点空间
  if (Number.isNaN(gapMs)) return true;
  return gapMs >= limits.minGapSec * 1000;
}

export interface SeriesPoint {
  at: string;
  value: unknown;
  quality: string;
}

export interface SeriesResult {
  points: SeriesPoint[];
  /** 全库最早一条的时刻。界面据此说明「只有最近这些数据」，不让人以为看到的是全部 */
  oldest: string | null;
  /** 当前总条数与上限，让人看得见「还能存多久」 */
  rows: number;
  maxRows: number;
}

export class ValueHistory {
  #db: Db;
  #limits: HistoryLimits;
  /** 距上次清理写了多少条。攒够一批才清一次，不必每条都算 */
  #sincePrune = 0;

  constructor(db: Db, limits: HistoryLimits = DEFAULT_LIMITS) {
    this.#db = db;
    this.#limits = limits;
  }

  get enabled(): boolean {
    return this.#limits.maxRows > 0;
  }

  get limits(): HistoryLimits {
    return this.#limits;
  }

  /**
   * 追加一条。调用方**必须**先用 shouldStore 判断过 ——
   * 这里不重复判断是为了让「读上一条」只发生一次（调用方本来就要读）。
   */
  append(
    instanceId: string, nodeId: string, tagId: string,
    p: { at: string; value: string; quality: string },
  ): void {
    if (!this.enabled) return;
    this.#db.prepare(
      `INSERT INTO field_value_history (instance_id, node_id, tag_id, at, value, quality)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(instanceId, nodeId, tagId, p.at, p.value, p.quality);
    this.#sincePrune += 1;
  }

  /**
   * 超量裁剪，丢最旧的。
   *
   * 按 rowid 删而不是按 `at`：rowid 就是插入顺序，天然有序且不需要额外索引，
   * 而 `at` 是调用方给的，可能乱序（补传的数据带的是采集时刻）。
   * 这里要的是「丢掉最早写进来的」，rowid 正好是这个语义。
   *
   * 攒够 `every` 条才真的执行一次 —— 每条都算一次 COUNT(*) 是纯浪费。
   */
  prune(every = 1000): number {
    if (!this.enabled) return 0;
    if (this.#sincePrune < every) return 0;
    this.#sincePrune = 0;

    const { n } = this.#db.prepare('SELECT COUNT(*) AS n FROM field_value_history')
      .get() as { n: number };
    const excess = n - this.#limits.maxRows;
    if (excess <= 0) return 0;
    const info = this.#db.prepare(
      `DELETE FROM field_value_history WHERE rowid IN (
         SELECT rowid FROM field_value_history ORDER BY rowid LIMIT ?
       )`,
    ).run(excess);
    return info.changes;
  }

  /**
   * 取一个点位的一段历史，**时间正序**（画图直接用，不必再排）。
   *
   * `limit` 是硬上限：一次给出上万个点，浏览器画不动、传输也慢，
   * 而现场看趋势并不需要那个分辨率。
   */
  series(
    q: { instanceId: string; nodeId: string; tagId: string;
         since?: string | undefined; until?: string | undefined; limit?: number },
  ): SeriesResult {
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
    const rows = this.#db.prepare(
      `SELECT at, value, quality FROM field_value_history
        WHERE instance_id = ? AND node_id = ? AND tag_id = ?
          AND (? IS NULL OR at >= ?) AND (? IS NULL OR at <= ?)
        ORDER BY at DESC LIMIT ?`,
    ).all(
      q.instanceId, q.nodeId, q.tagId,
      q.since ?? null, q.since ?? null,
      q.until ?? null, q.until ?? null,
      limit,
    ) as Array<{ at: string; value: string | null; quality: string }>;

    const points = rows.reverse().map((r) => ({
      at: r.at,
      // 存进去时是 JSON，取出来还原；坏数据不该让整段查询失败
      value: ((): unknown => {
        try { return r.value === null ? null : JSON.parse(r.value); } catch { return r.value; }
      })(),
      quality: r.quality,
    }));

    const stat = this.#db.prepare(
      'SELECT COUNT(*) AS n, MIN(at) AS oldest FROM field_value_history',
    ).get() as { n: number; oldest: string | null };

    return { points, oldest: stat.oldest, rows: stat.n, maxRows: this.#limits.maxRows };
  }
}

/** 从环境变量读限额。给的值非法时用默认值并留一条警告，而不是让进程起不来 */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): HistoryLimits {
  const num = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0) {
      console.warn(`[warn] ${name}=${raw} 非法（要非负整数），按默认值 ${fallback} 处理`);
      return fallback;
    }
    return v;
  };
  return {
    maxRows: num(env['EDGE_HISTORY_MAX_ROWS'], DEFAULT_LIMITS.maxRows, 'EDGE_HISTORY_MAX_ROWS'),
    minGapSec: num(env['EDGE_HISTORY_MIN_GAP_SEC'], DEFAULT_LIMITS.minGapSec, 'EDGE_HISTORY_MIN_GAP_SEC'),
  };
}
