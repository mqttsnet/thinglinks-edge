import { computed, ref } from 'vue';
import { api, ApiError } from '../../../api/client';
import type { FlowTemplate, TemplateCategory } from '../../../api/types';

export function useTemplateEditor(onSaved: () => void) {
  const visible = ref(false);
  const busy = ref(false);
  const error = ref('');
  const fileError = ref('');
  const fileName = ref('');
  const flows = ref<unknown[] | null>(null);
  const targetId = ref('');
  const fromKind = ref<'instance' | 'file'>('instance');
  const form = ref({ name: '', description: '', category: 'custom' as TemplateCategory, protocols: [] as string[], instanceId: '' });
  const canSave = computed(() => form.value.name.trim() && (targetId.value ||
    (fromKind.value === 'instance' ? form.value.instanceId : flows.value)));
  let fileGeneration = 0;

  function open(template?: FlowTemplate) {
    fileGeneration++;
    targetId.value = template?.id ?? '';
    form.value = { name: template?.name ?? '', description: template?.description ?? '',
      category: template?.category ?? 'custom', protocols: [...(template?.protocols ?? [])], instanceId: '' };
    fromKind.value = 'instance'; flows.value = null; fileName.value = ''; fileError.value = ''; error.value = '';
    visible.value = true;
  }

  async function pickFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const ticket = ++fileGeneration;
    fileName.value = file.name; fileError.value = ''; flows.value = null;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (ticket !== fileGeneration) return;
      if (!Array.isArray(parsed)) { fileError.value = '请选择 Node-RED 导出的流程 JSON 文件，顶层应当是数组。'; return; }
      flows.value = parsed;
      if (!form.value.name) form.value.name = file.name.replace(/\.json$/i, '');
    } catch { if (ticket === fileGeneration) fileError.value = '文件不是合法的 JSON，请检查后重新选择。'; }
  }

  async function save() {
    if (!canSave.value || busy.value) return;
    busy.value = true; error.value = '';
    const metadata = { name: form.value.name.trim(), description: form.value.description,
      category: form.value.category, protocols: form.value.protocols };
    try {
      if (targetId.value) await api.updateTemplate(targetId.value, metadata);
      else await api.createTemplate({ ...metadata, ...(fromKind.value === 'instance'
        ? { instanceId: form.value.instanceId } : { content: flows.value }) });
      visible.value = false; onSaved();
    } catch (e) { error.value = e instanceof ApiError ? e.message : '保存模板失败，请重试'; }
    finally { busy.value = false; }
  }
  return { visible, busy, error, fileError, fileName, targetId, fromKind, form, canSave, open, pickFile, save };
}
