<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch, ref } from 'vue';
import { NAlert, NButton, NTable, NTag, NPagination } from 'naive-ui';
import { api } from '../../../../api/client';
import type { ProtocolDiagnosticTask } from '../../../../api/types';
import { createModbusReadSession, diagnosticRunning, type ModbusReadState } from './read-session';
import { modbusReadConnection, previewRegisterPoints, sameReadConnection } from './read-model';

import { paginateRows } from '../../components/table-pagination';
import { MODBUS_READ_BATCH_SIZE } from './read-limits';

const props = defineProps<{ instanceId: string; values: Record<string, unknown>; canRead: boolean; ready: boolean; disabled?: boolean }>();
const emit = defineEmits<{ activeChange: [active: boolean]; 'update:values': [values: Record<string, unknown>] }>();
const state = shallowRef<ModbusReadState>({ task: null, pending: false, error: '' });
const session = createModbusReadSession({
  start: async (id, connection) => (await api.startModbusDiagnostic(id, connection, AbortSignal.timeout(20000))).task,
  get: async (id, task) => (await api.protocolDiagnostic(id, task, AbortSignal.timeout(8000))).task,
  list: async id => (await api.protocolDiagnostics(id, AbortSignal.timeout(8000))).tasks,
  cancel: async (id, task) => (await api.cancelProtocolDiagnostic(id, task, AbortSignal.timeout(15000))).task,
}, value => { state.value = value; });
const configuration = computed(() => modbusReadConnection(props.values));
const task = computed(() => state.value.task);
const pendingCleanup = computed(() => Boolean(task.value && task.value.cleanup !== 'done'));
const reading = computed(() => state.value.pending || diagnosticRunning(task.value));
const stale = computed(() => Boolean(task.value && !sameReadConnection({ ...task.value.connection }, props.values)));
const mapped = computed(() => task.value?.result && !stale.value ? previewRegisterPoints(task.value.result.registers, props.values.points,
  typeof props.values.serviceCode === 'string' ? props.values.serviceCode : '') : []);
const registerPage = ref(1), pointPage = ref(1);
const visibleRegisters = computed(() => paginateRows(task.value?.result?.registers ?? [], registerPage.value));
const visiblePoints = computed(() => paginateRows(mapped.value, pointPage.value));
const batchCount = computed(() => Math.ceil((configuration.value.connection?.quantity ?? 0) / MODBUS_READ_BATCH_SIZE));
watch(() => task.value?.id, () => { registerPage.value = 1; pointPage.value = 1; });
watch(() => mapped.value.length, () => { pointPage.value = visiblePoints.value.page; });
const canStart = computed(() => props.canRead && props.ready && Boolean(configuration.value.connection)
  && !props.disabled && !reading.value && !pendingCleanup.value);
const labels: Record<ProtocolDiagnosticTask['state'], string> = {
  preparing: '准备试读', connecting: '等待设备连接', reading: '读取与清理中', succeeded: '试读成功',
  failed: '试读失败', cancelled: '试读已取消', 'cleanup-required': '需要清理临时连接',
};
watch(() => [props.instanceId, props.canRead] as const, ([id, allowed]) => { void session.select(allowed ? id : ''); }, { immediate: true });
watch([reading, () => state.value.error], () => emit('activeChange', reading.value && !state.value.error), { immediate: true });
onBeforeUnmount(() => { session.dispose(); emit('activeChange', false); });
function start() { if (canStart.value && configuration.value.connection) void session.start(configuration.value.connection); }
function reuseConnection() {
  if (task.value && !props.disabled && task.value.cleanup === 'done') emit('update:values', { ...props.values, ...task.value.connection });
}
</script>

