<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { NButton, useMessage } from 'naive-ui';
import { api } from '../api/client';

const router = useRouter();
const route = useRoute();
const message = useMessage();
const username = ref('');

/**
 * 窄屏降级为图标栏，绝不隐藏导航 ——
 * 隐藏等于让用户无法导航，原型阶段踩过这个坑。
 */
const collapsed = ref(localStorage.getItem('tle-side') === '1');
function toggleSide() {
  collapsed.value = !collapsed.value;
  localStorage.setItem('tle-side', collapsed.value ? '1' : '0');
}

const NAV = [
  { name: 'instances', title: '实例', icon: 'M3 5.2C3 4 5 3 8.5 3S14 4 14 5.2 12 7.4 8.5 7.4 3 6.4 3 5.2ZM3 5.2v9.6c0 1.2 2 2.2 5.5 2.2s5.5-1 5.5-2.2V5.2M3 10c0 1.2 2 2.2 5.5 2.2S14 11.2 14 10' },
  { name: 'health', title: '健康监测', icon: 'M2 9h3l2-5 3 10 2-5h3' },
];

onMounted(async () => {
  try { username.value = (await api.me()).user.username; } catch { /* 守卫已处理 */ }
});

async function signOut() {
  await api.logout().catch(() => undefined);
  message.success('已登出');
  await router.replace('/login');
}
</script>

<template>
  <div class="shell" :class="{ mini: collapsed }">
    <aside>
      <div class="head">
        <button class="collapse" :title="collapsed ? '展开导航' : '收起导航'" @click="toggleSide">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M12 5l-5 5 5 5" />
          </svg>
        </button>
        <span class="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round">
            <circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="6.5" r="2.4" /><circle cx="18" cy="17.5" r="2.4" />
            <path d="M8.4 11 15.6 7.2M8.4 13l7.2 3.8" />
          </svg>
        </span>
        <div class="name">
          <h1>ThingLinks Edge</h1>
          <span>边缘计算网关</span>
        </div>
      </div>

      <nav>
        <div class="lab">运行</div>
        <button v-for="n in NAV" :key="n.name" class="item" :class="{ on: route.name === n.name }"
                :title="n.title" @click="router.push({ name: n.name })">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round"><path :d="n.icon" /></svg>
          <span>{{ n.title }}</span>
        </button>
      </nav>

      <div class="foot">© 2024-present mqttsnet<br />All Rights Reserved.</div>
    </aside>

    <main>
      <header>
        <div class="spacer" />
        <span class="who mono">{{ username }}</span>
        <NButton size="small" quaternary @click="signOut">登出</NButton>
      </header>
      <div class="content"><RouterView /></div>
      <footer>Copyright © 2024-present mqttsnet All Rights Reserved.</footer>
    </main>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 242px 1fr; min-height: 100vh; }
aside {
  background: var(--sidebar); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
}
.head { padding: 15px 18px 8px; display: flex; align-items: center; gap: 12px; position: relative; }
.collapse {
  position: absolute; right: -11px; top: 22px; width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--surface); color: var(--muted);
  display: grid; place-items: center; cursor: pointer; padding: 0; z-index: 7; box-shadow: var(--shadow);
}
.collapse:hover { color: var(--primary); }
.collapse svg { width: 13px; height: 13px; transition: transform .2s; }
.mini .collapse svg { transform: rotate(180deg); }
.logo {
  width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none;
  background: linear-gradient(135deg, var(--primary), var(--secondary));
}
.logo svg { width: 18px; height: 18px; }
.name h1 { margin: 0; font-size: 15.5px; font-weight: 650; }
.name span { font-size: 11.5px; color: var(--muted); }
nav { padding: 4px 12px; display: flex; flex-direction: column; gap: 1px; flex: 1; overflow-y: auto; }
.lab {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em;
  color: var(--muted); padding: 9px 10px 4px; font-weight: 650;
}
.item {
  display: flex; align-items: center; gap: 11px; padding: 6px 11px; border-radius: 10px;
  cursor: pointer; color: var(--text-2); font-size: 14px; line-height: 1.5;
  border: none; background: none; text-align: left; width: 100%; transition: .15s;
}
.item:hover { background: var(--hover); color: var(--text); }
.item.on { background: var(--l-primary); color: var(--primary); font-weight: 600; }
.item svg { width: 17px; height: 17px; flex: none; }
.foot {
  padding: 7px 18px 9px; font-size: 9.5px; line-height: 1.45; color: var(--muted);
  border-top: 1px solid var(--border);
}
main { min-width: 0; display: flex; flex-direction: column; }
header { padding: 14px 26px 0; display: flex; align-items: center; gap: 12px; }
.spacer { margin-left: auto; }
.who { color: var(--text-2); }
.content { padding: 12px 26px 40px; flex: 1; }
footer { padding: 0 26px 24px; font-size: 11.5px; color: var(--muted); }

/* 窄屏：降级为图标栏，不隐藏 */
.mini { grid-template-columns: 70px 1fr; }
.mini .name, .mini .foot, .mini .item span { display: none; }
.mini .head { padding: 15px 0 8px; justify-content: center; }
.mini nav { padding: 4px 10px; }
.mini .item { justify-content: center; padding: 8px 0; }
.mini .lab { text-align: center; font-size: 9px; letter-spacing: .04em; }
@media (max-width: 920px) {
  .shell { grid-template-columns: 70px 1fr; }
  .name, .foot, .item span { display: none; }
  .head { padding: 15px 0 8px; justify-content: center; }
  .collapse { display: none; }
  .item { justify-content: center; padding: 8px 0; }
  .lab { text-align: center; font-size: 9px; }
  .content, header, footer { padding-left: 14px; padding-right: 14px; }
}
</style>
