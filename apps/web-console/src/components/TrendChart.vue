<script setup lang="ts">
/**
 * 趋势曲线 —— 纯内联 SVG，不引图表库。
 *
 * 不用 ECharts 之类：离线安装是既定目标（见 12 号文 2.5 对图标库的同一判断），
 * 一个图表库 1MB 起步，而这里要画的只有折线、面积、悬停读数三件事。
 *
 * 三条硬规则：
 *   · **null 断线，绝不补 0** —— 实例停了是「没有数据」，不是「用量为 0」。
 *     补 0 画出来的是一条贴底的实线，看板上等于告诉运维「它活着，只是很闲」。
 *   · 颜色全走 token（--chart-*），深浅色都验过。
 *   · 没有数据时说清**为什么**没有，不留一张空白图让人猜是不是坏了。
 *
 * y 轴自适应而不是固定 0–100%：现场 CPU 常年个位数，钉死 100 的话曲线永远
 * 贴着底边，看不出任何变化；但给了下限（5%），免得 0.1% 的抖动被放大成惊涛骇浪。
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

export interface TrendSeries {
  key: string;
  name: string;
  /** CSS 颜色，一律传 token：var(--chart-1) */
  color: string;
  /** 与 timestamps 等长；null 表示该时刻没有数据 */
  values: (number | null)[];
}

const props = withDefaults(defineProps<{
  timestamps: number[];
  series: TrendSeries[];
  /** 单位后缀：'%' / 'MB' / 'ms' */
  unit?: string;
  height?: number;
  /** 紧凑模式：只画线，不要坐标轴与图例。用于实例卡片里的小图 */
  compact?: boolean;
  /** 没数据时的说明。要说清原因，不要写「暂无数据」 */
  emptyText?: string;
}>(), { unit: '', height: 210, compact: false, emptyText: '尚未采集到数据' });

const uid = useId().replace(/[^\w-]/g, '');

// ── 尺寸 ───────────────────────────────────────────────
const wrap = ref<HTMLElement | null>(null);
const width = ref(600);
let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w) width.value = Math.max(140, w);
  });
  if (wrap.value) ro.observe(wrap.value);
});
onBeforeUnmount(() => ro?.disconnect());

const pad = computed(() => (props.compact
  ? { l: 1, r: 1, t: 5, b: 3 }
  : { l: 46, r: 14, t: 10, b: 22 }));
const plotW = computed(() => Math.max(10, width.value - pad.value.l - pad.value.r));
const plotH = computed(() => Math.max(10, props.height - pad.value.t - pad.value.b));

// ── 刻度 ───────────────────────────────────────────────
/** 向上取整到 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 7.5 / 10 × 10ⁿ，让刻度是人能读的数 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= m * base) return m * base;
  return 10 * base;
}

const yMax = computed(() => {
  let max = 0;
  for (const s of props.series) {
    for (const v of s.values) if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  }
  const floor = props.unit === '%' ? 5 : props.unit === 'ms' ? 20 : 1;
  return Math.max(niceCeil(max * 1.15), floor);
});

const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => ({
  v: yMax.value * f,
  y: pad.value.t + plotH.value * (1 - f),
})));

/**
 * 精度按**这个数自己**的量级定，不按坐标轴上限定：
 * 按上限算的话，9.5% 的磁盘在 0–100 的轴上会被写成「10 %」，
 * 而旁边仪表盘上写的是 9.5 —— 同一个读数两个值，看板就不可信了。
 * 末尾多余的 0 由 Number() 抹掉，刻度上不会出现「25.0 %」。
 */
