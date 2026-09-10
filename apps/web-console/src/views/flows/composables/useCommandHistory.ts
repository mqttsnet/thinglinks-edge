import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { api, ApiError } from '../../../api/client';
import type { EdgeCommandRecord } from '../../../api/types';
import { createPreviewGate } from '../template-model';
export function useCommandHistory(instanceId: Ref<string>, nodeId: Ref<string>) {
  const commands = ref<EdgeCommandRecord[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');
  const canLoad = computed(() => Boolean(instanceId.value && nodeId.value.trim()));
  const gate = createPreviewGate();
  watch([instanceId, nodeId], () => {
    gate.invalidate(); commands.value = []; loading.value = false; loaded.value = false; error.value = '';
  }, { flush: 'sync' });
  onBeforeUnmount(() => gate.invalidate());
  async function refresh() {
    if (!canLoad.value || loading.value) return;
    const ticket = gate.begin(); loading.value = true; error.value = '';
    try {
      const result = await api.commands(instanceId.value, nodeId.value.trim());
      if (gate.current(ticket)) { commands.value = result.commands; loaded.value = true; }
    } catch (e) { if (gate.current(ticket)) error.value = e instanceof ApiError ? e.message : '暂时无法读取控制记录'; }
    finally { if (gate.current(ticket)) loading.value = false; }
  }
  return { commands, loading, loaded, error, canLoad, refresh };
}
