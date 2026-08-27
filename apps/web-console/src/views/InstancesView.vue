<script setup lang="ts">
import { ref, onMounted, onUnmounted, h } from 'vue';
import {
  NButton, NCard, NTag, NProgress, NModal, NForm, NFormItem, NInput,
  NInputNumber, NSelect, NSpace, NSpin, NEmpty, NAlert, NCheckbox,
  useMessage, useDialog,
} from 'naive-ui';
import { api, ApiError } from '../api/client';
import type { Instance } from '../api/types';

const message = useMessage();
const dialog = useDialog();

const instances = ref<Instance[]>([]);
const loading = ref(true);
let timer: number | undefined;

async function refresh(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    instances.value = (await api.instances()).instances;
  } catch (e) {
    if (!quiet) message.error(e instanceof ApiError ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(true), 5000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });

// ── 新建 ────────────────────────────────────────────────

const showCreate = ref(false);
const creating = ref(false);
const IMAGE_TAGS = [
  { label: '5.0.4-24-minimal（推荐）', value: '5.0.4-24-minimal' },
  { label: '4.1.13-22-minimal', value: '4.1.13-22-minimal' },
];
const form = ref({
  id: '', name: '', imageTag: '5.0.4-24-minimal',
  memoryMb: 512, cpus: 0.5, portSpec: '', containerPort: 1883, purpose: '',
});
const recommended = ref('');

async function openCreate() {
  form.value = { id: '', name: '', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
                 portSpec: '', containerPort: 1883, purpose: '' };
  showCreate.value = true;
  try {
    recommended.value = (await api.recommendPorts(2)).recommended;
  } catch { recommended.value = ''; }
}

async function submitCreate() {
  creating.value = true;
  try {
    await api.createInstance({
      id: form.value.id.trim(),
      name: form.value.name.trim(),
      imageTag: form.value.imageTag,
      memoryMb: form.value.memoryMb,
      cpus: form.value.cpus,
      portSpec: form.value.portSpec.trim(),
      ...(form.value.portSpec.trim() ? { containerPort: form.value.containerPort } : {}),
      ...(form.value.purpose.trim() ? { purpose: form.value.purpose.trim() } : {}),
    });
    showCreate.value = false;
    message.success('实例已创建，正在拉起容器');
    await refresh();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '创建失败');
  } finally {
    creating.value = false;
  }
}

// ── 操作 ────────────────────────────────────────────────

async function act(fn: () => Promise<void>, ok: string) {
  try { await fn(); message.success(ok); await refresh(); }
  catch (e) { message.error(e instanceof ApiError ? e.message : '操作失败'); }
}

function confirmRemove(inst: Instance) {
  const removeData = ref(false);
  dialog.warning({
    title: `删除实例 · ${inst.name}`,
    content: () => h('div', [
      h('p', `将停止并移除容器，释放 ${inst.ports.length} 个端口。此操作不可撤销。`),
      h(NCheckbox, {
        checked: removeData.value,
        'onUpdate:checked': (v: boolean) => { removeData.value = v; },
      }, { default: () => '同时删除数据卷（流程与凭据将永久丢失）' }),
    ]),
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => act(() => api.removeInstance(inst.id, removeData.value), '实例已删除'),
  });
}

function resetPassword(inst: Instance) {
  dialog.info({
    title: `重置口令 · ${inst.id}`,
    content: '重置后实例将重启以使新口令生效，正在运行的流程会中断数秒。',
    positiveText: '重置', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const { password } = await api.resetCredential(inst.id, 'admin');
        dialog.success({
          title: '新口令（仅此一次可见）',
          content: () => h('code', { class: 'mono', style: 'word-break:break-all' }, password),
          positiveText: '我已记录',
        });
        await refresh();
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '重置失败');
      }
    },
  });
}

