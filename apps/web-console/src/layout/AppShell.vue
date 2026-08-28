<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { NButton, NModal, NAlert, useMessage } from 'naive-ui';
import { api } from '../api/client';
import { can, clearPermissions, loadPermissions } from '../api/permissions';
import ReleaseNotes from '../components/ReleaseNotes.vue';

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

/*
 * 导航按语义分组：「运行」是看现场此刻怎么样，「对接」是配上下游怎么连。
 * 云对接放进「运行」会让人以为它也是个监控页，实际上它主要是改配置的地方。
 */
/** `need` 省略即所有登录者可见；写了就要该动作才显示 */
interface NavItem { name: string; title: string; icon: string; need?: string }
interface NavGroup { label: string; items: NavItem[]; need?: string }

const NAV_GROUPS: NavGroup[] = [
  {
    label: '运行',
    items: [
      { name: 'instances', title: '实例', icon: 'M3 5.2C3 4 5 3 8.5 3S14 4 14 5.2 12 7.4 8.5 7.4 3 6.4 3 5.2ZM3 5.2v9.6c0 1.2 2 2.2 5.5 2.2s5.5-1 5.5-2.2V5.2M3 10c0 1.2 2 2.2 5.5 2.2S14 11.2 14 10' },
      { name: 'health', title: '健康监测', icon: 'M2 9h3l2-5 3 10 2-5h3' },
      // 放在实例旁边而不是「系统」组：套模板是产线上的日常动作，
      // 不是运维配置 —— 现场找它的时候是在找「怎么把这条线的流程复制到那条」
      { name: 'templates', title: '流程模板', need: 'template:view',
        icon: 'M4 3h7l3 3v11H4ZM11 3v3h3M6.5 9.5h5M6.5 12.5h5' },
      // field:view 目前三种角色都有，写出来是为了跟后端的判权一一对上：
      // 哪天收紧了角色表，这里不用改也会自己收起来
      { name: 'field', title: '现场设备', need: 'field:view',
        icon: 'M7 3h6v3h3v8H4V6h3ZM7 6h6M2 8h2M2 12h2M16 8h2M16 12h2M8 9v2M12 9v2' },
    ],
  },
  {
    label: '对接',
    items: [
      { name: 'cloud', title: '云平台', icon: 'M6 15.5a3.5 3.5 0 0 1 .3-6.99A5 5 0 0 1 15.6 8.2 3.4 3.4 0 0 1 15 15.5Z' },
    ],
  },
  {
    label: '系统',
    // 只有管得了用户的人才看得到这一项。不是安全措施（后端自己判），
    // 而是不要把点进去必然 403 的入口摆在别人面前
    // 逐项判权限而不是整组判：运维能跑备份但管不了用户，
    // 整组挂 need 会把「备份」也一起藏掉
    items: [
      { name: 'users', title: '用户与权限', need: 'user:manage', icon: 'M2.6 16.5a5 5 0 0 1 9.8 0M7.5 8.6a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8Zm6.2 0a2.4 2.4 0 1 0 0-4.8M14 11.4a4.4 4.4 0 0 1 3.4 5.1' },
      // 运维也有 diag:run —— 现场第一响应人就是他们，不能只给管理员
      { name: 'diag', title: '远程诊断', need: 'diag:run', icon: 'M2 10h3l2.5-6 3.5 12 2.5-6h3' },
      { name: 'backup', title: '备份', need: 'backup:run', icon: 'M3 5.5C3 4.4 5.5 3.5 9 3.5s6 .9 6 2v7c0 1.1-2.5 2-6 2s-6-.9-6-2ZM3 9c0 1.1 2.5 2 6 2s6-.9 6-2' },
      // 不挂 need：每个人都要能进去管自己的两步验证。
      // 页内的「安全策略」那一块对没有 system:manage 的人是只读
      { name: 'settings', title: '系统设置', icon: 'M9 11.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Zm6.4-1.3a6.4 6.4 0 0 0-.1-1.1l1.5-1.2-1.5-2.6-1.8.7a6.4 6.4 0 0 0-1.9-1.1L11.3 3H8.3l-.3 1.9a6.4 6.4 0 0 0-1.9 1.1l-1.8-.7-1.5 2.6 1.5 1.2a6.4 6.4 0 0 0 0 2.2l-1.5 1.2 1.5 2.6 1.8-.7a6.4 6.4 0 0 0 1.9 1.1l.3 1.9h3l.3-1.9a6.4 6.4 0 0 0 1.9-1.1l1.8.7 1.5-2.6-1.5-1.2c.06-.36.1-.73.1-1.1Z' },
    ],
  },
];

