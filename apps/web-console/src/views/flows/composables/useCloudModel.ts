import { computed, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { api, ApiError } from '../../../api/client';
import { can } from '../../../api/permissions';
import type { CloudModelQueryResult, FlowTemplate } from '../../../api/types';
import { mappingIssues, modelFieldOptions, modelQueryIdentity } from '../cloud-model';
import { createPreviewGate } from '../template-model';

export function useCloudModel(parameters: Ref<Record<string, unknown>>, target: Ref<FlowTemplate | null>, visible: Ref<boolean>) {
  const result = ref<CloudModelQueryResult | null>(null);
  const loading = ref(false);
  const error = ref('');
  const stale = ref(false);
  const gate = createPreviewGate();
  const queryIdentity = computed(() => modelQueryIdentity(parameters.value));
  const allowed = computed(() => can('template:view'));
  const hasIdentity = computed(() => Boolean(queryIdentity.value && typeof parameters.value.versionNo === 'string' && parameters.value.versionNo.trim()));
  const canQuery = computed(() => allowed.value && hasIdentity.value);
  const issues = computed(() => mappingIssues(parameters.value, result.value?.model ?? null));

  function clear(markStale = false) {
    gate.invalidate(); stale.value = markStale && (Boolean(result.value) || loading.value || stale.value);
    result.value = null; error.value = ''; loading.value = false;
  }
  watch(queryIdentity, () => clear(true), { flush: 'sync' });
  watch(target, () => clear(), { flush: 'sync' });
  watch(visible, (show) => { if (!show) clear(); }, { flush: 'sync' });

  async function query() {
    if (!canQuery.value || loading.value) return;
    const ticket = gate.begin();
    const productIdentification = String(parameters.value.productIdentification).trim();
    const versionNo = String(parameters.value.versionNo).trim();
    result.value = null; error.value = ''; loading.value = true;
    try {
      const response = await api.queryCloudModel({ productIdentification, versionNo });
      if (!gate.current(ticket)) return;
      if (response.model.productIdentification && response.model.productIdentification !== productIdentification) {
        throw new Error('云端返回的产品与当前填写的产品不一致，请核对后重新读取。');
      }
      if (response.versionNo && response.versionNo !== versionNo) throw new Error('云端返回的版本与填写版本不一致，请核对设备绑定版本。');
      result.value = response; stale.value = false;
    } catch (e) {
      if (gate.current(ticket)) error.value = e instanceof ApiError || e instanceof Error ? e.message : '暂时无法读取云端物模型';
    } finally { if (gate.current(ticket)) loading.value = false; }
  }
  const optionsFor = (key: string, table?: string, row?: Record<string, unknown>) =>
    modelFieldOptions(key, parameters.value, result.value?.model ?? null, table, row);
  return { result, loading, error, stale, allowed, canQuery, hasIdentity, issues, query, optionsFor, reset: clear };
}
