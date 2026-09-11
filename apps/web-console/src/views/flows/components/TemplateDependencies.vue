<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NTag } from 'naive-ui';
import type { InstanceInventory, InstanceProtocolStatus, TemplateRequirement } from '../../../api/types';
const props = defineProps<{
  requirements: TemplateRequirement[]; inventory: InstanceInventory | null; readiness: InstanceProtocolStatus | null;
  loading: boolean; error: string; canInstall: boolean; installing: string; disabled: boolean;
}>();
const emit = defineEmits<{ install: [requirement: TemplateRequirement]; refresh: [] }>();
const rows = computed(() => props.requirements.map((requirement) => {
  const status = props.readiness?.protocols.flatMap((protocol) => protocol.packages)
    .find((item) => item.module === requirement.module && item.version === requirement.version);
  const observed = props.inventory?.ok ? props.inventory.modules.find((item) => item.module === requirement.module) : undefined;
  const protocol = props.readiness?.protocols.find(item => item.status === 'available' && item.requirements.some(dep => dep.module === requirement.module));
  const name = protocol?.name ?? 'ThingLinks 上报组件';
  return { requirement, name, status, installedVersion: status?.installedVersion ?? observed?.version,
    loaded: status ? status.installation === 'installed' && status.loaded : observed?.version === requirement.version
      && observed.enabled && observed.health === 'healthy' && requirement.nodeTypes.every((type) => observed.types.includes(type)),
  };
}));
</script>

<template>
  <section class="dependencies">
    <div class="section-heading">
      <h3>实例组件</h3>
      <NButton size="tiny" :loading="loading" :disabled="disabled" @click="emit('refresh')">重新检查</NButton>
    </div>
    <NAlert v-if="error || readiness?.inspectionError" type="warning" :bordered="false">
      {{ error || readiness?.inspectionError }}
    </NAlert>
    <p v-if="!requirements.length" class="hint">使用内置节点；部署预览会检查目标实例实际加载的节点。</p>
    <div v-for="row in rows" :key="row.requirement.module" class="dependency-row">
      <div class="package-description">
        <b class="package-name">{{ row.name }}</b>
        <p class="hint">
          需要版本 {{ row.requirement.version }} · {{ row.installedVersion ? `实例版本 ${row.installedVersion}` : '尚未确认实例版本' }}
          <template v-if="row.status">· {{ row.status?.packagePresent && row.status?.integrityValid ? '组件包已校验' : '组件包未校验' }}
          · {{ row.status?.approval === 'missing' ? '尚未批准' : row.status?.approval === 'other' ? '需核对批准版本' : row.status ? '已有批准记录' : '批准状态未确认' }}</template>
          <template v-else> · 由节点管理维护</template>
        </p>
      </div>
      <NTag v-if="row.loaded" size="small" type="success">已加载</NTag>
      <template v-else>
        <NTag size="small" type="warning">{{ row.status?.installation === 'version-mismatch' ? '版本不匹配' : row.status?.installation === 'installed' ? '未完整加载' : '需要准备' }}</NTag>
        <NButton v-if="canInstall && row.status" size="tiny" :loading="installing === row.requirement.module"
          :disabled="disabled || loading || !row.status || row.status.approval === 'missing'"
          @click="emit('install', row.requirement)">安装 {{ row.requirement.version }}</NButton>
      </template>
    </div>
    <p class="hint">安装使用当前实例的节点策略。包库、版本批准或加载有问题时，到 <RouterLink to="/nodes">节点管理</RouterLink> 处理后重新检查。</p>
  </section>
</template>

<style scoped>
.section-heading, .dependency-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.section-heading { justify-content: space-between; }
h3 { margin: 0 0 12px; font-size: 15px; }
.dependency-row { padding: 12px 0; border-bottom: 1px solid var(--border); }
.package-description { flex: 1 1 280px; min-width: 0; }
.package-name { font-size: 13px; overflow-wrap: anywhere; }
.hint { color: var(--text-2); font-size: 12px; margin: 4px 0 8px; }
a { color: var(--primary); }
.dependencies { margin-bottom: 20px; }
</style>
