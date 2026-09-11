import { computed, ref } from 'vue';
import { api, ApiError } from '../../../api/client';
import { loadPermissions } from '../../../api/permissions';
import type { FlowTemplate, Instance, ProtocolComponentStatus } from '../../../api/types';
import { filterTemplates } from '../template-model';

export function useTemplateLibrary() {
  const templates = ref<FlowTemplate[]>([]);
  const instances = ref<Instance[]>([]);
  const protocols = ref<ProtocolComponentStatus[]>([]);
  const loading = ref(false);
  const error = ref('');
  const instanceError = ref('');
  const filters = ref({ source: '', category: '', protocol: '', search: '' });
  const filtered = computed(() => filterTemplates(templates.value, filters.value));
  const protocolOptions = computed(() => [...new Set([
    ...protocols.value.filter((protocol) => protocol.status === 'available').map((protocol) => protocol.id),
    ...templates.value.flatMap((template) => template.protocols ?? []),
  ])].sort().map((id) => ({ label: protocols.value.find((protocol) => protocol.id === id)?.name ?? id, value: id })));
  async function refresh() {
    if (loading.value) return;
    loading.value = true; error.value = ''; instanceError.value = '';
    await loadPermissions();
    const results = await Promise.allSettled([api.templates(), api.instances(), api.protocols()]);
    const [templateResult, instanceResult, protocolResult] = results;
    if (templateResult.status === 'fulfilled') templates.value = templateResult.value.templates;
    else error.value = templateResult.reason instanceof ApiError ? templateResult.reason.message : '加载模板失败，请重试';
    if (instanceResult.status === 'fulfilled') instances.value = instanceResult.value.instances;
    else { instances.value = []; instanceError.value = '实例列表未能加载，请刷新后重试。'; }
    if (protocolResult.status === 'fulfilled') protocols.value = protocolResult.value.protocols;
    loading.value = false;
  }
  async function remove(template: FlowTemplate) { await api.deleteTemplate(template.id); await refresh(); }
  async function download(template: FlowTemplate) {
    const { blob, filename } = await api.downloadTemplate(template.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }
  return { templates, instances, protocols, loading, error, instanceError, filters, filtered, protocolOptions, refresh, remove, download };
}
