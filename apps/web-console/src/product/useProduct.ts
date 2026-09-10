import { computed, readonly, ref } from 'vue';
import { api, basePath } from '../api/client';
import type { ProductMetadata } from './types';

// Empty loading state intentionally contains no duplicate product defaults.
const metadata = ref<ProductMetadata | null>(null);
const error = ref('');
let inflight: Promise<void> | undefined;

export async function loadProduct(): Promise<void> {
  if (metadata.value) return;
  if (!inflight) inflight = api.product().then(({ product }) => {
    metadata.value = product;
    error.value = '';
    document.title = `${product.name} 控制台`;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon && product.logoUrl) icon.href = assetUrl(product.logoUrl);
  }).catch(() => { error.value = '产品信息暂时无法读取'; }).finally(() => { inflight = undefined; });
  await inflight;
}

function assetUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${basePath}/${url}`;
}

export function useProduct() {
  return { product: readonly(metadata), error: readonly(error), loadProduct,
    logoUrl: computed(() => metadata.value?.logoUrl ? assetUrl(metadata.value.logoUrl) : '') };
}