const stateTag = (i: Instance) =>
  i.running ? { type: 'success' as const, text: '运行中' }
  : i.state === 'exited' ? { type: 'error' as const, text: '已停止' }
  : i.state === 'missing' ? { type: 'warning' as const, text: '容器缺失' }
  : { type: 'default' as const, text: i.state };
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>实例</h2>
        <p class="sub">「打开编辑器」直接进入，无需再输实例口令</p>
      </div>
      <div class="spacer" />
      <NButton type="primary" @click="openCreate">+ 新建实例</NButton>
    </div>

    <NSpin :show="loading">
      <NEmpty v-if="!loading && instances.length === 0" description="还没有实例" style="padding: 60px 0">
        <template #extra><NButton size="small" @click="openCreate">创建第一个实例</NButton></template>
      </NEmpty>

      <div v-else class="grid">
        <NCard v-for="i in instances" :key="i.id" class="item" :bordered="false">
          <div class="head">
            <div class="min">
              <div class="nm">{{ i.name }}</div>
              <div class="id mono">{{ i.id }}</div>
            </div>
            <NTag :type="stateTag(i).type" size="small" round>{{ stateTag(i).text }}</NTag>
          </div>

          <div class="rows">
            <div class="r"><span class="lb">版本</span><NTag size="small" :bordered="false">{{ i.imageTag }}</NTag></div>
            <div class="r"><span class="lb">配额</span>
              <span class="num">{{ i.memLimit }} MB · {{ i.cpuLimit }} 核</span></div>
            <div class="r"><span class="lb">端口</span>
              <span v-if="i.ports.length" class="ports">
                <NTag v-for="p in i.ports" :key="p.hostPort" size="tiny" :bordered="false" class="mono">
                  {{ p.hostPort }}→{{ p.containerPort }}
                </NTag>
              </span>
              <span v-else class="muted">无</span>
            </div>
            <div class="r"><span class="lb">访问路径</span><span class="mono sm">{{ i.adminRoot }}</span></div>
          </div>

          <div class="foot">
            <NButton v-if="!i.running" size="small" @click="act(() => api.startInstance(i.id), '已启动')">启动</NButton>
            <NButton v-else size="small" @click="act(() => api.stopInstance(i.id), '已停止')">停止</NButton>
            <NButton size="small" type="primary" :disabled="!i.running"
                     tag="a" :href="i.openUrl" target="_blank">打开编辑器</NButton>
            <NButton size="small" @click="resetPassword(i)">重置口令</NButton>
            <NButton size="small" quaternary type="error" @click="confirmRemove(i)">删除</NButton>
          </div>
        </NCard>
      </div>
    </NSpin>

    <NModal v-model:show="showCreate" preset="card" title="新建实例" style="max-width: 560px">
      <NForm label-placement="top">
        <NSpace :size="14">
          <NFormItem label="实例 ID" style="flex:1">
            <NInput v-model:value="form.id" placeholder="line-a" class="mono" />
          </NFormItem>
          <NFormItem label="名称" style="flex:1">
            <NInput v-model:value="form.name" placeholder="一号产线" />
          </NFormItem>
        </NSpace>
        <NFormItem label="Node-RED 版本">
          <NSelect v-model:value="form.imageTag" :options="IMAGE_TAGS" />
        </NFormItem>
        <NSpace :size="14">
          <NFormItem label="内存上限（MB）" style="flex:1">
            <NInputNumber v-model:value="form.memoryMb" :min="64" :step="128" style="width:100%" />
          </NFormItem>
          <NFormItem label="CPU 配额（核）" style="flex:1">
            <NInputNumber v-model:value="form.cpus" :min="0.1" :step="0.1" style="width:100%" />
          </NFormItem>
        </NSpace>
        <NFormItem label="宿主端口映射">
          <NSpace vertical style="width:100%">
            <NSpace>
              <NInput v-model:value="form.portSpec" placeholder="留空表示不映射" class="mono" style="flex:1" />
              <NButton v-if="recommended" tertiary @click="form.portSpec = recommended">
                用推荐值 {{ recommended }}
              </NButton>
            </NSpace>
            <span class="hint">
              支持区间 <code class="mono">30101-30120</code>、单个 <code class="mono">30101</code>、
              组合 <code class="mono">30101-30110,30150</code>。
              HTTP 类节点走统一入口，不占宿主端口。
            </span>
          </NSpace>
        </NFormItem>
        <NSpace v-if="form.portSpec.trim()" :size="14">
          <NFormItem label="起始容器端口" style="flex:1">
            <NInputNumber v-model:value="form.containerPort" :min="1" :max="65535" style="width:100%" />
          </NFormItem>
          <NFormItem label="用途备注" style="flex:1">
            <NInput v-model:value="form.purpose" placeholder="MQTT broker 节点" />
          </NFormItem>
        </NSpace>
        <NAlert type="info" :bordered="false" style="margin-top:4px">
          实例账号由管理台自动创建，口令加密存储；创建后可在卡片上重置。
        </NAlert>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="submitCreate">创建</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; gap: 16px; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.spacer { margin-left: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.item { border-radius: var(--r); box-shadow: var(--shadow); }
.head { display: flex; align-items: flex-start; gap: 10px; }
.min { min-width: 0; flex: 1; }
.nm { font-size: 15px; font-weight: 600; }
.id { font-size: 11.5px; color: var(--muted); }
.rows { display: flex; flex-direction: column; gap: 9px; margin: 13px 0; }
.r { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.lb { color: var(--muted); }
.ports { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.muted { color: var(--muted); }
.sm { font-size: 11.5px; }
.foot { display: flex; gap: 7px; padding-top: 12px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--muted); line-height: 1.6; }
code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }
</style>