/** 当前能看到的导航分组。权限没取到时按「看不到」处理，取到后自动补上 */
/**
 * 逐项过滤，再丢掉空组。
 *
 * 组级和条目级都要判：组级用于整块只对某类人开放；条目级用于同一组里
 * 各项权限不同（备份要 backup:run，用户管理要 user:manage，运维只有前者）。
 * 只判组级会把运维能用的「备份」一起藏掉。
 */
const navGroups = computed(() =>
  NAV_GROUPS
    .filter((g) => !g.need || can(g.need))
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.need || can(i.need)) }))
    .filter((g) => g.items.length > 0));

/**
 * 版本与升级说明。
 *
 * 弹的是「**已经**更新到了什么」，不是「有新版可用」。
 * 现场做升级的人（实施/运维）和日常用系统的人（作业人员）常常不是同一个，
 * 后者只会发现界面变了却不知道变了什么 —— 升级后的说明才是给他们看的。
 *
 * 只在版本号与上次看到的不同才弹，且看过即记住，不反复打扰。
 */
const SEEN_KEY = 'tle-seen-version';
const version = ref('');
const notes = ref('');
const showNotes = ref(false);
const update = ref<{ outdated?: boolean; latest?: string; url?: string } | null>(null);

onMounted(async () => {
  try { username.value = (await api.me()).user.username; } catch { /* 守卫已处理 */ }
  await loadPermissions();

  try {
    const info = await api.version();
    version.value = info.version;
    if (info.update.enabled && info.update.outdated) update.value = info.update;

    // 首次安装（没有记录过任何版本）不弹 —— 那不是「更新」，是刚装好
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen === null) {
      localStorage.setItem(SEEN_KEY, info.version);
    } else if (seen !== info.version && info.notes.trim() !== '') {
      notes.value = info.notes;
      showNotes.value = true;
    } else if (seen !== info.version) {
      // 该版本没写使用者说明，不弹窗但也要记下，免得下次又判成「变了」
      localStorage.setItem(SEEN_KEY, info.version);
    }
  } catch { /* 版本拿不到不影响使用 */ }
});

function dismissNotes() {
  localStorage.setItem(SEEN_KEY, version.value);
  showNotes.value = false;
}

async function signOut() {
  await api.logout().catch(() => undefined);
  clearPermissions();
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
        <template v-for="g in navGroups" :key="g.label">
          <div class="lab">{{ g.label }}</div>
          <button v-for="n in g.items" :key="n.name" class="item" :class="{ on: route.name === n.name }"
                  :title="n.title" @click="router.push({ name: n.name })">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round"><path :d="n.icon" /></svg>
            <span>{{ n.title }}</span>
          </button>
        </template>
      </nav>

      <div class="foot">
        <span class="ver mono" :title="update?.outdated ? `有新版本 v${update.latest}` : ''">
          v{{ version || '—' }}<i v-if="update?.outdated" class="dot" />
        </span><br />
        © 2024-present mqttsnet<br />All Rights Reserved.
      </div>
    </aside>

    <main>
      <header>
        <div class="spacer" />
        <span class="who mono">{{ username }}</span>
        <NButton size="small" quaternary @click="signOut">登出</NButton>
      </header>
      <div class="content"><RouterView /></div>
      <footer>Copyright © 2024-present mqttsnet All Rights Reserved.</footer>

    <NModal v-model:show="showNotes" preset="card" style="max-width: 560px"
            :title="`已更新到 v${version}`" :mask-closable="false" @close="dismissNotes">
      <NAlert type="success" :bordered="false" style="margin-bottom: 14px">
        管理台已升级。以下是本次更新对日常操作的影响。
      </NAlert>
      <ReleaseNotes :source="notes" />
      <template #footer>
        <div style="text-align: right">
          <NButton type="primary" @click="dismissNotes">知道了</NButton>
        </div>
      </template>
    </NModal>
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
.ver { color: var(--text-2); font-size: 10.5px; }
/* 有新版时在版本号后点一个小圆点：不打断操作，但看得见 */
.dot {
  display: inline-block; width: 5px; height: 5px; margin-left: 4px;
  border-radius: 50%; background: var(--warning); vertical-align: 1px;
}
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
