<script setup lang="ts">
/**
 * 状态带 —— 一条横条回答「这段时间它是不是一直好的」。
 *
 * 看板上的绿色徽标只说明**此刻**正常。真正难查的是「半夜自己重启过一次、
 * 早上又好了」这类间歇故障：数字看板上什么都看不出，状态带上是一道明显的红痕。
 *
 * 相邻同状态合并成一段：既少画几百个格子，鼠标悬停时也能直接说出
 * 「03:12–03:25 异常」这样的区间，而不是逐点报时间。
 */
import { computed } from 'vue';

type Verdict = 'healthy' | 'degraded' | 'down';

const props = withDefaults(defineProps<{
  points: { t: number; verdict: Verdict | null }[];
  height?: number;
}>(), { height: 8 });

const TEXT: Record<Verdict, string> = { healthy: '正常', degraded: '降级', down: '异常' };
const COLOR: Record<Verdict, string> = {
  healthy: 'var(--success)', degraded: 'var(--warning)', down: 'var(--error)',
};

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const runs = computed(() => {
  const out: { verdict: Verdict | null; span: number; from: number; to: number }[] = [];
  for (const p of props.points) {
    const last = out[out.length - 1];
    if (last && last.verdict === p.verdict) { last.span += 1; last.to = p.t; }
    else out.push({ verdict: p.verdict, span: 1, from: p.t, to: p.t });
  }
  return out.map((r) => ({
    ...r,
    // 无数据画成描边色而不是灰绿之类，避免被读成一种「状态」
    color: r.verdict ? COLOR[r.verdict] : 'var(--border)',
    title: `${clock(r.from)}–${clock(r.to)} · ${r.verdict ? TEXT[r.verdict] : '无数据'}`,
  }));
});
</script>

<template>
  <div class="strip" :style="{ height: `${height}px` }" role="img" aria-label="状态时间带">
    <span v-for="(r, i) in runs" :key="i" :style="{ flexGrow: r.span, background: r.color }" :title="r.title" />
  </div>
</template>

<style scoped>
.strip {
  display: flex; gap: 1px; width: 100%; border-radius: 4px; overflow: hidden;
  background: var(--grey100);
}
.strip span { flex-basis: 0; min-width: 1px; }
</style>
