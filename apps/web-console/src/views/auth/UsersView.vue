<script setup lang="ts">
/**
 * 用户与权限（T4.4）。
 *
 * 两件事在同一页：**这个人是什么角色**（能不能建实例、能不能管用户），
 * 以及**他能碰哪几台实例**（授权矩阵）。分成两页会让人以为改了角色就够了 ——
 * 实际上运维给了角色不给授权，一台实例也看不见。
 *
 * 界面按权限隐藏按钮只是为了不让人点必然失败的东西，
 * 真正的拦截在 Manager 的 guard 里，这里少判一次也越不了权。
 */
import { ref, computed, onMounted, h } from 'vue';
import {
  NButton, NModal, NForm, NFormItem, NInput, NSelect, NSpin, NEmpty,
  NAlert, NTag, useMessage, useDialog,
} from 'naive-ui';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import type { UserRecord, GrantRecord, Instance, Role, GrantLevel } from '../../api/types';
import FieldHelp from '../../components/FieldHelp.vue';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const users = ref<UserRecord[]>([]);
const grants = ref<GrantRecord[]>([]);
const instances = ref<Instance[]>([]);
const me = ref('');
const loading = ref(true);

const ROLE_TEXT: Record<string, string> = { admin: '管理员', operator: '运维', viewer: '只读' };
const ROLE_OPTIONS = (['admin', 'operator', 'viewer'] as Role[])
  .map((r) => ({ label: ROLE_TEXT[r] ?? r, value: r }));

/** 授权三态。「无」是真的没有权限，不是「默认可见」 */
const LEVEL_OPTIONS = [
  { label: '无', value: 'none' },
  { label: '只读', value: 'view' },
  { label: '可操作', value: 'operate' },
];

async function load(quiet = false) {
  try {
    const [u, list] = await Promise.all([api.users(), api.instances()]);
    users.value = u.users;
    grants.value = u.grants;
    instances.value = list.instances;
  } catch (e) {
    if (!quiet) message.error(e instanceof ApiError ? e.message : '加载失败');
  } finally { loading.value = false; }
}

onMounted(async () => {
  me.value = await api.me().then((r) => r.user.username).catch(() => '');
  await load();
});

/** 出现在矩阵里的只有非管理员：管理员本来就能访问全部实例，逐台勾选没有意义 */
const grantees = computed(() => users.value.filter((u) => u.role !== 'admin'));

function levelOf(username: string, instanceId: string): GrantLevel | 'none' {
  return grants.value.find((g) => g.username === username && g.instanceId === instanceId)?.level ?? 'none';
}

async function run(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
    message.success(ok);
    await load(true);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

async function setLevel(username: string, instanceId: string, level: GrantLevel | 'none') {
  await run(
    () => (level === 'none'
      ? api.revokeInstance(username, instanceId)
      : api.grantInstance(username, instanceId, level)),
    level === 'none' ? '已收回授权' : '授权已更新',
  );
}

// ── 新建用户 ────────────────────────────────────────────

const showCreate = ref(false);
const form = ref<{ username: string; role: Role }>({ username: '', role: 'viewer' });
/** 一次性口令。**只在这里出现一次**，后端不留明文，关掉就查不回来了 */
const issued = ref<{ username: string; password: string } | null>(null);

function openCreate() {
  form.value = { username: '', role: 'viewer' };
  showCreate.value = true;
}

async function submitCreate() {
  try {
    const r = await api.createUser(form.value.username.trim(), form.value.role);
    showCreate.value = false;
    issued.value = { username: r.username, password: r.password };
    await load(true);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '创建失败');
  }
}

async function copyPassword() {
  const p = issued.value?.password;
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
    message.success('口令已复制');
  } catch {
    // 非 HTTPS 或浏览器不给权限时会失败，如实说明而不是假装成功
    message.warning('浏览器不允许复制，请手动选中');
  }
}

// ── 单个用户的操作 ───────────────────────────────────────

function confirmDisable(u: UserRecord) {
  dialog.warning({
    title: `${u.disabled ? '启用' : '停用'}用户 · ${u.username}`,
    content: u.disabled
      ? '启用后该用户可以重新登录，原有实例授权保持不变。'
      : '停用后他当前的会话会立刻失效，也无法再登录。授权记录保留，随时可以启用回来。',
    positiveText: u.disabled ? '启用' : '停用',
    negativeText: '取消',
    onPositiveClick: () => run(() => api.setUserDisabled(u.username, !u.disabled),
                               u.disabled ? '已启用' : '已停用'),
  });
}

function confirmReset(u: UserRecord) {
  dialog.warning({
    title: `重置口令 · ${u.username}`,
    content: () => h('div', [
      h('p', '会生成一个新的一次性口令，旧口令立即失效，该用户下次登录必须改密。'),
      h('p', { style: 'color: var(--warning)' }, '新口令只显示一次，请当场交给本人。'),
    ]),
    positiveText: '重置', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const r = await api.resetUserPassword(u.username);
        issued.value = { username: r.username, password: r.password };
        await load(true);
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '重置失败');
      }
    },
  });
}
</script>

