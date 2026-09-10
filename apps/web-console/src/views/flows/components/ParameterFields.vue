<script setup lang="ts">
import { NForm, NFormItem } from 'naive-ui';
import type { TemplateParameter } from '../../../api/types';
import type { ModelOptionResolver } from '../cloud-model';
import ParameterScalar from './ParameterScalar.vue';
import ParameterTable from './ParameterTable.vue';
const props = defineProps<{ fields: TemplateParameter[]; values: Record<string, unknown>; disabled?: boolean; optionsFor?: ModelOptionResolver | undefined }>();
const emit = defineEmits<{ 'update:values': [values: Record<string, unknown>] }>();
function update(key: string, value: unknown) { emit('update:values', { ...props.values, [key]: value }); }
</script>

<template>
  <NForm label-placement="top" class="parameter-form">
    <NFormItem v-for="field in fields" :key="field.key" :label="field.label" :required="field.required ?? false"
      :class="{ wide: field.type === 'table' }">
      <div class="parameter-input">
        <p v-if="field.disabledReason" class="hint" role="note">{{ field.disabledReason }}<template v-if="field.type === 'boolean' && values[field.key] === true">。该副本仍保留开启值，可关闭后继续配置采集。</template></p>
        <p v-else-if="field.description" class="hint">{{ field.description }}</p>
        <ParameterTable v-if="field.type === 'table'" :field="field" :value="values[field.key]" :disabled="disabled || Boolean(field.disabledReason)"
          :options-for="optionsFor" @update:value="update(field.key, $event)" />
        <ParameterScalar v-else :field="field" :value="values[field.key]" :disabled="disabled"
          :suggestions="optionsFor?.(field.key) ?? []" @update:value="update(field.key, $event)" />
      </div>
    </NFormItem>
  </NForm>
</template>

<style scoped>
.parameter-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.parameter-input { width: 100%; min-width: 0; }
.wide { grid-column: 1 / -1; }
.hint { color: var(--text-2); font-size: 12px; margin: 0 0 8px; overflow-wrap: anywhere; }
@media (max-width: 560px) { .parameter-form { grid-template-columns: 1fr; } }
</style>
