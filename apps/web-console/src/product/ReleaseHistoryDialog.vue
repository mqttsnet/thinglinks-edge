<script setup lang="ts">
import { ref, watch } from 'vue';
import { NModal, NButton, NAlert, NSpin, NEmpty } from 'naive-ui';
import { api } from '../api/client';
import { useProduct } from './useProduct';
import type { ProductReleaseResult } from './types';
import ReleaseNotes from '../components/ReleaseNotes.vue';

const props = defineProps<{ show: boolean; version: string; notes: string }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();
const { product } = useProduct();
const result = ref<ProductReleaseResult | null>(null);
const busy = ref(false);
let generation = 0;
async function load() {
  const current = ++generation;
  busy.value = true;
  try {
    const response = await api.productReleases();
    if (current === generation) result.value = response;
  } catch {
    if (current === generation) result.value = { state: 'error', releases: [], checkedAt: '', message: '更新记录暂时无法读取，请稍后重试。' };
  } finally { if (current === generation) busy.value = false; }
}
watch(() => props.show, show => {
  if (show) void load();
  else { generation++; busy.value = false; }
});
const date = (value: string) => value ? new Date(value).toLocaleDateString('zh-CN') : '';
</script>

<template>
  <NModal :show="show" preset="card" style="width: min(800px, calc(100vw - 32px))" title="更新记录" @update:show="emit('update:show', $event)">
    <div class="release-intro">
      <span>当前安装 {{ version ? `v${version}` : '版本未知' }}</span>
      <a v-if="product?.releasesUrl" :href="product.releasesUrl" target="_blank" rel="noopener noreferrer">GitHub 发布页 ↗</a>
    </div>
    <div class="release-scroll" :aria-busy="busy">
      <NSpin v-if="busy" class="loading" size="small"><template #description>正在读取发布记录</template></NSpin>
      <NAlert v-else-if="result?.state !== 'ready'" :type="result?.state === 'disabled' ? 'info' : 'warning'" :bordered="false">
        {{ result?.message }}
        <NButton v-if="result?.state === 'error'" size="small" class="retry" @click="load">重试</NButton>
      </NAlert>
      <NEmpty v-else-if="!result.releases.length" description="GitHub 暂无已发布版本" />
      <template v-else>
        <p class="source">来自 {{ product?.githubRepository }}，显示最近 {{ result.releases.length }} 条发布记录。</p>
        <article v-for="release in result.releases" :key="release.tag" class="release-card">
          <div class="release-head">
            <h3>{{ release.tag }}</h3><span v-if="release.prerelease" class="preview">预发布</span>
            <time>{{ date(release.publishedAt) }}</time>
            <a :href="release.url" target="_blank" rel="noopener noreferrer">发布详情 ↗</a>
          </div>
          <p v-if="release.name && release.name !== release.tag" class="release-name">{{ release.name }}</p>
          <ReleaseNotes v-if="release.body" :source="release.body" />
          <p v-else class="source">该版本暂未提供更新说明。</p>
          <p v-if="release.truncated" class="source">内容较长，请前往发布详情查看完整说明。</p>
        </article>
      </template>
      <details v-if="notes" class="installed-notes">
        <summary>当前安装版本说明 · v{{ version }}</summary>
        <ReleaseNotes :source="notes" />
      </details>
    </div>
    <template #footer><div class="dialog-footer"><NButton @click="emit('update:show', false)">关闭</NButton></div></template>
  </NModal>
</template>

<style scoped>
.release-intro, .release-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.release-intro { color: var(--text-2); margin-bottom: 18px; justify-content: space-between; }
.release-scroll { max-height: 65vh; overflow-y: auto; overflow-wrap: anywhere; }
.loading { display: flex; justify-content: center; padding: 40px; }
.source { color: var(--muted); font-size: 12px; }
.release-card { border: 1px solid var(--border); border-radius: var(--rs); padding: 20px; margin-bottom: 16px; }
.release-head h3 { font-size: 14px; margin: 0; padding: 3px 10px; border-radius: 20px; background: var(--grey100); }
.release-head time { color: var(--muted); margin-left: auto; font-size: 12px; }
.preview { font-size: 11px; color: var(--warning); }
.release-name { font-weight: 600; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
.retry { margin-left: 12px; }
.installed-notes { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
summary { cursor: pointer; margin-bottom: 12px; }
.dialog-footer { text-align: right; }
</style>
