<script setup lang="ts">
import { onMounted } from 'vue';
import { useProduct } from './useProduct';
const { product, loadProduct } = useProduct();
onMounted(loadProduct);
</script>

<template>
  <span v-if="product" class="copyright">
    <span>Copyright © {{ product.copyrightStartYear }}-present {{ product.copyrightOwner }} All Rights Reserved.</span>
    <span v-if="product.communityUrl && product.communityName" class="community">
      <a :href="product.communityUrl" target="_blank" rel="noopener noreferrer">{{ product.communityName }}</a>
    </span>
  </span>
</template>

<style scoped>
.copyright { display: inline-flex; flex-wrap: wrap; justify-content: inherit; gap: 4px 12px; overflow-wrap: anywhere; }
.community { display: inline-flex; gap: 8px; }
a { color: var(--primary); text-decoration: none; white-space: nowrap; }
a:hover { text-decoration: underline; }
a:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
</style>
