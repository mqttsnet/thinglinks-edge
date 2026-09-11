<script setup lang="ts">
import { NAlert, NButton, NTag } from 'naive-ui';
import type { CloudModelQueryResult } from '../../../api/types';
defineProps<{
  result: CloudModelQueryResult | null; loading: boolean; error: string; stale: boolean;
  allowed: boolean; hasIdentity: boolean; disabled: boolean; issues: string[];
}>();
const emit = defineEmits<{ query: [] }>();
</script>

<template>
  <div class="model-assist">
    <div class="model-action">
      <NButton size="small" :loading="loading" :disabled="disabled || !allowed || !hasIdentity" @click="emit('query')">从 ThingLinks 读取物模型</NButton>
      <NTag size="small" :type="result ? 'info' : 'default'" :bordered="false">{{ result ? '已读取候选值' : '云端映射未校验' }}</NTag>
    </div>
    <p v-if="!allowed" class="hint">当前账号没有读取模板物模型的权限。可以继续手动填写，云端映射保持未校验。</p>
    <p v-else-if="!hasIdentity" class="hint">填写子设备所属产品标识和绑定版本后，可读取服务、属性和命令候选值。离线时可继续手动填写。</p>
    <p v-else-if="!result && !error" class="hint">{{ stale ? '产品或版本已改变，请重新读取。已有映射已保留，当前尚未校验。' : '读取后提供名称与编码候选，不会覆盖已有配置。' }}</p>
    <NAlert v-if="error" type="warning" :bordered="false" class="model-alert">
      {{ error }}。已有配置已保留，可以继续手动填写；当前云端映射未校验。
    </NAlert>
    <p v-if="result" class="hint">
      {{ result.model.productIdentification ? `产品 ${result.model.productIdentification}` : '云端未返回产品标识，请核对' }}
      · {{ result.versionNo ? `版本 ${result.versionNo}` : '云端未返回版本，请核对' }}
      · {{ result.model.services?.length ?? 0 }} 个服务。读取结果用于配置核对，设备绑定版本和实际收发仍需验证。
    </p>
    <NAlert v-if="issues.length" type="warning" :bordered="false" class="model-alert">
      当前配置与本次读取的模型存在差异，已暂停预览、部署和保存副本。请修正以下映射：
      <ul><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
    </NAlert>
  </div>
</template>

<style scoped>
.model-assist { margin: 0 0 16px; }
.model-action { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.hint { color: var(--text-2); font-size: 12px; margin: 8px 0 0; overflow-wrap: anywhere; }
.model-alert { margin-top: 12px; }
ul { padding-left: 20px; margin: 4px 0 0; }
</style>
