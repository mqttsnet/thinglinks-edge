<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NFormItem, NPagination, NTag } from 'naive-ui';
import type { TemplateParameter } from '../../../api/types';
import type { ModelOptionResolver } from '../cloud-model';
import { newTableRow } from '../template-model';
import ParameterScalar from './ParameterScalar.vue';
import { appendTableRow, deleteTableRow, paginateRows, tableRowLimit, updateTableCell } from './table-pagination';
import { effectiveService } from '../service-identity';
const props = defineProps<{ field: TemplateParameter; value: unknown; defaultService?: string; disabled?: boolean; optionsFor?: ModelOptionResolver | undefined }>();
const isCommand = computed(() => props.field.group === 'commands' || props.field.key === 'commands');
const rowLabel = computed(() => isCommand.value ? '命令映射' : '点位');
const emit = defineEmits<{ 'update:value': [value: Record<string, unknown>[]] }>();
const rows = computed<Record<string, unknown>[]>(() => Array.isArray(props.value) ? props.value : []);
const page = ref(1);
const rowLimit = computed(() => tableRowLimit(props.field));
const visible = computed(() => paginateRows(rows.value, page.value));
watch(() => rows.value.length, () => { page.value = visible.value.page; });
watch(() => props.field.key, () => { page.value = 1; });
function update(index: number, key: string, value: unknown) {
  if (!props.disabled) emit('update:value', updateTableCell(rows.value, index, key, value));
}
function add() {
  if (props.disabled) return;
  const next = appendTableRow(rows.value, newTableRow(props.field.columns), rowLimit.value);
  emit('update:value', next.rows); page.value = next.page;
}
function remove(index: number) {
  if (!props.disabled) emit('update:value', deleteTableRow(rows.value, index));
}
</script>

<template>
  <div class="table-field">
    <NEmpty v-if="rows.length === 0" size="small" :description="isCommand ? '还没有命令映射；添加后选择云端命令和设备目标点位' : '还没有点位，添加后填写采集地址与物模型属性'" />
    <div v-for="{ value: row, index } in visible.items" :key="index" class="point-row">
      <div class="row-title">
        <b>{{ rowLabel }} {{ index + 1 }}</b>
        <NTag v-if="field.columns?.some(column => column.key === 'serviceCode')" size="small" :bordered="false">{{ effectiveService(row.serviceCode, defaultService) || '尚未选择服务' }}</NTag>
        <NButton size="tiny" :disabled="disabled" type="error" secondary
          :aria-label="`删除${field.label}第 ${index + 1} 行`" @click="remove(index)">删除</NButton>
      </div>
      <div class="point-columns">
        <NFormItem v-for="column in field.columns" :key="column.key" :label="column.label"
          :required="column.required ?? false" class="point-cell">
          <div class="cell-input">
            <ParameterScalar :field="column" :value="row[column.key]" :disabled="disabled"
              :label="`${field.label}第 ${index + 1} 行 ${column.label}`"
              :suggestions="optionsFor?.(column.key, field.key, row) ?? []"
              @update:value="update(index, column.key, $event)" />
            <small v-if="column.disabledReason" class="hint">{{ column.disabledReason }}</small>
            <small v-else-if="column.description" class="hint">{{ column.description }}</small>
          </div>
        </NFormItem>
      </div>
    </div>
    <div v-if="visible.pageCount > 1" class="table-pagination">
      <span class="hint">第 {{ visible.start + 1 }}–{{ visible.end }} 个，共 {{ rows.length }} 个</span>
      <NPagination v-model:page="page" :page-count="visible.pageCount" :page-slot="5" size="small" :aria-label="`${field.label}分页`" />
    </div>
    <NButton size="small" :disabled="disabled || rows.length >= rowLimit" @click="add">添加{{ rowLabel }}</NButton>
    <span class="hint count">{{ rows.length }} / {{ rowLimit }} 个</span>
  </div>
</template>

<style scoped>
.table-field, .cell-input { width: 100%; min-width: 0; }
.point-row { padding: 12px; border: 1px solid var(--border); border-radius: var(--rs); margin-bottom: 12px; }
.row-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.point-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.point-cell { margin-bottom: 0; }
.hint { display: block; color: var(--text-2); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
.table-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 12px 0; }
.count { display: inline; margin-left: 12px; }
@media (max-width: 560px) { .point-columns { grid-template-columns: 1fr; } }
</style>
