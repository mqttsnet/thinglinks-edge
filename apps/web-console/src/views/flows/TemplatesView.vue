<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NPopconfirm, NSpace, NSpin, NTag, useMessage } from 'naive-ui';
import { ApiError } from '../../api/client';
import { can } from '../../api/permissions';
import type { FlowTemplate } from '../../api/types';
import { localTime } from '../../api/datetime';
import { categoryLabel, configurableTemplate, isBuiltin } from './template-model';
import { useTemplateLibrary } from './composables/useTemplateLibrary';
import TemplateFilters from './components/TemplateFilters.vue';
import TemplateEditDialog from './components/TemplateEditDialog.vue';
import TemplateDeployDialog from './components/TemplateDeployDialog.vue';
const message = useMessage();
const { templates, instances, loading, error, instanceError, filters, filtered, protocolOptions, refresh, remove, download } = useTemplateLibrary();
const manage = computed(() => can('template:manage'));
const editor = ref<InstanceType<typeof TemplateEditDialog>>();
const deployer = ref<InstanceType<typeof TemplateDeployDialog>>();
function sourceLabel(template: FlowTemplate) {
  if (template.derivedFrom) return `内置模板副本 · ${template.derivedFrom.revision}`;
  return template.source === 'upload' ? '文件导入' : instances.value.find((item) => item.id === template.source)?.name ?? template.source;
}
async function downloadTemplate(template: FlowTemplate) {
  try { await download(template); }
  catch (e) { message.error(e instanceof ApiError ? e.message : '下载失败'); }
}
async function deleteTemplate(template: FlowTemplate) {
  try { await remove(template); message.success('模板已删除'); }
  catch (e) { message.error(e instanceof ApiError ? e.message : '删除失败'); }
}
async function saved() { message.success('模板已保存'); await refresh(); }
onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="bar">
      <div><h2>流程模板</h2><p class="sub">按协议选择采集方案，配置设备和点位后部署到实例</p></div>
      <NSpace><NButton size="small" :loading="loading" @click="refresh">刷新</NButton>
        <NButton v-if="manage" type="primary" size="small" @click="editor?.open()">新建模板</NButton></NSpace>
    </div>
    <TemplateFilters v-model:value="filters" :protocols="protocolOptions" />
    <NAlert v-if="error" type="error" :bordered="false" class="notice">{{ error }}</NAlert>
    <NAlert v-if="instanceError" type="warning" :bordered="false" class="notice">{{ instanceError }}</NAlert>
    <NSpin :show="loading">
      <NEmpty v-if="!loading && !filtered.length" class="empty" :description="templates.length ? '没有符合筛选条件的模板' : '还没有流程模板'">
        <template #extra><p class="sub">{{ templates.length ? '调整搜索词、来源或分类后重试。' : '可以从运行中的实例导出流程，或导入 Node-RED 流程文件。' }}</p></template>
      </NEmpty>
      <div v-else class="list">
        <NCard v-for="template in filtered" :key="template.id" :bordered="false">
          <div class="template-heading">
            <div class="identity"><h3>{{ template.name }}</h3>
              <NTag size="small" :type="isBuiltin(template) ? 'info' : 'default'" :bordered="false">{{ isBuiltin(template) ? '内置' : '我的模板' }}</NTag>
              <NTag size="small" :bordered="false">{{ categoryLabel(template.category) }}</NTag>
              <NTag v-for="protocol in template.protocols" :key="protocol" size="small" :bordered="false">{{ protocol }}</NTag>
            </div>
            <NSpace :size="8" class="actions">
              <NButton v-if="!isBuiltin(template)" size="tiny" secondary @click="downloadTemplate(template)">下载</NButton>
              <template v-if="manage && !isBuiltin(template)">
                <NButton size="tiny" secondary @click="editor?.open(template)">编辑信息</NButton>
                <NPopconfirm @positive-click="deleteTemplate(template)">
                  <template #trigger><NButton size="tiny" secondary type="error">删除</NButton></template>
                  删除模板「{{ template.name }}」？已部署的流程不受影响。
                </NPopconfirm>
              </template>
              <NButton size="tiny" type="primary" @click="deployer?.open(template)">{{ configurableTemplate(template) ? '配置与部署' : '套用到实例' }}</NButton>
            </NSpace>
          </div>
          <p v-if="template.description" class="description">{{ template.description }}</p>
          <div class="meta">
            <span>{{ template.nodeCount }} 个节点 · {{ template.tabCount }} 张流程图</span>
            <span v-if="isBuiltin(template)">模板版本 {{ template.revision ?? '—' }}</span>
            <template v-else><span>来源 {{ sourceLabel(template) }}</span><span>{{ template.createdBy }} · {{ localTime(template.createdAt) }}</span></template>
            <span v-if="template.requirements?.length">需准备 {{ template.requirements.length }} 个组件</span>
          </div>
          <NAlert v-if="template.warnings.length" type="warning" :bordered="false" class="notice">
            节点内容可能含固定凭据，分发前请核对：{{ template.warnings.join('；') }}
          </NAlert>
        </NCard>
      </div>
    </NSpin>
    <TemplateEditDialog ref="editor" :instances="instances" :protocols="protocolOptions" @saved="saved" />
    <TemplateDeployDialog ref="deployer" :instances="instances" :catalogue="templates" @saved="saved" @deployed="message.success($event, { duration: 8000 })" />
  </div>
</template>

<style scoped>
.page { padding: 4px 0; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 22px; }
.sub { color: var(--text-2); font-size: 13px; margin: 4px 0 0; }
.list { display: flex; flex-direction: column; gap: 12px; }
.template-heading { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.identity { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.description { color: var(--text-2); margin: 12px 0; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12px; color: var(--text-2); }
.notice { margin: 12px 0; overflow-wrap: anywhere; }
.empty { padding: 48px 16px; }
</style>
