<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NButton, NAlert } from 'naive-ui';
import { api } from '../../api/client';
import { useProduct } from '../../product/useProduct';
import ProductLogo from '../../product/ProductLogo.vue';
import GithubIcon from '../../product/GithubIcon.vue';
import ReleaseHistoryDialog from '../../product/ReleaseHistoryDialog.vue';

const { product, error, loadProduct } = useProduct();
const version = ref('');
const notes = ref('');
const versionError = ref(false);
const history = ref(false);
onMounted(async () => {
  await loadProduct();
  try { const info = await api.version(); version.value = info.version; notes.value = info.notes; }
  catch { versionError.value = true; }
});
</script>

<template>
  <section class="about-page">
    <h2>关于</h2>
    <NAlert v-if="error" type="warning" :bordered="false">{{ error }} <NButton size="small" @click="loadProduct">重试</NButton></NAlert>
    <div class="product-hero">
      <ProductLogo :size="96" />
      <h3>{{ product?.name || '产品信息加载中' }}</h3>
      <p class="description">{{ product?.description }}</p>
      <div class="version-actions">
        <span class="version">{{ version ? `v${version}` : versionError ? '版本信息暂不可用' : '正在读取版本' }}</span>
        <NButton round @click="history = true">更新记录</NButton>
        <a v-if="product?.repositoryUrl" class="project-link" :href="product.repositoryUrl" target="_blank" rel="noopener noreferrer"><GithubIcon /> 项目主页 ↗</a>
      </div>
      <span v-if="product?.license" class="license">{{ product.license }}</span>
    </div>
    <div v-if="product" class="info-links">
      <a v-if="product.communityUrl" :href="product.communityUrl" target="_blank" rel="noopener noreferrer" class="info-link">
        <svg class="link-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg><div><h3>{{ product.communityName }}</h3><p>了解社区、产品和最新动态</p></div><span aria-hidden="true">↗</span>
      </a>
      <a v-if="product.repositoryUrl" :href="product.repositoryUrl" target="_blank" rel="noopener noreferrer" class="info-link">
        <GithubIcon class="link-symbol" /><div><h3>开源仓库</h3><p>{{ product.githubRepository }}</p></div><span aria-hidden="true">↗</span>
      </a>
      <a v-if="product.docsUrl" :href="product.docsUrl" target="_blank" rel="noopener noreferrer" class="info-link">
        <svg class="link-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5" /></svg><div><h3>使用文档</h3><p>安装、配置与使用指南</p></div><span aria-hidden="true">↗</span>
      </a>
      <a v-if="product.issuesUrl" :href="product.issuesUrl" target="_blank" rel="noopener noreferrer" class="info-link">
        <svg class="link-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12H9l-5 4ZM8 8h8M8 12h5" /></svg><div><h3>问题反馈</h3><p>报告问题或提交建议</p></div><span aria-hidden="true">↗</span>
      </a>
    </div>
    <ReleaseHistoryDialog v-model:show="history" :version="version" :notes="notes" />
  </section>
</template>

<style scoped>
.about-page { max-width: 1040px; margin: 0 auto; }
h2 { font-size: 21px; margin: 0; }
.product-hero { text-align: center; padding: 40px 16px 32px; }
.product-hero h3 { font-size: 28px; margin: 14px 0 6px; font-weight: 650; overflow-wrap: anywhere; }
.description { color: var(--text-2); margin: 0 auto 20px; max-width: 600px; }
.version-actions { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 12px; }
.version { background: var(--surface); border: 1px solid var(--border); padding: 5px 14px; border-radius: 24px; color: var(--text-2); font-size: 13px; }
.project-link { display: flex; align-items: center; gap: 7px; color: var(--primary); text-decoration: none; }
.project-link svg { width: 17px; height: 17px; }
.license { display: block; font-size: 12px; color: var(--muted); margin-top: 14px; }
.info-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.info-link { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); display: flex; align-items: center; gap: 18px; padding: 24px; color: var(--text); text-decoration: none; transition: border-color .15s; }
.info-link:hover { border-color: var(--primary); }
.info-link > :last-child { margin-left: auto; color: var(--muted); }
.info-link h3 { font-size: 15px; margin: 0 0 4px; }
.info-link p { font-size: 12px; color: var(--text-2); margin: 0; overflow-wrap: anywhere; }
.link-symbol { width: 26px; height: 26px; color: var(--primary); flex: none; font-size: 25px; line-height: 1; }
a:focus-visible { outline: 2px solid var(--primary); outline-offset: 4px; }
@media (max-width: 640px) { .info-links { grid-template-columns: 1fr; } .product-hero { padding: 28px 8px; } .info-link { padding: 18px; } }
</style>
