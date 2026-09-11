<script setup lang="ts">
import { NInput, NSelect } from 'naive-ui';
import { categoryOptions } from '../template-model';
import type { TemplateFilters } from '../template-model';
const props = defineProps<{ value: TemplateFilters; protocols: { label: string; value: string }[] }>();
const emit = defineEmits<{ 'update:value': [value: TemplateFilters] }>();
const sources = [{ label: '全部来源', value: '' }, { label: '内置模板', value: 'builtin' }, { label: '我的模板', value: 'custom' }];
const categories = [{ label: '全部分类', value: '' }, ...categoryOptions];
function update(key: keyof TemplateFilters, value: string | null) { emit('update:value', { ...props.value, [key]: value ?? '' }); }
</script>

<template>
  <div class="filters">
    <NInput :value="value.search" placeholder="搜索名称、说明、协议" clearable :input-props="{ 'aria-label': '搜索模板' }" @update:value="update('search', $event)" />
    <NSelect :value="value.source" :options="sources" aria-label="按来源筛选" @update:value="update('source', $event)" />
    <NSelect :value="value.category" :options="categories" aria-label="按分类筛选" @update:value="update('category', $event)" />
    <NSelect :value="value.protocol || null" :options="protocols" placeholder="全部协议" clearable filterable aria-label="按协议筛选" @update:value="update('protocol', $event)" />
  </div>
</template>

<style scoped>
.filters { display: grid; grid-template-columns: minmax(240px, 2fr) repeat(3, minmax(120px, 1fr)); gap: 12px; margin: 20px 0; }
@media (max-width: 1000px) { .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .filters { grid-template-columns: 1fr; } }
</style>
