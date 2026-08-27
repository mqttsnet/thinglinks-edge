<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';

const prefersDark = ref(false);
onMounted(() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  prefersDark.value = mq.matches;
  mq.addEventListener('change', (e) => { prefersDark.value = e.matches; });
});

// naive-ui 的主题与 tokens.css 的深浅色保持同步
const theme = computed(() => (prefersDark.value ? darkTheme : null));

// 覆盖 naive-ui 主色，与设计令牌一致
const themeOverrides = computed(() => ({
  common: {
    primaryColor: prefersDark.value ? '#5183dd' : '#1e4db7',
    primaryColorHover: prefersDark.value ? '#6b97e6' : '#17409e',
    primaryColorPressed: '#17409e',
    borderRadius: '9px',
  },
}));
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NDialogProvider>
        <RouterView />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
