<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NModal, NSelect, NSpace, NTag } from 'naive-ui';
import { can, canOperate } from '../../../api/permissions';
import type { FlowTemplate, Instance } from '../../../api/types';
import { configurableCopy, configurableTemplate, deploymentFeedback } from '../template-model';
import { useTemplateDeployment } from '../composables/useTemplateDeployment';
import TemplateDependencies from './TemplateDependencies.vue';
import TemplateParameters from './TemplateParameters.vue';
import CloudModelAssist from './CloudModelAssist.vue';
import CommandHistory from './CommandHistory.vue';
import { useCloudModel } from '../composables/useCloudModel';
import { availabilityFields, unavailableParameterIssues, snapshotControlWarnings } from '../parameter-availability';
const props = defineProps<{ instances: Instance[]; catalogue: FlowTemplate[] }>();
const emit = defineEmits<{ saved: []; deployed: [note: string] }>();
const { target, visible, modalSession, instanceId, mode, configurationSource, parameters, parametersEditable, effectiveParameters, preview, previewing, applying, copying, installing,
  error, configurationIssues, configurationChecking, configurationBlocked, readiness, inventory, readinessError, checkingComponents, copyName, deploymentEligible, canDeploy, canInstall, busy,
  open, checkComponents, checkPreview, deploy, install, copy } = useTemplateDeployment(
  () => emit('saved'), (note) => emit('deployed', note),
);
const cloudModel = useCloudModel(parameters, target, visible);
watch(configurationSource, () => cloudModel.reset(), { flush: 'sync' });
const sourceOptions = [
  { label: '按参数重新生成', value: 'parameters' },
  { label: '使用已保存快照', value: 'snapshot' },
];
const canChooseSource = computed(() => Boolean(target.value && configurableCopy(target.value)));
const formFields = computed(() => target.value ? availabilityFields(target.value, props.catalogue) : []);
const snapshotWarnings = computed(() => target.value
  ? snapshotControlWarnings(target.value, props.catalogue, configurationSource.value) : []);
const formIssues = computed(() => [...cloudModel.issues.value, ...unavailableParameterIssues(formFields.value, parameters.value)]);
watch(formIssues, (issues) => { configurationIssues.value = issues; }, { flush: 'sync' });
watch(cloudModel.loading, (loading) => { configurationChecking.value = loading; }, { flush: 'sync' });
const configurable = computed(() => Boolean(target.value && configurableTemplate(target.value)));
const feedback = computed(() => preview.value ? deploymentFeedback(preview.value, deploymentEligible.value, applying.value) : null);
const replaceConfirmed = ref(false);
watch([preview, mode, instanceId], () => { replaceConfirmed.value = false; });
const options = computed(() => props.instances.filter((item) => canOperate(item.id)).map((item) => ({
  label: `${item.name}（${item.id}）${item.running ? '' : ' · 已停止'}`, value: item.id, disabled: !item.running,
})));
const readyOptions = computed(() => options.value.some((item) => !item.disabled));
const modes = [ { label: '新增流程，保留已有流程', value: 'append' }, { label: '替换目标实例全部流程', value: 'replace' } ];
defineExpose({ open: (template: FlowTemplate) => open(template) });
</script>

