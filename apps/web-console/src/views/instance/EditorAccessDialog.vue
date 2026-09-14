<script setup lang="ts">
import { ref, watch } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSpace } from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type { Instance } from '../../api/types';

const shown = ref(false);
const instance = ref<Instance>();
const password = ref('');
const error = ref('');
const busy = ref(false);

function open(value: Instance) {
  instance.value = value; password.value = ''; error.value = ''; shown.value = true;
}
watch(shown, value => { if (!value) password.value = ''; });

async function submit() {
  if (busy.value || !instance.value || !password.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api.unlockEditor(instance.value.id, password.value);
    password.value = '';
    window.location.assign(result.editorUrl);
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : '暂时无法打开编辑器，请重试';
  } finally { busy.value = false; }
}
defineExpose({ open });
</script>

<template>
  <NModal v-model:show="shown" preset="card" title="验证编辑器口令" style="max-width: 440px"
    :mask-closable="!busy" :closable="!busy">
    <p>即将进入「{{ instance?.name }}」。请输入创建该实例时设置的编辑器口令。</p>
    <NAlert v-if="error" type="error" style="margin-bottom: 16px">{{ error }}</NAlert>
    <NForm @submit.prevent="submit">
      <NFormItem label="编辑器口令" required>
        <NInput v-model:value="password" type="password" show-password-on="click" autofocus
          autocomplete="current-password" :disabled="busy" placeholder="输入该实例的独立口令" />
      </NFormItem>
      <p class="help">验证不扩大账号权限；忘记口令时，请由有权限的人员在实例菜单中重置。</p>
      <NSpace justify="end">
        <NButton :disabled="busy" @click="shown = false">取消</NButton>
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!password">验证并进入</NButton>
      </NSpace>
    </NForm>
  </NModal>
</template>

<style scoped>
.help { font-size: 12px; color: var(--text-muted, #777); margin: 0 0 20px; }
</style>
