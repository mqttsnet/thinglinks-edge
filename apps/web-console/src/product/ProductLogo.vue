<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useProduct } from './useProduct';
withDefaults(defineProps<{ size?: number }>(), { size: 40 });
const { product, logoUrl, loadProduct } = useProduct();
const failed = ref(false);
watch(logoUrl, () => { failed.value = false; });
onMounted(loadProduct);
</script>

<template>
  <img v-if="logoUrl && !failed" :src="logoUrl" :alt="product?.name || ''"
       :width="size" :height="size" class="product-logo" @error="failed = true" />
  <span v-else class="product-logo fallback" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    {{ product?.name.charAt(0) || '◇' }}
  </span>
</template>

<style scoped>
.product-logo { flex: none; object-fit: contain; display: inline-block; vertical-align: middle; }
.fallback { display: inline-grid; place-items: center; color: var(--primary); background: var(--l-primary); border-radius: var(--rs); font-weight: 650; }
</style>