<template>
  <section class="read-panel" aria-label="Modbus 单次试读">
    <div class="read-heading"><h4>先试读设备</h4><NTag size="small" :bordered="false">只读 · FC3 / FC4</NTag></div>
    <p class="hint">由所选实例完成一次真实试读任务，成功后清理临时连接。无需先填写云端设备和服务编码。</p>
    <p v-if="batchCount > 1" class="hint">本次试读包含 {{ batchCount }} 批顺序请求，每批最多 {{ MODBUS_READ_BATCH_SIZE }} 个寄存器；全部成功后显示完整结果。各批数据并非设备同一时刻的原子快照。</p>
    <p class="hint">试读会临时增加一个 TCP 连接。设备若只允许一个连接，请先安排现有采集释放连接。</p>
    <p v-if="!instanceId" class="hint">请先选择一个运行中的实例。</p>
    <p v-else-if="!canRead" class="hint">需要该实例的操作权限才能试读。</p>
    <p v-else-if="!ready" class="hint">请先在上方准备并检查 Modbus 组件。</p>
    <p v-else-if="configuration.issues.length" class="hint">{{ configuration.issues.join('；') }}</p>
    <div class="actions">
      <NButton type="primary" secondary :disabled="!canStart" :loading="state.pending && !task" @click="start">试读一次</NButton>
      <NButton v-if="instanceId && canRead" :disabled="state.pending || disabled" @click="session.refresh">刷新试读状态</NButton>
      <NButton v-if="pendingCleanup" :loading="state.pending" :disabled="state.pending || disabled" @click="session.cancel">
        {{ task?.cleanup === 'failed' ? '重试清理' : '取消试读' }}
      </NButton>
    </div>
    <NAlert v-if="state.error" type="warning" :bordered="false" class="notice">{{ state.error }}</NAlert>
    <template v-if="task">
      <NAlert :type="task.state === 'succeeded' ? 'success' : task.state === 'failed' || task.state === 'cleanup-required' ? 'warning' : 'info'"
        :bordered="false" class="notice" :title="labels[task.state]" aria-live="polite">
        {{ task.connection.host }}:{{ task.connection.port }} · 站号 {{ task.connection.unitId }} ·
        协议地址 {{ task.connection.address }}–{{ task.connection.address + task.connection.quantity - 1 }}
        <p v-if="task.error">{{ task.error.message }}</p>
        <p v-if="task.cleanup === 'failed'">临时连接尚未确认清理，可能继续尝试连接。请重试清理后再开始下一次试读。</p>
        <p v-else-if="task.cleanup === 'done'">临时连接已清理。</p>
      </NAlert>
      <NAlert v-if="stale" type="warning" :bordered="false" class="notice">
        连接参数或读取范围已改变，以下为上次试读结果。请重新试读，或明确使用上次的连接配置。
        <NButton v-if="task.cleanup === 'done'" size="small" text :disabled="disabled" @click="reuseConnection">使用上次连接配置</NButton>
      </NAlert>
      <template v-if="task.result">
        <p class="result-heading">读到 {{ task.result.registers.length }} 个寄存器 · {{ task.result.durationMs }} ms</p>
        <div class="sample-table" role="region" aria-label="实际寄存器值" tabindex="0">
          <NTable size="small"><thead><tr><th>协议地址</th><th>原始寄存器</th><th>十六进制</th></tr></thead>
            <tbody><tr v-for="{ value, index } in visibleRegisters.items" :key="index"><td>{{ task.connection.address + index }}</td><td>{{ value }}</td><td>{{ value.toString(16).toUpperCase().padStart(4, '0') }}</td></tr></tbody>
          </NTable>
        </div>
        <div v-if="visibleRegisters.pageCount > 1" class="pagination">
          <span class="hint">寄存器 {{ visibleRegisters.start + 1 }}–{{ visibleRegisters.end }} / {{ task.result.registers.length }}</span>
          <NPagination v-model:page="registerPage" :page-count="visibleRegisters.pageCount" :page-slot="5" size="small" aria-label="实际寄存器值分页" />
        </div>
        <div v-if="mapped.length" class="sample-table" role="region" aria-label="当前点表换算预览" tabindex="0">
          <NTable size="small"><thead><tr><th>属性编码</th><th>解码值</th><th>换算结果</th></tr></thead>
            <tbody><tr v-for="{ value: row, index } in visiblePoints.items" :key="index"><td>{{ row.serviceCode ? `${row.serviceCode} / ` : '' }}{{ row.property }}</td><td>{{ row.raw ?? '—' }}</td><td>{{ row.error || row.value }}</td></tr></tbody>
          </NTable>
        </div>
        <div v-if="visiblePoints.pageCount > 1" class="pagination">
          <span class="hint">点位 {{ visiblePoints.start + 1 }}–{{ visiblePoints.end }} / {{ mapped.length }}</span>
          <NPagination v-model:page="pointPage" :page-count="visiblePoints.pageCount" :page-slot="5" size="small" aria-label="点表换算预览分页" />
        </div>
        <p class="hint">按当前点表计算预览值。确认数据后，继续配置物模型并部署持续采集；云端接收情况需另行验证。</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.read-panel { margin: 12px 0 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--rs); }
.read-heading, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
h4 { margin: 0; font-size: 14px; }
.hint { color: var(--text-2); font-size: 12px; margin: 8px 0 12px; overflow-wrap: anywhere; }
.notice { margin-top: 12px; }
.notice p { margin: 8px 0 0; }
.result-heading { font-weight: 600; margin: 16px 0 8px; }
.sample-table { max-height: 240px; overflow: auto; margin-top: 12px; }
.sample-table table { min-width: 360px; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
.sample-table td { overflow-wrap: anywhere; }
</style>
