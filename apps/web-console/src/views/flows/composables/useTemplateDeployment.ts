import { computed, ref, shallowRef, watch } from 'vue';
import { api, ApiError } from '../../../api/client';
import { can, canOperate } from '../../../api/permissions';
import type { ApplyPreview, FlowTemplate, InstanceInventory, InstanceProtocolStatus, TemplateDeployMode, TemplateRequirement } from '../../../api/types';
import { createPreviewGate, templateParameters, templateApplyOptions, sourceBuiltinId, previewAllowsDeploy, parameterEditingAllowed, effectiveTemplateParameters, type TemplateConfigurationSource } from '../template-model';
import { createDialogSessions } from '../dialog-session';

const errorText = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;

/** Keeps every async response tied to the selected template, target and parameters. */
export function useTemplateDeployment(onSaved: () => void, onDeployed: (note: string) => void) {
  const target = ref<FlowTemplate | null>(null);
  const visible = ref(false);
  const instanceId = ref('');
  const mode = ref<TemplateDeployMode>('append');
  const configurationSource = ref<TemplateConfigurationSource>('parameters');
  const parameters = ref<Record<string, unknown>>({});
  const preview = ref<ApplyPreview | null>(null);
  const previewing = ref(false);
  const applying = ref(false);
  const copying = ref(false);
  const installing = ref('');
  const error = ref('');
  const configurationIssues = ref<string[]>([]);
  const configurationChecking = ref(false);
  const parametersEditable = computed(() => Boolean(target.value && parameterEditingAllowed(target.value, configurationSource.value)));
  const effectiveParameters = computed(() => target.value ? effectiveTemplateParameters(target.value, parameters.value, configurationSource.value) : {});
  const configurationBlocked = computed(() => parametersEditable.value && (configurationChecking.value || configurationIssues.value.length > 0));
  const readiness = ref<InstanceProtocolStatus | null>(null);
  const inventory = ref<InstanceInventory | null>(null);
  const readinessError = ref('');
  const checkingComponents = ref(false);
  const copyName = ref('');
  const gate = createPreviewGate();
  const componentGate = createPreviewGate();
  const deploymentEligible = computed(() => Boolean(target.value && instanceId.value && canOperate(instanceId.value)
    && !configurationBlocked.value && previewAllowsDeploy(target.value, preview.value, mode.value)));
  const canInstall = computed(() => canOperate(instanceId.value));
  const busy = computed(() => applying.value || copying.value || Boolean(installing.value));
  const canDeploy = computed(() => deploymentEligible.value && !previewing.value && !busy.value);
  const dialogSessions = createDialogSessions(show => { if (show || !busy.value) visible.value = show; });
  const modalSession = shallowRef(dialogSessions.open());

  function invalidate() {
    gate.invalidate(); preview.value = null; previewing.value = false; error.value = '';
  }
  watch(configurationIssues, invalidate, { deep: true, flush: 'sync' });
  watch([instanceId, mode, parameters, configurationSource], invalidate, { deep: true, flush: 'sync' });
  watch(instanceId, () => { void checkComponents(); });
  watch(visible, (show) => { if (!show) { invalidate(); componentGate.invalidate(); } });

  function open(template: FlowTemplate) {
    modalSession.value = dialogSessions.open();
    target.value = template;
    instanceId.value = ''; mode.value = 'append'; configurationSource.value = 'parameters';
    parameters.value = templateParameters(template);
    copyName.value = `${template.name} · 我的配置`;
    readiness.value = null; inventory.value = null; readinessError.value = ''; invalidate();
    visible.value = true;
  }

  async function checkComponents() {
    const ticket = componentGate.begin();
    const id = instanceId.value;
    readiness.value = null; inventory.value = null; readinessError.value = ''; checkingComponents.value = false;
    if (!id) return;
    checkingComponents.value = true;
    try {
      const [protocols, nodes] = await Promise.allSettled([api.instanceProtocols(id), api.instanceNodeInventory(id)]);
      if (!componentGate.current(ticket)) return;
      if (protocols.status === 'fulfilled') readiness.value = protocols.value;
      else readinessError.value = errorText(protocols.reason, '无法检查目标实例协议组件');
      if (nodes.status === 'fulfilled') inventory.value = nodes.value;
      else readinessError.value = [readinessError.value, errorText(nodes.reason, '无法检查实例节点清单')].filter(Boolean).join('；');
    } catch (e) {
      if (componentGate.current(ticket)) readinessError.value = errorText(e, '无法检查目标实例组件，请重试');
    } finally {
      if (componentGate.current(ticket)) checkingComponents.value = false;
    }
  }

  async function checkPreview() {
    const template = target.value;
    if (!template || !instanceId.value || busy.value || configurationBlocked.value) return;
    const ticket = gate.begin();
    preview.value = null; error.value = ''; previewing.value = true;
    try {
      const result = await api.previewApply(instanceId.value, template.id, templateApplyOptions(template, mode.value, parameters.value, undefined, configurationSource.value));
      if (gate.current(ticket)) preview.value = result;
    } catch (e) {
      if (gate.current(ticket)) error.value = errorText(e, '预览失败，请检查参数后重试');
    } finally {
      if (gate.current(ticket)) previewing.value = false;
    }
  }

  async function deploy() {
    if (!target.value || !canDeploy.value) return;
    applying.value = true; error.value = '';
    try {
      const result = await api.applyTemplate(instanceId.value, target.value.id,
        templateApplyOptions(target.value, mode.value, parameters.value, preview.value?.revision, configurationSource.value));
      visible.value = false;
      onDeployed(result.note || `已部署 ${result.nodeCount} 个节点`);
    } catch (e) {
      preview.value = null;
      error.value = errorText(e, '部署失败，请重新预览后重试');
    } finally { applying.value = false; }
  }

  async function install(requirement: TemplateRequirement) {
    if (!canInstall.value || busy.value) return;
    const id = instanceId.value;
    invalidate(); installing.value = requirement.module;
    try {
      await api.installNodeToInstance(id, requirement.module, requirement.version);
      await checkComponents();
    } catch (e) { error.value = errorText(e, '安装失败，请检查批准清单与包库'); }
    finally { installing.value = ''; }
  }

  async function copy() {
    if (!target.value || !parametersEditable.value || !copyName.value.trim() || !can('template:manage') || busy.value || configurationBlocked.value) return;
    const builtinTemplateId = sourceBuiltinId(target.value);
    if (!builtinTemplateId) return;
    copying.value = true; error.value = '';
    try {
      await api.createTemplate({
        name: copyName.value.trim(), description: target.value.description,
        builtinTemplateId, parameters: parameters.value,
        category: target.value.category ?? 'custom', protocols: target.value.protocols ?? [],
      });
      visible.value = false; onSaved();
    } catch (e) { error.value = errorText(e, '保存副本失败，请检查参数'); }
    finally { copying.value = false; }
  }

  return { target, visible, modalSession, instanceId, mode, configurationSource, parameters, parametersEditable, effectiveParameters, preview, previewing, applying, copying, installing,
    error, configurationIssues, configurationChecking, configurationBlocked, readiness, inventory, readinessError, checkingComponents, copyName, deploymentEligible, canDeploy, canInstall, busy,
    open, checkComponents, checkPreview, deploy, install, copy };
}
