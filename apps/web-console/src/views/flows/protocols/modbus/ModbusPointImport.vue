<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NFormItem, NInput, NSelect, NTable, NPagination } from 'naive-ui';
import {
  applyModbusPointImport, MODBUS_IMPORT_TYPES, previewModbusPointImport,
  type ModbusImportMode, type ModbusImportPreview,
} from './point-import.ts';

import type { TemplateParameter } from '../../../../api/types';
import { paginateRows, tableRowLimit } from '../../components/table-pagination';
import { MODBUS_READ_BATCH_SIZE } from './read-limits';

const props = defineProps<{ schema: TemplateParameter; values: Record<string, unknown>; disabled?: boolean }>();
const emit = defineEmits<{ 'update:values': [values: Record<string, unknown>] }>();
const text = ref('');
const mode = ref<ModbusImportMode>('relative');
const preview = ref<ModbusImportPreview | null>(null);
const applied = ref('');
const page = ref(1);
const maxPoints = computed(() => tableRowLimit(props.schema));
const visible = computed(() => paginateRows(preview.value?.rows ?? [], page.value));
const batches = computed(() => Math.ceil((preview.value?.quantity ?? 0) / MODBUS_READ_BATCH_SIZE));
watch(preview, () => { page.value = 1; });
const existingCount = computed(() => Array.isArray(props.values.points) ? props.values.points.length : 0);
const canApply = computed(() => preview.value !== null && preview.value.issues.length === 0 && preview.value.rows.length > 0);
const modes = [
  { label: '相对偏移（相对于当前起始地址）', value: 'relative' },
  { label: '零基协议地址（从 0 开始）', value: 'absolute' },
  { label: '常见五位手册地址（40001 / 30001）', value: 'manual' },
];
const modeHint = computed(() => {
  if (mode.value === 'relative') return '地址列是相对于当前起始地址的偏移，0 表示第一个寄存器；保留当前起始地址与读取数量。';
  if (mode.value === 'absolute') return '地址列是设备实际协议地址（0–65535）；确认时自动计算起始地址、读取数量与各点相对偏移。';
  return '仅适用已确认采用五位编号的设备手册：FC3 的 40001 对应协议地址 0，FC4 的 30001 对应协议地址 0。其他编号规则请换算为零基协议地址。';
});

// A changed input or read configuration requires a new explicit preview before replacing points.
watch([text, mode], () => { preview.value = null; applied.value = ''; }, { flush: 'sync' });
watch(() => [props.values, props.schema], () => { preview.value = null; }, { deep: true, flush: 'sync' });

function setMode(value: ModbusImportMode) { mode.value = value; }
function fillExample() {
  const base = mode.value === 'manual' ? (props.values.registerType === 'InputRegister' ? 30001 : 40001) : 0;
  text.value = `地址\t属性编码\t数据类型\t倍率\t偏移\t服务编码\n${base}\ttemperature\tint16be\t0.1\t0\t\n${base + 1}\tpressure\tuint16be\t0.01\t0\t`;
}
function inspect() {
  if (props.disabled) return;
  applied.value = '';
  preview.value = previewModbusPointImport(text.value, mode.value, props.values, props.schema);
}
function apply() {
  if (props.disabled || !canApply.value || !preview.value) return;
  const count = preview.value.rows.length;
  const updated = applyModbusPointImport(props.values, preview.value);
  preview.value = null;
  emit('update:values', updated);
  applied.value = `已替换为 ${count} 个点位。请核对下方点位、服务与属性映射，再预览流程。`;
}
</script>