<template>
  <NModal :key="modalSession.id" :show="visible" :on-update-show="modalSession.onUpdateShow" preset="card" :title="target?.name ?? '配置模板'" class="edge-template-deploy-dialog"
    :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy">
    <template v-if="target">
      <p class="description">{{ target.description }}</p>
      <NForm v-if="canChooseSource" label-placement="top">
        <NFormItem label="副本使用方式">
          <NSelect v-model:value="configurationSource" :options="sourceOptions" :disabled="busy" aria-label="副本使用方式" />
        </NFormItem>
      </NForm>
      <NAlert v-if="canChooseSource && configurationSource === 'snapshot'" type="info" :bordered="false" class="notice">
        使用保存时的流程和设备配置。部署前仍检查目标实例组件；下方可继续选择新增或替换流程。
        暂存的参数改动已保留，切回“按参数重新生成”可继续编辑。
        <p v-if="effectiveParameters.nodeId">快照设备：{{ effectiveParameters.nodeId }}</p>
      </NAlert>
      <NAlert v-if="snapshotWarnings.length" type="warning" :bordered="false" class="notice" title="旧快照控制风险">
        快照仍保留保存时的流程。若包含控制节点，请根据当前限制明确关闭控制并重新部署。
        <ul class="notes"><li v-for="warning in snapshotWarnings" :key="warning">{{ warning }}</li></ul>
      </NAlert>
      <NAlert v-if="target.notes?.length" type="info" :bordered="false" class="notice">
        <ul class="notes"><li v-for="note in target.notes" :key="note">{{ note }}</li></ul>
      </NAlert>
      <TemplateParameters v-if="parametersEditable && target.parameters?.length" :fields="formFields" v-model:values="parameters" :disabled="busy"
        :options-for="cloudModel.optionsFor">
        <template #cloud-assist>
          <CloudModelAssist :result="cloudModel.result.value" :loading="cloudModel.loading.value" :error="cloudModel.error.value"
            :stale="cloudModel.stale.value" :allowed="cloudModel.allowed.value" :has-identity="cloudModel.hasIdentity.value"
            :disabled="busy" :issues="cloudModel.issues.value" @query="cloudModel.query" />
        </template>
      </TemplateParameters>
      <NAlert v-if="!configurable" type="info" :bordered="false" class="notice">
        {{ target.derivedFrom ? '这是早期保存的配置副本，未保留设备与点位参数。' : '此模板是已保存的流程快照，未包含可编辑的设备参数。' }}
        可以按原流程部署。{{ target.derivedFrom ? '需要修改设备或点位参数时，请从对应内置模板重新配置。' : '需要修改流程时，请重新导入调整后的流程文件。' }}
      </NAlert>
      <section v-if="parametersEditable && can('template:manage')" class="copy-section">
        <NInput v-model:value="copyName" placeholder="副本名称" :disabled="busy" :input-props="{ 'aria-label': '配置副本名称' }" />
        <NButton :loading="copying" :disabled="busy || configurationBlocked || !copyName.trim()" @click="copy">保存配置副本</NButton>
        <p class="hint">副本保存当前参数生成的流程，可独立修改；不会写入实例。</p>
      </section>
      <NForm label-placement="top">
        <NFormItem label="目标实例">
          <NSelect :value="instanceId || null" @update:value="instanceId = $event ?? ''" :options="options" :disabled="busy" placeholder="选择运行中的实例" aria-label="目标实例" />
        </NFormItem>
        <NFormItem label="部署方式">
          <NSelect v-model:value="mode" :options="modes" :disabled="busy" aria-label="部署方式" />
        </NFormItem>
      </NForm>
      <NAlert v-if="!readyOptions" type="info" :bordered="false" class="notice">暂无运行中且有操作权限的实例。可先保存配置副本，准备实例后再部署。</NAlert>
      <TemplateDependencies v-if="instanceId" :requirements="target.requirements ?? []" :readiness="readiness" :inventory="inventory"
        :loading="checkingComponents" :error="readinessError" :can-install="canInstall" :installing="installing"
        :disabled="busy" @install="install" @refresh="checkComponents" />
      <CommandHistory v-if="effectiveParameters.downlinkEnabled === true" :instance-id="instanceId"
        :node-id="typeof effectiveParameters.nodeId === 'string' ? effectiveParameters.nodeId : ''" :model="cloudModel.result.value?.model ?? null" />
      <NAlert v-if="error" type="error" :bordered="false" class="notice">{{ error }}</NAlert>
      <NButton :loading="previewing" :disabled="!instanceId || busy || configurationBlocked" @click="checkPreview">检查参数并预览部署</NButton>
      <div v-if="preview" class="preview" aria-live="polite">
        <NSpace>
          <NTag size="small">{{ mode === 'append' ? '新增流程' : '替换全部流程' }}</NTag>
          <NTag size="small">{{ preview.nodeCount }} 个节点 · {{ preview.tabCount }} 张流程图</NTag>
        </NSpace>
        <NAlert :type="feedback?.type ?? 'info'" :bordered="false" class="notice">
          {{ feedback?.text }}<template v-if="!applying">。{{ preview.note }}</template>
          <ul v-if="preview.dependencyIssues?.length" class="notes"><li v-for="issue in preview.dependencyIssues" :key="issue">{{ issue }}</li></ul>
          <p v-if="mode === 'append' && preview.mode !== 'append'">服务端未确认新增模式，请先更新 Manager 后重新预览。</p>
          <p v-if="!preview.compat.checked">未能确认节点清单。内置协议模板需要完成节点检查后才能部署。</p>
          <p v-if="preview.compat.missing.length">缺少节点类型：{{ preview.compat.missing.join('、') }}</p>
        </NAlert>
        <NAlert v-if="preview.warnings.length" type="warning" :bordered="false" class="notice">疑似固定凭据：{{ preview.warnings.join('；') }}</NAlert>
        <NAlert v-if="mode === 'replace'" type="warning" :bordered="false" class="notice">
          替换会移除目标实例现有的全部流程。
          <NCheckbox v-model:checked="replaceConfirmed" :disabled="busy">我已确认可以替换该实例的全部流程</NCheckbox>
        </NAlert>
        <NButton type="primary" :loading="applying" :disabled="!canDeploy || (mode === 'replace' && !replaceConfirmed)"
          @click="deploy">{{ mode === 'append' ? '确认新增流程' : '确认替换全部流程' }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
:global(.edge-template-deploy-dialog) { width: min(880px, calc(100vw - 32px)); }
.description { color: var(--text-2); margin: 0 0 16px; }
.notice { margin: 12px 0; overflow-wrap: anywhere; }
.notes { margin: 0; padding-left: 20px; }
.copy-section { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 16px 0; margin-bottom: 16px; border-block: 1px solid var(--border); }
.hint { grid-column: 1 / -1; color: var(--text-2); font-size: 12px; margin: 0; }
.preview { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 16px; }
@media (max-width: 560px) { .copy-section { grid-template-columns: 1fr; } }
</style>
