<script setup lang="ts">
import { computed } from 'vue';
import { NPopover } from 'naive-ui';
import { formatFieldValue } from '../field-value';
const props = defineProps<{ value: unknown }>();
const reading = computed(() => formatFieldValue(props.value));
</script>

<template>
  <NPopover v-if="reading.approximate" trigger="click" placement="top">
    <template #trigger>
      <button type="button" class="approx-value num" :aria-label="`约 ${reading.display}，查看原始值`">≈ {{ reading.display }}</button>
    </template>
    <div class="raw-reading">
      <b>Manager 返回的原始值</b>
      <code>{{ reading.raw }}</code>
      <p>当前值仅简化浮点尾数显示，采集、历史和上报数据均未改变。</p>
    </div>
  </NPopover>
  <b v-else class="value num">{{ reading.display }}</b>
</template>

<style scoped>
.value, .approx-value { font-weight: 650; }
.approx-value { font: inherit; font-weight: 650; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted var(--muted); text-underline-offset: 4px; }
.approx-value:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.raw-reading { max-width: min(70vw, 400px); overflow-wrap: anywhere; }
.raw-reading code { display: block; margin-top: 6px; font-family: var(--mono); }
.raw-reading p { margin: 8px 0 0; color: var(--text-2); font-size: 12px; }
</style>