<template>
  <details class="point-import">
    <summary>从 Excel / CSV 导入点表</summary>
    <div class="import-body">
      <p class="hint">复制 Excel 或 CSV 点表，包含表头。原五列继续可用，可增加“服务编码”列。最多 {{ maxPoints }} 个点位；先预览，确认后替换当前点表。</p>
      <NFormItem label="点表中的地址如何解释" class="mode-field">
        <div class="field-content">
          <NSelect :value="mode" :options="modes" :disabled="disabled"
            aria-label="点表地址解释方式" @update:value="setMode" />
          <p class="hint">{{ modeHint }}</p>
        </div>
      </NFormItem>
      <NFormItem label="粘贴点表" class="text-field">
        <div class="field-content">
          <NInput v-model:value="text" type="textarea" :disabled="disabled"
            :input-props="{ 'aria-label': '粘贴 Modbus 点表' }" :autosize="{ minRows: 5, maxRows: 9 }"
            placeholder="source,property,dataType,scale,offset&#10;0,temperature,int16be,0.1,0&#10;1,pressure,uint16be,0.01,0" />
          <p class="hint">地址（source）、属性编码（property）、数据类型（dataType）、倍率（scale）、偏移（offset）为必需列，可加服务编码（serviceCode），顺序不限。服务留空继承默认服务；倍率和偏移留空为 1 和 0。</p>
        </div>
      </NFormItem>
      <details class="type-reference">
        <summary>可用数据类型与换算规则</summary>
        <p class="hint">{{ MODBUS_IMPORT_TYPES.join('、') }}</p>
        <p class="hint">16 位占 1 个寄存器，32 位占 2 个。上报值 = 解码值 × 倍率 + 偏移。字节序按设备手册填写，不能仅根据地址判断。</p>
      </details>
      <div class="actions">
        <NButton size="small" :disabled="disabled" @click="fillExample">填入示例点表</NButton>
        <NButton size="small" type="primary" secondary :disabled="disabled || !text.trim()" @click="inspect">预览导入</NButton>
      </div>
      <NAlert v-if="preview?.issues.length" type="error" :bordered="false" class="result" title="点表尚不能导入">
        <ul><li v-for="(issue, index) in preview.issues" :key="index">{{ issue }}</li></ul>
        <p>修正文本或读取配置后，重新预览。当前点表已保留。</p>
      </NAlert>
      <template v-if="preview?.rows.length">
        <p class="preview-heading">{{ canApply ? '导入预览' : '已解析的有效行（仍需修正以上问题）' }} · {{ preview.rows.length }} 个点位</p>
        <div class="preview-table" role="region" aria-label="点表导入预览" tabindex="0">
          <NTable size="small" :single-line="false">
            <thead><tr><th>文本行</th><th>服务</th><th>输入地址</th><th>协议地址</th><th>相对偏移</th><th>属性编码</th><th>数据类型</th><th>倍率</th><th>偏移</th></tr></thead>
            <tbody><tr v-for="{ value: row } in visible.items" :key="row.line">
              <td>{{ row.line }}</td><td>{{ row.point.serviceCode || values.serviceCode || '待配置默认服务' }}</td><td>{{ row.enteredAddress }}</td><td>{{ row.protocolAddress }}</td>
              <td>{{ row.point.source }}</td><td>{{ row.point.property }}</td><td>{{ row.point.dataType }}</td>
              <td>{{ row.point.scale }}</td><td>{{ row.point.offset }}</td>
            </tr></tbody>
          </NTable>
        </div>
        <div v-if="visible.pageCount > 1" class="pagination">
          <span class="hint">第 {{ visible.start + 1 }}–{{ visible.end }} 个，共 {{ preview.rows.length }} 个</span>
          <NPagination v-model:page="page" :page-count="visible.pageCount" :page-slot="5" size="small" aria-label="Modbus 点表导入预览分页" />
        </div>
      </template>
      <div v-if="canApply && preview" class="confirm-import">
        <p>将替换当前 {{ existingCount }} 个点位。{{ mode === 'relative' ? '保留' : '设置' }}起始地址为 <b>{{ preview.address }}</b>，读取范围共 <b>{{ preview.quantity }}</b> 个寄存器。</p>
        <p v-if="batches > 1" class="hint">将自动分为 {{ batches }} 批顺序读取，每批最多 {{ MODBUS_READ_BATCH_SIZE }} 个寄存器。全部成功后再合并换算上报；多个批次并非设备同一时刻的原子快照。</p>
        <NAlert v-if="preview.unusedRegisters > 0" type="warning" :bordered="false" class="result">
          读取区间内有 {{ preview.unusedRegisters }} 个未映射的寄存器。请确认设备允许完整区间连续读取；遇到不支持的地址，应拆成多个流程。
        </NAlert>
        <NButton size="small" type="primary" :disabled="disabled" @click="apply">确认替换 {{ preview.rows.length }} 个点位</NButton>
      </div>
      <NAlert v-if="applied" type="success" :bordered="false" class="result">{{ applied }}</NAlert>
    </div>
  </details>
</template>

<style scoped>
.point-import { min-width: 0; border: 1px solid var(--border); border-radius: var(--rs); margin-bottom: 16px; }
.point-import > summary { padding: 12px; cursor: pointer; font-weight: 600; }
.import-body { padding: 0 12px 12px; min-width: 0; }
.field-content { min-width: 0; width: 100%; }
.hint { color: var(--text-2); font-size: 12px; margin: 6px 0 12px; overflow-wrap: anywhere; }
.mode-field, .text-field { margin-bottom: 0; }
.type-reference { font-size: 12px; margin-bottom: 12px; }
.type-reference summary { cursor: pointer; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.result { margin-top: 12px; overflow-wrap: anywhere; }
.result ul { margin: 0; padding-left: 20px; }
.result p { margin: 8px 0 0; }
.preview-heading { font-weight: 600; margin: 16px 0 8px; }
.preview-table { width: 100%; overflow-x: auto; max-height: 320px; }
.preview-table table { min-width: 720px; }
.preview-table th, .preview-table td { white-space: nowrap; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 12px 0; }
.confirm-import { margin-top: 12px; }
.confirm-import p { margin: 0 0 12px; }
.confirm-import .result { margin-bottom: 12px; }
@media (max-width: 560px) {
  .import-body { padding: 0 8px 12px; }
  .actions > * { flex: 1 1 auto; }
}
</style>
