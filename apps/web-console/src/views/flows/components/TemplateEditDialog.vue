<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui';
import type { FlowTemplate, Instance } from '../../../api/types';
import { categoryOptions } from '../template-model';
import { useTemplateEditor } from '../composables/useTemplateEditor';
const props = defineProps<{ instances: Instance[]; protocols: { label: string; value: string }[] }>();
const emit = defineEmits<{ saved: [] }>();
const { visible, busy, error, fileError, fileName, targetId, fromKind, form, canSave, open, pickFile, save } = useTemplateEditor(() => emit('saved'));
const sources = [{ label: '从实例导出', value: 'instance' }, { label: '导入流程文件', value: 'file' }];
const instanceOptions = computed(() => props.instances.map((item) => ({
  label: `${item.name}（${item.id}）${item.running ? '' : ' · 已停止'}`, value: item.id, disabled: !item.running,
})));
defineExpose({ open: (template?: FlowTemplate) => open(template) });
</script>

<template>
  <NModal v-model:show="visible" preset="card" :title="targetId ? '编辑模板信息' : '新建模板'" class="edge-template-edit-dialog"
    :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy">
    <NForm label-placement="top" :disabled="busy">
      <NFormItem label="模板名称" required><NInput v-model:value="form.name" :maxlength="128" :input-props="{ 'aria-label': '模板名称' }" /></NFormItem>
      <NFormItem label="说明"><NInput v-model:value="form.description" type="textarea" :input-props="{ 'aria-label': '模板说明' }" /></NFormItem>
      <div class="metadata-grid">
        <NFormItem label="分类"><NSelect v-model:value="form.category" :options="categoryOptions" aria-label="模板分类" /></NFormItem>
        <NFormItem label="协议标签"><NSelect v-model:value="form.protocols" :options="protocols" multiple filterable tag
          placeholder="选择或输入协议" aria-label="协议标签" /></NFormItem>
      </div>
      <template v-if="!targetId">
        <NFormItem label="模板来源"><NSelect v-model:value="fromKind" :options="sources" aria-label="模板来源" /></NFormItem>
        <NFormItem v-if="fromKind === 'instance'" label="来源实例" required>
          <NSelect :value="form.instanceId || null" @update:value="form.instanceId = $event ?? ''" :options="instanceOptions" placeholder="选择运行中的实例" aria-label="来源实例" />
        </NFormItem>
        <NFormItem v-else label="Node-RED 流程文件" required>
          <div>
            <input type="file" accept=".json,application/json" :disabled="busy" aria-label="Node-RED 流程文件" @change="pickFile">
            <p v-if="fileName" class="hint">{{ fileName }}</p>
            <NAlert v-if="fileError" type="error" :bordered="false">{{ fileError }}</NAlert>
          </div>
        </NFormItem>
        <p class="hint">实例导出会读取当前全部流程。节点凭据不会导出，请在目标实例配置；固定写在节点内容里的凭据会标记提示。</p>
      </template>
    </NForm>
    <NAlert v-if="error" type="error" :bordered="false" class="error">{{ error }}</NAlert>
    <template #footer><NButton type="primary" :loading="busy" :disabled="!canSave" @click="save">保存模板</NButton></template>
  </NModal>
</template>

<style scoped>
:global(.edge-template-edit-dialog) { width: min(640px, calc(100vw - 32px)); }
.metadata-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.hint { color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }
.error { margin-top: 12px; }
input[type=file] { width: 100%; }
@media (max-width: 560px) { .metadata-grid { grid-template-columns: 1fr; gap: 0; } }
</style>