function fmt(v: number): string {
  const abs = Math.abs(v);
  const d = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${Number(v.toFixed(d))}${props.unit ? ` ${props.unit}` : ''}`;
}

/** 窗口不到一小时就精确到秒，否则只到分钟 —— 刻度写得比数据还细是误导 */
const withSeconds = computed(() => {
  const ts = props.timestamps;
  const first = ts[0];
  const last = ts[ts.length - 1];
  return first !== undefined && last !== undefined && last - first <= 3_600_000;
});
function clock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return withSeconds.value
    ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 坐标 ───────────────────────────────────────────────
const count = computed(() => props.timestamps.length);

/**
 * 有没有可画的点。只看时间戳不够：窗口里有时间轴、但这个实例一个读数都没有
 * （刚建的、或整段都停着）时，画出来是一副空坐标系 —— 看起来像图坏了。
 * 这种情况一律走空状态文案，明说「没采到」。
 */
const hasData = computed(() => props.series.some(
  (s) => s.values.some((v) => typeof v === 'number' && Number.isFinite(v)),
));
/** 画不出东西的两种情况合流：没有时间轴，或者时间轴上一个读数都没有 */
const blank = computed(() => count.value === 0 || !hasData.value);
function x(i: number): number {
  if (count.value <= 1) return pad.value.l + plotW.value / 2;
  return pad.value.l + (i / (count.value - 1)) * plotW.value;
}
function y(v: number): number {
  return pad.value.t + plotH.value * (1 - Math.min(v, yMax.value) / yMax.value);
}

/** 把一条序列切成若干连续段：null 处断开，而不是跨过去连一条直线 */
function segments(values: (number | null)[]): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) cur.push({ i, v });
    else if (cur.length) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

const shapes = computed(() => props.series.map((s) => {
  const segs = segments(s.values);
  const base = pad.value.t + plotH.value;
  return {
    key: s.key,
    color: s.color,
    // 单点段画不出线，退化成一个点，否则「只有一个采样点」会显示成空图
    dots: segs.filter((g) => g.length === 1).map((g) => ({ cx: x(g[0]!.i), cy: y(g[0]!.v) })),
    lines: segs.filter((g) => g.length > 1)
      .map((g) => g.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')),
    areas: segs.filter((g) => g.length > 1).map((g) => {
      const line = g.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
      return `${line} L${x(g[g.length - 1]!.i).toFixed(1)},${base} L${x(g[0]!.i).toFixed(1)},${base} Z`;
    }),
  };
}));

/** x 轴标签：最多 6 个，均匀取 */
const xLabels = computed(() => {
  const n = count.value;
  if (n === 0) return [];
  const want = Math.min(6, Math.max(2, Math.floor(plotW.value / 90)));
  const step = Math.max(1, Math.floor((n - 1) / (want - 1)) || 1);
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  // 末尾那个点一定要标上，但它离前一个标签太近时是替换、不是追加 ——
  // 追加会让两个时间叠在一起，糊成一团谁也读不出来
  const tail = idx[idx.length - 1] ?? 0;
  if (tail !== n - 1) {
    if (n - 1 - tail < step * 0.6) idx[idx.length - 1] = n - 1;
    else idx.push(n - 1);
  }
  return idx.map((i) => ({ i, x: x(i), text: clock(props.timestamps[i]!) }));
});

// ── 悬停读数 ────────────────────────────────────────────
const hover = ref<number | null>(null);
function onMove(e: MouseEvent) {
  const box = wrap.value?.getBoundingClientRect();
  // 空图不给悬停读数：一串「无数据」浮在「无历史数据」上面，只会更让人困惑
  if (!box || blank.value) return;
  const rel = (e.clientX - box.left - pad.value.l) / plotW.value;
  hover.value = Math.min(count.value - 1, Math.max(0, Math.round(rel * (count.value - 1))));
}
const hoverRows = computed(() => {
  const i = hover.value;
  if (i === null) return [];
  return props.series.map((s) => {
    const v = s.values[i];
    return {
      key: s.key, name: s.name, color: s.color,
      // 没数据就明说「无数据」，不要显示 0
      text: typeof v === 'number' && Number.isFinite(v) ? fmt(v) : '无数据',
    };
  });
});
/** 靠右时把提示翻到左边，免得被卡片裁掉 */
const tipStyle = computed(() => {
  const i = hover.value;
  if (i === null) return {};
  const px = x(i);
  const flip = px > width.value - 150;
  return { left: `${flip ? px - 12 : px + 12}px`, transform: flip ? 'translateX(-100%)' : 'none' };
});

/** 图例上带最后一个有效读数 —— 看板上最常被问的就是「现在多少」 */
function lastValue(s: TrendSeries): string {
  for (let i = s.values.length - 1; i >= 0; i -= 1) {
    const v = s.values[i];
    if (typeof v === 'number' && Number.isFinite(v)) return fmt(v);
  }
  return '无数据';
}
</script>

<template>
  <div class="root">
    <!-- 绘图区高度固定，图例走正常流排在下面：
         图例挤在固定高度里会溢出去盖住相邻内容（曾经就压在了下方的提示框上） -->
    <div ref="wrap" class="plot" :style="{ height: `${height}px` }"
         @mousemove="onMove" @mouseleave="hover = null">
      <div v-if="blank" class="empty">{{ emptyText }}</div>

      <svg v-else :width="width" :height="height" role="img"
           :aria-label="`趋势图：${series.map((s) => s.name).join('、')}`">
        <defs>
          <linearGradient v-for="s in series" :key="s.key" :id="`g-${uid}-${s.key}`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="s.color" stop-opacity=".26" />
            <stop offset="100%" :stop-color="s.color" stop-opacity="0" />
          </linearGradient>
        </defs>

        <template v-if="!compact">
          <g class="grid">
            <line v-for="t in ticks" :key="t.y" :x1="pad.l" :x2="pad.l + plotW" :y1="t.y" :y2="t.y" />
          </g>
          <g class="ylab">
            <text v-for="t in ticks" :key="`y${t.y}`" :x="pad.l - 8" :y="t.y + 3.5">{{ fmt(t.v) }}</text>
          </g>
          <g class="xlab">
            <text v-for="l in xLabels" :key="l.i" :x="l.x" :y="height - 6">{{ l.text }}</text>
          </g>
        </template>

        <g v-for="sh in shapes" :key="sh.key">
          <path v-for="(d, k) in sh.areas" :key="`a${k}`" :d="d" :fill="`url(#g-${uid}-${sh.key})`" />
          <path v-for="(d, k) in sh.lines" :key="`l${k}`" :d="d" fill="none" :stroke="sh.color"
                stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
          <circle v-for="(c, k) in sh.dots" :key="`d${k}`" :cx="c.cx" :cy="c.cy" r="2.4" :fill="sh.color" />
        </g>

        <g v-if="hover !== null" class="cross">
          <line :x1="x(hover)" :x2="x(hover)" :y1="pad.t" :y2="pad.t + plotH" />
          <template v-for="s in series" :key="s.key">
            <circle v-if="typeof s.values[hover] === 'number'"
                    :cx="x(hover)" :cy="y(s.values[hover] as number)" r="3.2"
                    :fill="s.color" stroke="var(--surface)" stroke-width="1.6" />
          </template>
        </g>
      </svg>

      <div v-if="hover !== null && !blank" class="tip" :style="tipStyle">
        <div class="tip-t mono">{{ clock(timestamps[hover]!) }}</div>
        <div v-for="r in hoverRows" :key="r.key" class="tip-r">
          <i :style="{ background: r.color }" /><span class="tip-n">{{ r.name }}</span>
          <b class="mono">{{ r.text }}</b>
        </div>
      </div>
    </div>

    <div v-if="!compact && !blank" class="legend">
      <span v-for="s in series" :key="s.key" class="lg">
        <i :style="{ background: s.color }" />{{ s.name }}
        <b class="mono">{{ lastValue(s) }}</b>
      </span>
    </div>
  </div>
</template>

<style scoped>
.root { width: 100%; }
.plot { position: relative; width: 100%; }
svg { display: block; overflow: visible; }
.empty {
  height: 100%; display: grid; place-items: center; text-align: center;
  color: var(--muted); font-size: 12.5px; line-height: 1.7; padding: 0 16px;
}
.grid line { stroke: var(--chart-grid); stroke-width: 1; }
.ylab text { fill: var(--chart-axis); font-size: 10.5px; text-anchor: end; font-variant-numeric: tabular-nums; }
.xlab text { fill: var(--chart-axis); font-size: 10.5px; text-anchor: middle; font-variant-numeric: tabular-nums; }
.cross line { stroke: var(--chart-axis); stroke-width: 1; stroke-dasharray: 3 3; opacity: .7; }

.tip {
  position: absolute; top: 6px; z-index: 3; pointer-events: none;
  background: var(--tip-bg); color: var(--tip-text); border-radius: var(--rs);
  padding: 7px 10px; font-size: 12px; line-height: 1.65; min-width: 116px;
  box-shadow: rgba(0, 0, 0, .22) 0 6px 18px -4px;
}
.tip-t { color: var(--tip-muted); font-size: 11px; margin-bottom: 2px; }
.tip-r { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.tip-n { color: var(--tip-muted); }
.tip-r b { margin-left: auto; font-weight: 600; }
.tip i, .legend i {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none;
}
.legend {
  display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 6px;
  font-size: 12px; color: var(--text-2);
}
.lg { display: inline-flex; align-items: center; gap: 6px; }
.lg b { color: var(--text); font-weight: 600; }
</style>
