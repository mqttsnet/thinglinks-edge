<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { NCard, NForm, NFormItem, NInput, NButton, NAlert, useMessage } from 'naive-ui';
import { api, ApiError } from '../../api/client';

const router = useRouter();
const route = useRoute();
const message = useMessage();

const username = ref('admin');
const password = ref('');
const busy = ref(false);

/** 首次登录必须改密，改完才放行 */
const mustChange = ref(route.query['mustChange'] === '1');
const oldPassword = ref('');
const newPassword = ref('');
const newPassword2 = ref('');

onMounted(async () => {
  try {
    const { user } = await api.me();
    if (user.mustChangePassword) mustChange.value = true;
    else await router.replace('/instances');
  } catch { /* 未登录，停在登录页 */ }
});

async function signIn() {
  busy.value = true;
  try {
    const { user } = await api.login(username.value, password.value);
    if (user.mustChangePassword) {
      mustChange.value = true;
      oldPassword.value = password.value;
      message.warning('首次登录，请先修改初始口令');
    } else {
      await router.replace('/instances');
    }
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '登录失败');
  } finally {
    busy.value = false;
  }
}

async function submitChange() {
  if (newPassword.value !== newPassword2.value) {
    message.error('两次输入的新口令不一致');
    return;
  }
  busy.value = true;
  try {
    await api.changePassword(oldPassword.value, newPassword.value);
    // 后端改密后会踢下线，需重新登录
    mustChange.value = false;
    password.value = '';
    message.success('口令已修改，请用新口令登录');
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '修改失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <NCard class="card" :bordered="false">
      <div class="brand">
        <span class="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round">
            <circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="6.5" r="2.4" /><circle cx="18" cy="17.5" r="2.4" />
            <path d="M8.4 11 15.6 7.2M8.4 13l7.2 3.8" />
          </svg>
        </span>
        <div>
          <h1>ThingLinks Edge</h1>
          <span class="sub">边缘计算网关 · 控制台</span>
        </div>
      </div>

      <template v-if="!mustChange">
        <NForm class="form" @submit.prevent="signIn">
          <NFormItem label="用户名"><NInput v-model:value="username" placeholder="admin" /></NFormItem>
          <NFormItem label="口令">
            <NInput v-model:value="password" type="password" show-password-on="click"
                    placeholder="初始口令见首次启动日志" @keyup.enter="signIn" />
          </NFormItem>
          <NButton type="primary" block :loading="busy" @click="signIn">登录</NButton>
        </NForm>
      </template>

      <template v-else>
        <NAlert type="warning" :bordered="false" style="margin: 16px 0">
          首次登录需修改初始口令后才能使用其它功能。
        </NAlert>
        <NForm class="form" @submit.prevent="submitChange">
          <NFormItem label="原口令"><NInput v-model:value="oldPassword" type="password" /></NFormItem>
          <NFormItem label="新口令">
            <NInput v-model:value="newPassword" type="password" placeholder="至少 12 位" />
          </NFormItem>
          <NFormItem label="确认新口令"><NInput v-model:value="newPassword2" type="password" /></NFormItem>
          <NButton type="primary" block :loading="busy" @click="submitChange">修改并继续</NButton>
        </NForm>
      </template>

      <p class="copy">Copyright © 2024-present mqttsnet All Rights Reserved.</p>
    </NCard>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background: radial-gradient(1100px 500px at 15% -5%, var(--l-primary), transparent 60%), var(--bg);
}
.card { width: 100%; max-width: 404px; border-radius: var(--r); box-shadow: var(--shadow); }
.brand { display: flex; align-items: center; gap: 12px; }
.logo {
  width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; flex: none;
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  box-shadow: 0 6px 16px rgba(var(--primary-glow), .32);
}
.logo svg { width: 21px; height: 21px; }
.brand h1 { margin: 0; font-size: 18px; font-weight: 650; }
.brand .sub { font-size: 11.5px; color: var(--muted); }
.form { margin-top: 20px; }
.copy { text-align: center; margin: 22px 0 0; font-size: 11px; color: var(--muted); }
</style>
