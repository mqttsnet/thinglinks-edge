<script setup lang="ts">
import { computed } from 'vue';
import { NCollapse, NCollapseItem } from 'naive-ui';
import type { TemplateParameter } from '../../../api/types';
import type { ModelOptionResolver } from '../cloud-model';
import { parameterGroups } from '../cloud-model';
import ParameterFields from './ParameterFields.vue';
const props = defineProps<{ fields: TemplateParameter[]; values: Record<string, unknown>; disabled?: boolean; optionsFor?: ModelOptionResolver | undefined }>();
const emit = defineEmits<{ 'update:values': [values: Record<string, unknown>] }>();
const groups = computed(() => parameterGroups(props.fields, props.values));
</script>

<template>
  <template v-for="group in groups" :key="group.id">
    <NCollapse v-if="group.id === 'advanced'" class="advanced">
      <NCollapseItem title="高级配置" name="advanced">
        <ParameterFields :fields="group.fields" :values="values" :disabled="disabled" :options-for="optionsFor"
          @update:values="emit('update:values', $event)" />
      </NCollapseItem>
    </NCollapse>
    <section v-else class="parameter-section">
      <h3>{{ group.label }}</h3>
      <p v-if="group.id === 'commands' && !group.fields.some(field => field.key === 'downlinkEnabled' && field.disabledReason)" class="hint">控制默认关闭。启用后仅按明确配置的命令映射向设备写入，参数与目标点位需现场核对。</p>
      <ParameterFields :fields="group.fields" :values="values" :disabled="disabled" :options-for="optionsFor"
        @update:values="emit('update:values', $event)" />
      <slot v-if="group.id === 'cloud'" name="cloud-assist" />
    </section>
  </template>
</template>

<style scoped>
.parameter-section { padding-top: 16px; border-top: 1px solid var(--border); margin-top: 16px; }
h3 { margin: 0 0 16px; font-size: 16px; }
.advanced { padding: 16px 0; border-top: 1px solid var(--border); margin-top: 16px; }
.hint { color: var(--text-2); font-size: 12px; margin: 0 0 12px; }
</style>
