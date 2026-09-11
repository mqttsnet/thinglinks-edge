<script setup lang="ts">
import { NAutoComplete, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui';
import { computed } from 'vue';
import type { TemplateParameter } from '../../../api/types';
import type { ModelFieldOption } from '../cloud-model';
import { autocompleteChoices } from '../cloud-model';
import { parameterDisabled } from '../parameter-availability';
const props = defineProps<{ field: TemplateParameter; value: unknown; disabled?: boolean; label?: string; suggestions?: ModelFieldOption[] }>();
const locked = computed(() => parameterDisabled(props.field, props.value, props.disabled ?? false));
const options = computed(() => {
  const query = typeof props.value === 'string' ? props.value.trim().toLocaleLowerCase() : '';
  return autocompleteChoices((props.suggestions ?? []).filter(item => !query || item.value.toLocaleLowerCase().includes(query) || item.label.toLocaleLowerCase().includes(query)));
});
const renderLabel = (option: { displayLabel?: unknown; label?: unknown; value?: unknown }) => String(option.displayLabel ?? option.label ?? option.value ?? '');
const emit = defineEmits<{ 'update:value': [value: unknown] }>();
</script>

<template>
  <NInputNumber v-if="field.type === 'number'" :value="typeof value === 'number' ? value : null"
    v-bind="{ ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) }" :disabled="locked" :input-props="{ 'aria-label': label ?? field.label }" :aria-label="label ?? field.label"
    class="scalar" @update:value="emit('update:value', $event)" />
  <NSelect v-else-if="field.type === 'select'" :value="typeof value === 'string' || typeof value === 'number' ? value : null"
    :options="field.options ?? []" :disabled="locked" :input-props="{ 'aria-label': label ?? field.label }" :aria-label="label ?? field.label"
    @update:value="emit('update:value', $event)" />
  <NSwitch v-else-if="field.type === 'boolean'" :value="value === true" :disabled="locked"
    :aria-label="label ?? field.label" @update:value="emit('update:value', $event)" />
  <NAutoComplete v-else-if="suggestions?.length" :value="typeof value === 'string' ? value : ''"
    :options="options" :render-label="renderLabel" :get-show="() => true" :disabled="locked" :input-props="{ 'aria-label': label ?? field.label }"
    placeholder="选择云端编码，或手动填写" clearable @update:value="emit('update:value', $event)" />
  <NInput v-else :value="typeof value === 'string' ? value : ''" :disabled="locked"
    :input-props="{ 'aria-label': label ?? field.label }" @update:value="emit('update:value', $event)" />
</template>

<style scoped>
.scalar { width: 100%; }
</style>
