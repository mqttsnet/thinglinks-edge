<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NSpace, useDialog, useMessage,
} from 'naive-ui';
import { api, ApiError, basePath } from '../../api/client';
import type { DeviceHttpBinding, Instance } from '../../api/types';
import { deviceIngressUrl, validateDeviceHttpForm, type DeviceHttpForm } from './device-http-config';

const shown = ref(false);
const instance = ref<Instance>();
const bindings = ref<DeviceHttpBinding[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const oneTimeSecret = ref('');
const secretBinding = ref('');
const form = ref<DeviceHttpForm>({ id: '', targetPath: '', deviceId: '', maxBodyBytes: 1048576, rateLimitPerMinute: 60 });
let viewGeneration = 0;
const ingressUrl = (id: string) => deviceIngressUrl(id, basePath, window.location.origin);
const message = useMessage();
const dialog = useDialog();

function resetForm(value: Instance) {
  form.value = {
    id: '',
    targetPath: `${value.adminRoot.replace(/\/$/, '')}/api/telemetry`,
    deviceId: '', maxBodyBytes: 1048576, rateLimitPerMinute: 60,
  };
}

async function load() {
  if (!instance.value) return;
  const target = instance.value.id; const generation = viewGeneration;
  loading.value = true; error.value = '';
  try { const result = await api.deviceHttpBindings(target); if (generation === viewGeneration) bindings.value = result.bindings; }
  catch (e) { if (generation === viewGeneration) error.value = e instanceof ApiError ? e.message : '读取设备入口失败'; }
  finally { if (generation === viewGeneration) loading.value = false; }
}

async function create() {
  if (!instance.value || saving.value) return;
  const target = instance.value; const generation = viewGeneration;
  error.value = validateDeviceHttpForm(form.value, target.adminRoot);
  if (error.value) return;
  if (oneTimeSecret.value) { error.value = '请先保存当前密钥，并点击“我已保存”'; return; }
  saving.value = true; error.value = ''; oneTimeSecret.value = '';
  try {
    const result = await api.createDeviceHttpBinding(target.id, {
      id: form.value.id.trim(), targetPath: form.value.targetPath.trim(), deviceId: form.value.deviceId.trim(),
      maxBodyBytes: form.value.maxBodyBytes!, rateLimitPerMinute: form.value.rateLimitPerMinute!,
    });
    if (generation !== viewGeneration) return;
    oneTimeSecret.value = result.secret;
    secretBinding.value = result.binding.id;
    message.success('设备入口已创建');
    resetForm(target);
    await load();
  } catch (e) { error.value = e instanceof ApiError ? e.message : '创建设备入口失败'; }
  finally { saving.value = false; }
}

function rotate(binding: DeviceHttpBinding) {
  if (!instance.value || saving.value || oneTimeSecret.value) return;
  const target = instance.value.id; const generation = viewGeneration;
  dialog.warning({
    title: `轮换设备密钥 · ${binding.deviceId}`,
    content: '旧密钥会立即失效。确认设备已经可以接收新密钥后再继续。',
    positiveText: '轮换', negativeText: '取消',
    onPositiveClick: async () => {
      if (generation !== viewGeneration || !shown.value) return;
      if (saving.value || oneTimeSecret.value) return false;
      saving.value = true;
      try {
        const result = await api.rotateDeviceHttpBinding(target, binding.id);
        if (generation !== viewGeneration) return;
        oneTimeSecret.value = result.secret;
        secretBinding.value = binding.id;
        message.success('密钥已轮换，请立即更新设备');
      } catch (e) { error.value = e instanceof ApiError ? e.message : '密钥轮换失败'; }
      finally { saving.value = false; }
    },
  });
}

function remove(binding: DeviceHttpBinding) {
  if (!instance.value || saving.value || oneTimeSecret.value) return;
  const target = instance.value.id; const generation = viewGeneration;
  dialog.warning({
    title: `删除设备入口 · ${binding.deviceId}`,
    content: '删除后该入口立即失效，设备请求会返回 404。',
    positiveText: '删除', negativeText: '取消',
    onPositiveClick: async () => {
      if (generation !== viewGeneration || !shown.value) return;
      if (saving.value || oneTimeSecret.value) return false;
      saving.value = true;
      try {
        await api.deleteDeviceHttpBinding(target, binding.id);
        if (generation !== viewGeneration) return;
        bindings.value = bindings.value.filter(item => item.id !== binding.id);
        message.success('设备入口已删除');
      } catch (e) { error.value = e instanceof ApiError ? e.message : '删除设备入口失败'; }
      finally { saving.value = false; }
    },
  });
}

function revalidate(binding: DeviceHttpBinding) {
  if (!instance.value || saving.value || oneTimeSecret.value) return;
  const target = instance.value.id; const generation = viewGeneration;
  dialog.warning({
    title: `确认当前流程 · ${binding.deviceId}`,
    content: '请先确认当前流程的采集与映射正确。Edge 将重新核对同一设备和接收路径，保持现有密钥，设备端无需改密钥。',
    positiveText: '检查并确认', negativeText: '取消',
    onPositiveClick: async () => {
      if (generation !== viewGeneration || !shown.value) return;
      if (saving.value || oneTimeSecret.value) return false;
      saving.value = true;
      try {
        await api.revalidateDeviceHttpBinding(target, binding.id);
        message.success('当前流程已确认，设备可继续使用原密钥');
        await load();
      } catch (e) { error.value = e instanceof ApiError ? e.message : '确认流程失败'; }
      finally { saving.value = false; }
    },
  });
}

async function open(value: Instance) {
  if (saving.value) return;
  viewGeneration++; bindings.value = []; oneTimeSecret.value = ''; secretBinding.value = '';
  instance.value = value; resetForm(value); shown.value = true; await load();
}
watch(shown, value => { if (!value) { viewGeneration++; oneTimeSecret.value = ''; secretBinding.value = ''; error.value = ''; } });
defineExpose({ open });
</script>

<template>
  <NModal v-model:show="shown" preset="card" title="设备 HTTP 接入" style="width: min(760px, calc(100vw - 32px))"
    :closable="!saving && !oneTimeSecret" :mask-closable="!saving && !oneTimeSecret" :close-on-esc="!saving && !oneTimeSecret">
    <p class="intro">为「{{ instance?.name }}」配置带签名的 POST JSON 入口。设备需支持 HMAC-SHA256；流程仍负责解析、设备和物模型映射。</p>
    <p class="intro">请先部署 HTTP 推送采集模板，再填写模板中的子设备标识和完整路径。重新部署流程后，点击“确认当前流程”重新检查映射，设备继续使用原密钥。</p>
    <NAlert v-if="instance && !instance.running" type="info" :bordered="false" style="margin-bottom: 12px">实例当前已停止，可以先配置入口；启动实例并部署对应流程后才能接收数据。</NAlert>
    <NAlert v-if="error" type="error" :bordered="false" style="margin-bottom: 12px">{{ error }}</NAlert>
    <NAlert v-if="oneTimeSecret" type="warning" :bordered="false" style="margin-bottom: 12px">
      <div>绑定 {{ secretBinding }} 的密钥仅此一次显示。请保存到设备配置，勿分享截图：</div>
      <code class="secret">{{ oneTimeSecret }}</code>
      <NButton size="small" style="margin-top: 8px" @click="oneTimeSecret = ''; secretBinding = ''">我已保存</NButton>
    </NAlert>
    <div class="bindings" :class="{ muted: loading }">
      <div v-if="loading" role="status">正在读取设备入口…</div>
      <div v-else-if="!bindings.length && !error">还没有设备入口。</div>
      <div v-for="binding in bindings" :key="binding.id" class="binding">
        <div class="binding-main">
          <b>{{ binding.deviceId }}</b><span class="mono">{{ binding.id }}</span>
          <span v-if="binding.requiresRebind" class="rebind">旧入口待重新绑定</span>
          <span class="muted">{{ binding.targetPath }}</span>
          <span class="endpoint">设备请求地址：<code>{{ ingressUrl(binding.id) }}</code></span>
          <span class="muted">{{ binding.rateLimitPerMinute }}/分钟 · {{ Math.round(binding.maxBodyBytes / 1024) }} KiB</span>
        </div>
        <NSpace :size="4">
          <NButton size="small" :disabled="saving || !!oneTimeSecret" @click="revalidate(binding)">确认当前流程</NButton>
          <NButton size="small" :disabled="saving || !!oneTimeSecret" @click="rotate(binding)">轮换密钥</NButton>
          <NButton size="small" quaternary type="error" :disabled="saving || !!oneTimeSecret" @click="remove(binding)">删除</NButton>
        </NSpace>
      </div>
    </div>
    <NForm label-placement="top" class="form" :disabled="saving || !!oneTimeSecret" @submit.prevent="create">
      <div class="two-columns">
        <NFormItem label="绑定 ID" required><NInput v-model:value="form.id" placeholder="meter-a" aria-label="绑定 ID" /></NFormItem>
        <NFormItem label="设备 ID" required><NInput v-model:value="form.deviceId" placeholder="meter-a" aria-label="设备 ID" /></NFormItem>
      </div>
      <NFormItem label="Node-RED 流程路径" required>
        <NInput v-model:value="form.targetPath" class="mono" aria-label="Node-RED 流程路径" :placeholder="`${instance?.adminRoot}api/telemetry`" />
        <template #feedback>与 HTTP 推送模板中的路径保持一致。例如模板填 /telemetry，此处填 {{ instance?.adminRoot }}api/telemetry。</template>
      </NFormItem>
      <div class="two-columns">
        <NFormItem label="请求体上限（字节）" style="flex:1"><NInputNumber v-model:value="form.maxBodyBytes" :min="1024" :max="8388608" style="width:100%" /></NFormItem>
        <NFormItem label="每分钟请求上限" style="flex:1"><NInputNumber v-model:value="form.rateLimitPerMinute" :min="1" :max="6000" style="width:100%" /></NFormItem>
      </div>
    </NForm>
    <details class="guide"><summary>设备如何签名上报</summary>
      <p>发送 POST JSON，三个请求头为 X-ThingLinks-Timestamp（Unix 秒）、X-ThingLinks-Nonce（本次随机值，16–128 位字母数字或 _-）、X-ThingLinks-Signature（HMAC-SHA256 十六进制）。时间偏差不超过 5 分钟。</p>
      <p>使用绑定密钥，将下面 7 个字段以换行符拼接后计算 HMAC。请求体摘要必须按实际发送的 UTF-8 字节计算，空格也参与签名。</p>
      <pre>POST\n完整入口路径（不含域名）\n绑定 ID\n设备 ID\n时间戳\nnonce\n请求体 SHA-256 十六进制摘要</pre>
      <p>重复 nonce 会被拒绝。若超时，先核对接收结果；不要把换 nonce 重发当作幂等重试。通过外部网络访问时请配置 HTTPS。</p>
    </details>
    <template #footer><NSpace justify="end"><NButton :disabled="saving || !!oneTimeSecret" @click="shown = false">关闭</NButton><NButton type="primary" :loading="saving" :disabled="loading || !!oneTimeSecret" @click="create">创建绑定</NButton></NSpace></template>
  </NModal>
</template>

<style scoped>
.intro { margin: 0 0 14px; color: var(--text-2); line-height: 1.6; }
.bindings { min-height: 46px; margin: 0 0 18px; border: 1px solid var(--border); border-radius: var(--rs); padding: 8px 10px; }
.binding { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.binding:last-child { border-bottom: 0; }
.binding-main { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; flex-wrap: wrap; }
.binding-main .muted { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.rebind { color: var(--warning); }
.secret { display: block; margin-top: 6px; word-break: break-all; user-select: all; }
.form { border-top: 1px solid var(--border); padding-top: 14px; }
.mono :deep(input) { font-family: var(--mono); }
.two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.endpoint { flex-basis: 100%; overflow-wrap: anywhere; user-select: text; }
.guide { font-size: 12px; line-height: 1.6; }
.guide summary { cursor: pointer; color: var(--primary); }
.guide pre { white-space: pre-wrap; }
@media (max-width: 520px) { .two-columns { grid-template-columns: 1fr; gap: 0; } }
</style>
