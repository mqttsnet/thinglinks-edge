<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NEmpty, NFormItem } from 'naive-ui';
import type { TemplateParameter } from '../../../api/types';
import type { ModelOptionResolver } from '../cloud-model';
import { newTableRow } from '../template-model';
import ParameterScalar from './ParameterScalar.vue';
const props = defineProps<{ field: TemplateParameter; value: unknown; disabled?: boolean; optionsFor?: ModelOptionResolver | undefined }>();
const isCommand = computed(() => props.field.group === 'commands' || props.field.key === 'commands');
const rowLabel = computed(() => isCommand.value ? '命令映射' : '点位');
const emit = defineEmits<{ 'update:value': [value: Record<string, unknown>[]] }>();
const rows = computed<Record<string, unknown>[]>(() => Array.isArray(props.value) ? props.value : []);
function update(index: number, key: string, value: unknown) {
  emit('update:value', rows.value.map((row, i) => i === index ? { ...row, [key]: value } : row));
}
function add() { emit('update:value', [...rows.value, newTableRow(props.field.columns)]); }
function remove(index: number) { emit('update:value', rows.value.filter((_, i) => i !== index)); }
</script>

<template>
  <div class="table-field">
    <NEmpty v-if="rows.length === 0" size="small" :description="isCommand ? '还没有命令映射；添加后选择云端命令和设备目标点位' : '还没有点位，添加后填写采集地址与物模型属性'" />
    <div v-for="(row, index) in rows" :key="index" class="point-row">
      <div class="row-title">
        <b>{{ rowLabel }} {{ index + 1 }}</b>
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
    <NButton size="small" :disabled="disabled || rows.length >= (field.max ?? 64)" @click="add">添加{{ rowLabel }}</NButton>
    <span class="hint count">{{ rows.length }} / {{ field.max ?? 64 }} 个</span>
  </div>
</template>

<style scoped>
.table-field, .cell-input { width: 100%; min-width: 0; }
.point-row { padding: 12px; border: 1px solid var(--border); border-radius: var(--rs); margin-bottom: 12px; }
.row-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.point-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.point-cell { margin-bottom: 0; }
.hint { display: block; color: var(--text-2); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
.count { display: inline; margin-left: 12px; }
@media (max-width: 560px) { .point-columns { grid-template-columns: 1fr; } }
</style>
