<script setup lang="ts">
import { NButton } from 'naive-ui';
withDefaults(defineProps<{
  loading?: boolean;
  disabled?: boolean;
  label?: string;
  size?: 'tiny' | 'small' | 'medium' | 'large';
}>(), { loading: false, disabled: false, label: '刷新', size: 'small' });
defineEmits<{ click: [] }>();
</script>

<template>
  <NButton :size="size" :loading="loading" :disabled="disabled || loading"
           :aria-label="label" :aria-busy="loading" @click="$emit('click')">
    <template #icon>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.1 7a7 7 0 0 1 11.55-1L20 9M4 15l2.35 3A7 7 0 0 0 17.9 17" />
      </svg>
    </template>
    {{ label }}
  </NButton>
</template>
