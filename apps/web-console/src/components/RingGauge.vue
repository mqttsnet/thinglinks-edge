<script setup lang="ts">
/**
 * 环形仪表 —— 宿主资源的「现在怎么样」。
 *
 * 用环而不是进度条：三项资源并排时，环的填充角度比三根等长横条更容易
 * 一眼比出高低；条形留给「相对配额」这种有明确上限的量。
 *
 * 读不到值时画成空环并显示「—」，不画 0% —— 读不到和用了 0% 是两回事。
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  percent: number | null;
  label: string;
  /** 环下方的绝对量，例如 `6192 / 7936 MB` */
  detail: string;
  size?: number;
}>(), { size: 104 });

const R = computed(() => props.size / 2 - 7);
const C = computed(() => 2 * Math.PI * R.value);
const shown = computed(() => (props.percent === null ? 0 : Math.min(Math.max(props.percent, 0), 100)));

// 阈值与看板其它位置一致：70% 起警示、90% 起告警
const color = computed(() => {
  if (props.percent === null) return 'var(--border)';
  if (props.percent >= 90) return 'var(--error)';
  if (props.percent >= 70) return 'var(--warning)';
  return 'var(--success)';
});
</script>

<template>
  <div class="gauge">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" role="img"
         :aria-label="`${label} ${percent === null ? '读不到' : `${percent}%`}`">
      <g :transform="`rotate(-90 ${size / 2} ${size / 2})`">
        <circle :cx="size / 2" :cy="size / 2" :r="R" fill="none" stroke="var(--grey100)" stroke-width="8" />
        <circle v-if="percent !== null" :cx="size / 2" :cy="size / 2" :r="R" fill="none"
                :stroke="color" stroke-width="8" stroke-linecap="round"
                :stroke-dasharray="`${(shown / 100) * C} ${C}`" />
      </g>
      <text class="v num" :x="size / 2" :y="size / 2 + 2">{{ percent === null ? '—' : percent }}</text>
      <text v-if="percent !== null" class="pct" :x="size / 2" :y="size / 2 + 17">%</text>
    </svg>
    <div class="lb">{{ label }}</div>
    <div class="dt num">{{ detail }}</div>
  </div>
</template>

<style scoped>
.gauge { display: flex; flex-direction: column; align-items: center; gap: 2px; }
svg { display: block; }
.v { fill: var(--text); font-size: 21px; font-weight: 650; text-anchor: middle; }
.pct { fill: var(--muted); font-size: 10.5px; text-anchor: middle; }
.lb { font-size: 12.5px; color: var(--text-2); margin-top: 4px; }
.dt { font-size: 11.5px; color: var(--muted); }
</style>