<template>
  <div class="page">
    <div class="bar">
      <div class="ttl">
        <h2>用户与权限</h2>
        <p class="sub">角色决定「能做哪类事」，授权矩阵决定「能对哪几台实例做」</p>
      </div>
      <NButton type="primary" @click="openCreate">+ 新建用户</NButton>
    </div>

    <NSpin :show="loading">
      <!-- ── 用户 ── -->
      <div class="card">
        <div class="ch">
          <h3>账号</h3>
          <span class="hint">
            共 {{ users.length }} 个
            <FieldHelp>
              <p><b>管理员</b>能建实例、删实例、管用户、跑备份。备份文件里含全部实例的凭据，
                所以给管理员等于给全站钥匙。</p>
              <p><b>运维</b>能启停实例、改流程、看日志，但建不了也删不了实例，更管不了用户。</p>
              <p><b>只读</b>只能看，连启停都不行。</p>
              <p>角色随时可改，改完立刻生效，不需要对方重新登录。</p>
            </FieldHelp>
          </span>
        </div>

        <div class="list">
          <div v-for="u in users" :key="u.username" class="row" :class="{ off: u.disabled }">
            <div class="who">
              <span class="nm mono">{{ u.username }}</span>
              <NTag v-if="u.username === me" size="small" round type="info">当前登录</NTag>
              <NTag v-if="u.disabled" size="small" round type="error">已停用</NTag>
              <NTag v-else-if="u.mustChangePassword" size="small" round type="warning">待改密</NTag>
            </div>
            <div class="meta">
              <span class="muted">创建于 {{ u.createdAt }}</span>
            </div>
            <div class="ops">
              <NSelect :value="u.role" :options="ROLE_OPTIONS" size="tiny" class="rolesel"
                       :disabled="u.username === me"
                       @update:value="(r) => run(() => api.setUserRole(u.username, r as Role), '角色已更新')" />
              <NButton size="tiny" @click="confirmReset(u)">重置口令</NButton>
              <!-- 自己那行不给停用入口：把自己关在门外没有补救途径 -->
              <NButton v-if="u.username !== me" size="tiny"
                       :type="u.disabled ? 'primary' : 'default'" @click="confirmDisable(u)">
                {{ u.disabled ? '启用' : '停用' }}
              </NButton>
            </div>
          </div>
        </div>

        <p class="note">
          平台不提供删除用户
          <FieldHelp>
            <p>审计记录里记的是用户名。把账号删掉，那些「谁在什么时候删了哪台实例」
              就全部失去指向了。</p>
            <p>所以只提供<b>停用</b>：停用后立刻登不进来，记录仍然完整，需要时还能启用回来。</p>
          </FieldHelp>
        </p>
      </div>

      <!-- ── 授权矩阵 ── -->
      <div class="card">
        <div class="ch">
          <h3>实例授权矩阵</h3>
          <span class="hint">
            管理员不在表内
            <FieldHelp>
              <p><b>只读</b>：能看列表、日志与健康，也能打开编辑器查看流程，
                但<b>改不了</b> —— 部署会被拒。</p>
              <p class="fh-warn">只读用户的编辑器<b>没有实时事件流</b>：调试侧栏收不到消息、
                节点状态不刷新，编辑器右上角会提示连接中断。这是有意的 ——
                那条实时通道是双向的，能往流程里写入，所以按「改动」对待。
                需要看实时调试请给「可操作」。</p>
              <p><b>可操作</b>：能启停、重置实例口令、在编辑器里部署流程。</p>
              <p>选「无」就是没有权限：那台实例不会出现在他的列表、健康看板和趋势图里，
                直接访问也会被拒。</p>
              <p>管理员天然能访问全部实例，所以不列在这张表里。</p>
            </FieldHelp>
          </span>
        </div>

        <NEmpty v-if="instances.length === 0" description="还没有实例，先建一台才能分配权限"
                style="padding: 32px 0">
          <template #extra>
            <NButton size="small" @click="router.push({ name: 'instances' })">去创建实例</NButton>
          </template>
        </NEmpty>

        <NEmpty v-else-if="grantees.length === 0"
                description="目前只有管理员账号，管理员本来就能访问全部实例" style="padding: 32px 0">
          <template #extra><NButton size="small" @click="openCreate">新建一个运维或只读账号</NButton></template>
        </NEmpty>

        <!-- 实例多时表格自己横向滚动，页面不整体横向溢出 -->
        <div v-else class="matrix">
          <table>
            <thead>
              <tr>
                <th class="corner">用户</th>
                <th v-for="i in instances" :key="i.id" :title="i.name">
                  <span class="mono">{{ i.id }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in grantees" :key="u.username">
                <th class="uname">
                  <span class="mono">{{ u.username }}</span>
                  <span class="role">{{ ROLE_TEXT[u.role] ?? u.role }}</span>
                </th>
                <td v-for="i in instances" :key="i.id">
                  <NSelect :value="levelOf(u.username, i.id)" :options="LEVEL_OPTIONS" size="tiny"
                           :consistent-menu-width="false"
                           @update:value="(v) => setLevel(u.username, i.id, v as GrantLevel | 'none')" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </NSpin>

    <!-- 新建用户 -->
    <NModal v-model:show="showCreate" preset="card" title="新建用户" style="width: 560px">
      <NForm label-placement="top" size="small">
        <NFormItem>
          <template #label>
            用户名
            <FieldHelp>
              <p>登录用，<b>创建后不能改</b>，要换只能新建一个再把旧的停用。</p>
              <p>3~32 位，字母开头，只允许字母、数字与 <code>. _ -</code>。
                例：<code>lin.wei</code>、<code>ops-night</code>。</p>
            </FieldHelp>
          </template>
          <NInput v-model:value="form.username" class="mono" placeholder="例：ops-night" />
        </NFormItem>
        <NFormItem>
          <template #label>
            角色
            <FieldHelp>
              <p>只决定「能做哪类事」。<b>能碰哪几台实例</b>要另外在授权矩阵里给，
                否则他登录后一台实例都看不见。</p>
              <p>拿不准就先给<b>只读</b>：不够用随时可以升，给多了收回来时人已经动过东西了。</p>
            </FieldHelp>
          </template>
          <NSelect v-model:value="form.role" :options="ROLE_OPTIONS" />
        </NFormItem>

        <NAlert v-if="form.role === 'admin'" type="warning" :bordered="false" size="small">
          管理员可以跑备份，而<b>备份文件里含全部实例的凭据</b> —— 等于把全站钥匙交出去。
          只是要管几条产线的话，用「运维」加授权矩阵就够了。
        </NAlert>
      </NForm>
      <template #footer>
        <div class="foot">
          <NButton size="small" @click="showCreate = false">取消</NButton>
          <NButton size="small" type="primary" :disabled="!form.username.trim()" @click="submitCreate">
            创建
          </NButton>
        </div>
      </template>
    </NModal>

    <!-- 一次性口令 -->
    <NModal :show="issued !== null" preset="card" title="初始口令" style="width: 480px"
            @update:show="(v) => { if (!v) issued = null; }">
      <NAlert type="warning" :bordered="false" size="small" style="margin-bottom: 12px">
        这个口令<b>只显示这一次</b>。关掉就再也查不到 —— 平台不留明文，忘了只能重置。
      </NAlert>
      <div class="pw">
        <span class="mono">{{ issued?.password }}</span>
        <NButton size="tiny" @click="copyPassword">复制</NButton>
      </div>
      <p class="sub">
        交给 <b class="mono">{{ issued?.username }}</b> 本人，他首次登录后必须改密。
      </p>
      <template #footer>
        <div class="foot">
          <NButton size="small" type="primary" @click="issued = null">我已记下</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }

.card {
  background: var(--surface); border-radius: var(--r); box-shadow: var(--shadow);
  padding: 18px 20px; margin-bottom: 2px;
}
.ch { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.ch h3 { margin: 0; font-size: 15px; font-weight: 650; }
.hint { font-size: 11.5px; color: var(--muted); }

.list { display: flex; flex-direction: column; }
.row {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 10px 0; border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: none; }
.row.off .nm { color: var(--muted); text-decoration: line-through; }
.who { display: flex; align-items: center; gap: 8px; min-width: 200px; }
.nm { font-weight: 600; }
.meta { font-size: 12px; margin-left: auto; }
.muted { color: var(--muted); }
.ops { display: flex; align-items: center; gap: 8px; }
.rolesel { width: 104px; }
.note { margin: 12px 0 0; font-size: 12px; color: var(--muted); }

.matrix { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); }
thead th { font-size: 11.5px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
.corner { color: var(--muted); }
.uname { white-space: nowrap; font-weight: 600; }
.uname .role { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--muted); }
td { min-width: 118px; }

.pw {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: var(--grey100); border-radius: var(--rs); padding: 12px 14px;
}
.pw span { font-size: 15px; font-weight: 600; word-break: break-all; }
.sub { margin: 10px 0 0; font-size: 12.5px; color: var(--text-2); }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
/* 元素选择器一律加类名限定，免得顺着插槽跑进 tooltip 的传送门（12 号文 5.1） */
.page :deep(code) { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }

@media (max-width: 560px) {
  .meta { display: none; }
  .ops { width: 100%; }
}
</style>
