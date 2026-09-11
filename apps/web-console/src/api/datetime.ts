/**
 * 后端时间戳的显示转换。
 *
 * 单独成文件是为了**能被单测直接 import**：`client.ts` 在模块顶层读 `window`，
 * 在 node 的测试环境里一导入就抛。
 */

/**
 * 把后端给的时间戳显示成本地时间。
 *
 * 后端有两种形态，**必须分开处理**：
 *
 *   1. `new Date().toISOString()` → `2026-08-28T01:31:26.000Z`，自带 Z，没有歧义
 *   2. SQLite 的 `datetime('now')` → `2026-08-27 17:31:26`，**是 UTC 但不带 Z**
 *
 * 第二种直接丢给 `new Date()` 会被按**本地时间**解析（V8 如此），
 * 于是一个 UTC 时刻被当成本地时刻显示 —— 东八区整整差 8 小时，
 * 「刚刚建的」会显示成八小时前。而且它不报错、格式也正常，
 * 只有拿真实时间对一下才看得出来。
 */
export function localTime(raw: string | null | undefined): string {
  if (!raw) return '—';
  // 没有时区标记的「日期 空格 时间」补上 Z：这种形态只可能来自 SQLite，存的是 UTC
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const d = new Date(normalized);
  // 解析不出来时原样回显，而不是显示 "Invalid Date" —— 原始值至少还有信息
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString('zh-CN', { hour12: false });
}
