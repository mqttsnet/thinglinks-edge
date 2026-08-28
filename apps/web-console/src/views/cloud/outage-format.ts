/**
 * 断网记录与补传进度的展示格式化。
 *
 * 抽成纯函数是因为这里全是**容易算错又不会报错**的东西：秒转成人读的时长、
 * 「补传中」和「已完成」的措辞、eta 没有时该说什么。算错了界面照常渲染，
 * 只是显示的内容是错的 —— 正是该被单测钉住的那类逻辑。
 */
import type { OutageRecord, ReplayProgress } from '../../api/types.ts';

/** 秒转人读时长。**不省略单位**：现场看「3」不知道是 3 秒还是 3 分钟 */
export function humanDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export interface OutageView {
  text: string;
  tone: 'success' | 'warning' | 'error' | 'default';
}

/**
 * 一条断网记录的一句话结论。
 *
 * `dropped > 0` 一律标红并**排在最前** —— 丢数据是这张表里唯一
 * 需要人立刻处理的事，压在时长后面会被略过。
 */
export function summarizeOutage(o: OutageRecord): OutageView {
  if (o.dropped > 0) {
    return {
      text: `丢弃 ${o.dropped} 条 · 断网 ${humanDuration(o.outageSec)}`,
      tone: 'error',
    };
  }
  if (o.status === 'ongoing') {
    return { text: `断网中 · 已积压 ${o.peakPending} 条`, tone: 'error' };
  }
  if (o.status === 'restoring') {
    return { text: `已连上，补传中 · 积压过 ${o.peakPending} 条`, tone: 'warning' };
  }
  return {
    text: `断网 ${humanDuration(o.outageSec)} · 补传 ${humanDuration(o.recoverySec)} · `
      + `${o.replayed} 条已补回`,
    tone: 'success',
  };
}

/**
 * 补传进度的一句话。
 *
 * 没有 eta 时**照原样说出原因**，不要替换成「计算中」之类的模糊措辞 ——
 * 「链路未恢复」和「还没有补传样本」对现场是完全不同的两件事。
 */
export function summarizeReplay(r: ReplayProgress | null): string {
  if (!r) return '补传状态不可用';
  if (r.pending === 0) return '没有待补传数据';
  if (r.etaSec === null) return `待补传 ${r.pending} 条 · ${r.reason}`;
  return `待补传 ${r.pending} 条 · ${r.ratePerSec} 条/秒 · 预计还需 ${humanDuration(r.etaSec)}`;
}
