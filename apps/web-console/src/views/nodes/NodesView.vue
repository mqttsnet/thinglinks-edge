<script setup lang="ts">
/**
 * 节点管理（01 号文 5.7）。
 *
 * 这一页要同时回答三个**不同**的问题，界面按这三问分成三段：
 *
 *   批准清单  ——「**允许**装什么」。它是闸门本身：内容会被写进每台实例的
 *                settings.js，改一条就要下发+重启实例才生效。
 *   离线包库  ——「**有**什么可装」。Manager 自带的私有 npm 源里存着的 tgz，
 *                无外网现场只能从这里装。
 *   已装台账  ——「实际**装了**什么」。各实例现答，不缓存。
 *
 * 三者不一致是常态（批了但库里没有、库里有但没批、装着的已被撤销批准），
 * 而**把不一致显示出来**正是这一页存在的理由 —— 那种漂移不主动查是看不见的。
 *
 * 全页最需要小心的动作是**下发**：它重写实例配置并重启实例，会中断现场采集。
 * 因此下发是一个显式按钮，而不是「批准」的副作用 —— 后端也是这么设计的
 * （批准接口恒回 applied:false）。
 */
import { ref, computed, onMounted } from 'vue';
import {
  NButton, NCard, NModal, NForm, NFormItem, NInput, NSpin, NAlert, NTag, NSpace,
  NPopconfirm, NEmpty, NCheckbox, NRadioGroup, NRadioButton, useMessage,
} from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type {
  CatalogEntry, StorePackage, InstanceInventory, InventoryItem, Instance, NodeCompliance,
} from '../../api/types';
import { can, loadPermissions } from '../../api/permissions';
// approvedAt 来自 SQLite 的 datetime('now')：是 UTC 但不带 Z，
// 直接 new Date() 会按本地解析，东八区差 8 小时（见 api/datetime.ts）
import { localTime } from '../../api/datetime';
import FieldHelp from '../../components/FieldHelp.vue';

const message = useMessage();

type Section = 'catalog' | 'store' | 'inventory';
const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'catalog', label: '批准清单' },
  { value: 'store', label: '离线包库' },
  { value: 'inventory', label: '已装台账' },
];
const section = ref<Section>('catalog');

const entries = ref<CatalogEntry[]>([]);
const packages = ref<StorePackage[]>([]);
const storeRoot = ref('');
const inventory = ref<InstanceInventory[]>([]);
const instances = ref<Instance[]>([]);
const loading = ref(true);
const loadError = ref('');

const manage = computed(() => can('node:manage'));

/** 实例 id → 名字。台账里只有 id，光看 id 认不出是哪条产线 */
const nameOf = (id: string) => instances.value.find((i) => i.id === id)?.name ?? id;

async function refresh() {
  loading.value = true;
  loadError.value = '';
  /*
   * 四个请求地位不同，所以不用 `Promise.all` 一荣俱荣：
   * 前三个各自撑起一段，某一段挂了不该让另外两段也空白 ——
   * 台账要去逐台实例现问，是四个里最容易超时的那个，
   * 而它挂掉时批准清单和包库仍然完全可用。
   */
  const [c, s, inv, ins] = await Promise.allSettled([
    api.nodeCatalog(), api.nodeStore(), api.nodeInventory(), api.instances(),
  ]);
  if (c.status === 'fulfilled') entries.value = c.value.entries;
  else loadError.value = c.reason instanceof ApiError ? c.reason.message : '加载批准清单失败';
  if (s.status === 'fulfilled') {
    packages.value = s.value.packages;
    storeRoot.value = s.value.root;
  }
  if (inv.status === 'fulfilled') inventory.value = inv.value.instances;
  if (ins.status === 'fulfilled') instances.value = ins.value.instances;
  loading.value = false;
}

// ── 批准清单 ────────────────────────────────────────────

const showApprove = ref(false);
const approving = ref(false);
const approveErr = ref('');
const approveForm = ref({ module: '', version: '', note: '' });

function openApprove(prefill = '') {
  approveForm.value = { module: prefill, version: '', note: '' };
  approveErr.value = '';
  showApprove.value = true;
}

async function submitApprove() {
  approving.value = true;
  approveErr.value = '';
  try {
    const { entry } = await api.approveNode(
      approveForm.value.module.trim(),
      approveForm.value.version.trim() || undefined,
      approveForm.value.note.trim() || undefined,
    );
    showApprove.value = false;
    await refresh();
    // 明确说「还没生效」——这是这一页最容易产生误解的地方
    message.warning(`已批准 ${entry.module}，还需「下发到实例」才会生效`, { duration: 8000 });
  } catch (e) {
    approveErr.value = e instanceof ApiError ? e.message : '批准失败';
  } finally {
    approving.value = false;
  }
}

async function revoke(module: string) {
  try {
    await api.revokeNode(module);
    await refresh();
    message.warning(`已撤销 ${module}，还需「下发到实例」才会生效`, { duration: 8000 });
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '撤销失败');
  }
}

// ── 离线包库 ────────────────────────────────────────────

const importing = ref(false);
const importErr = ref('');
/** 上一批导入的结果，导入后留在页面上而不是弹一下就没 —— 缺口要能对着看 */
const importReport = ref<Array<{ file: string; ok: boolean; detail: string }>>([]);

async function pickFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';   // 清掉，否则同一个文件选第二次不触发 change
  if (files.length === 0) return;

  importing.value = true;
  importErr.value = '';
  importReport.value = [];
  /*
   * 逐个串行导入，**一个失败不中断其余**。离线现场一次拷进来的是
   * 「节点包 + 它的十几个依赖」，中间某个坏了就整批停下的话，
   * 人得自己算还剩哪些没导 —— 那正是最容易漏掉一个依赖的地方。
   */
  for (const f of files) {
    try {
      const r = await api.importNodePackage(f);
      const bits = [`${r.package.name}@${r.package.version}`];
      bits.push(r.package.isNodeRedNode ? '节点包' : '依赖包');
      if (r.missingDeps.length) bits.push(`缺依赖：${r.missingDeps.join('、')}`);
      if (r.missingOptionalDeps.length) bits.push(`缺可选依赖：${r.missingOptionalDeps.join('、')}`);
      importReport.value.push({ file: f.name, ok: true, detail: bits.join(' · ') });
    } catch (err) {
      importReport.value.push({
        file: f.name, ok: false,
        detail: err instanceof ApiError ? err.message : '导入失败',
      });
    }
  }
  importing.value = false;
  await refresh();

  const bad = importReport.value.filter((r) => !r.ok).length;
  if (bad === 0) message.success(`导入了 ${files.length} 个包`);
  else message.warning(`${files.length} 个里有 ${bad} 个没导进去，详见下方清单`);
}

async function removePackage(p: StorePackage, version: string) {
  try {
    await api.removeNodePackage(p.module, version);
    await refresh();
    message.success(`已删除 ${p.module}@${version}`);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

/** 只列节点包还是全都列。依赖包数量常常是节点包的十几倍，默认收起来 */
const showDeps = ref(false);
const visiblePackages = computed(() =>
  showDeps.value ? packages.value : packages.value.filter((p) => p.isNodeRedNode));
const depCount = computed(() => packages.value.filter((p) => !p.isNodeRedNode).length);

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 下发 ────────────────────────────────────────────────

const showApply = ref(false);
const applying = ref(false);
const applyErr = ref('');
const applyTargets = ref<string[]>([]);

function openApply() {
  // 默认全选：漏掉一台的后果是那台的白名单和别处不一样，而且没人会发现
  applyTargets.value = instances.value.map((i) => i.id);
  applyErr.value = '';
  showApply.value = true;
}

function toggleTarget(id: string, checked: boolean) {
  applyTargets.value = checked
    ? [...applyTargets.value, id]
    : applyTargets.value.filter((x) => x !== id);
}

async function confirmApply() {
  applying.value = true;
  applyErr.value = '';
  try {
    const { results } = await api.applyNodePolicy(applyTargets.value);
    showApply.value = false;
    await refresh();
    const failed = results.filter((r) => !r.ok);
    const restarted = results.filter((r) => r.ok && r.restarted).length;
    if (failed.length === 0) {
      message.success(`已下发到 ${results.length} 台，其中 ${restarted} 台已重启生效`);
    } else {
      // 部分失败必须说清是**哪几台**：没生效的那几台还挂着旧白名单
      message.warning(
        `${results.length} 台里有 ${failed.length} 台没成功：`
        + failed.map((r) => `${nameOf(r.instanceId)}（${r.error}）`).join('；'),
        { duration: 15000 },
      );
    }
  } catch (e) {
    applyErr.value = e instanceof ApiError ? e.message : '下发失败';
  } finally {
    applying.value = false;
  }
}

// ── 台账 ────────────────────────────────────────────────

const COMPLIANCE: Record<NodeCompliance, { text: string; type: 'default' | 'success' | 'warning' | 'info' }> = {
  builtin: { text: '镜像自带', type: 'default' },
  platform: { text: '平台节点集', type: 'info' },
  approved: { text: '已批准', type: 'success' },
  unapproved: { text: '未批准', type: 'warning' },
};

/** 未批准的排在最前 —— 这一页要人看见的就是它们 */
function sortedModules(inv: InstanceInventory): InventoryItem[] {
  const rank = (m: InventoryItem) => (m.compliance === 'unapproved' ? 0 : 1);
  return [...inv.modules].sort((a, b) => rank(a) - rank(b) || a.module.localeCompare(b.module));
}

const totalUnapproved = computed(() =>
  inventory.value.reduce((n, i) => n + i.unapproved, 0));

onMounted(async () => {
  await loadPermissions();
  await refresh();
});
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>节点管理</h2>
        <p class="sub">管住实例能装哪些第三方节点，并让离线现场也装得上</p>
      </div>
      <NButton v-if="manage" type="primary" size="small"
               :disabled="instances.length === 0" @click="openApply">下发到实例</NButton>
    </div>

    <NAlert v-if="loadError" type="error" :bordered="false">{{ loadError }}</NAlert>

    <NAlert v-if="totalUnapproved > 0" type="warning" :bordered="false" class="drift">
      <b>有 {{ totalUnapproved }} 个已装节点不在批准清单里。</b>
      多半是白名单生效之前装的，也可能是有人绕过平台在实例里手工装的。
      到「已装台账」逐条确认：该留的补批准，不该留的去实例里卸载。
    </NAlert>

    <NRadioGroup v-model:value="section" size="small">
      <NRadioButton v-for="s in SECTIONS" :key="s.value" :value="s.value" :label="s.label" />
    </NRadioGroup>

    <NSpin :show="loading">
      <!-- ── 批准清单 ─────────────────────────────────── -->
      <section v-show="section === 'catalog'" class="sec">
        <div class="sh">
          <p class="lead">
            这张表决定实例<b>允许安装</b>哪些节点包。它会被写进每台实例的配置，
            <b>改完必须「下发到实例」才生效</b>——下发会重启实例。
          </p>
          <NButton v-if="manage" size="tiny" secondary @click="openApprove()">批准新节点包</NButton>
        </div>

        <NEmpty v-if="entries.length === 0" class="empty" description="批准清单是空的">
          <template #extra>
            <p class="hint" style="max-width:460px">
              空清单意味着实例<b>一个第三方节点都装不了</b>（内置节点不受影响）。
              这是安全的默认值。需要哪个就在这里批准哪个。
            </p>
          </template>
        </NEmpty>

        <NCard v-for="e in entries" :key="e.module" class="card" :bordered="false">
          <div class="th">
            <div class="tn">
              <span class="name mono">{{ e.module }}</span>
              <NTag size="small" :bordered="false">
                {{ e.version ? e.version : '不限版本' }}
              </NTag>
              <NTag v-if="!e.inStore" size="small" :bordered="false" type="warning">
                离线库里没有
              </NTag>
            </div>
            <NPopconfirm v-if="manage" @positive-click="revoke(e.module)">
              <template #trigger><NButton size="tiny" secondary type="error">撤销</NButton></template>
              撤销 {{ e.module }} 的批准？<br>
              <b>已经装上的不会因此消失</b>，只是以后装不上了。
              要清掉已装的，得去实例里卸载。撤销同样需要下发才生效。
            </NPopconfirm>
          </div>

          <p v-if="e.note" class="desc">{{ e.note }}</p>

          <NAlert v-if="!e.inStore" type="warning" :bordered="false" class="warn">
            <b>批了，但离线包库里没有这个包。</b>
            有外网的现场能从上游装；<b>无外网的现场装不上</b>，报的是包找不到。
            请在「离线包库」里把它连同依赖一起导入。
          </NAlert>

          <div class="meta">
            <span>{{ e.approvedBy }} 批于 {{ localTime(e.approvedAt) }}</span>
            <span v-if="e.storeVersions.length" class="mono">
              库里有 {{ e.storeVersions.join('、') }}
            </span>
          </div>
        </NCard>
      </section>

      <!-- ── 离线包库 ─────────────────────────────────── -->
      <section v-show="section === 'store'" class="sec">
        <div class="sh">
          <p class="lead">
            Manager 自带的私有 npm 源。无外网现场只能从这里装 ——
            <b>包进了库不等于能装</b>，还要在「批准清单」里批准。
          </p>
          <div v-if="manage" class="file">
            <input type="file" accept=".tgz,application/gzip" multiple
                   :disabled="importing" @change="pickFiles">
            <FieldHelp>
              <p>选 <code>npm pack</code> 出来的 <code>.tgz</code>，可以一次多选。</p>
              <p><b>必须连依赖一起导</b>：只导节点包本身，现场点安装时 npm 会去公网
                找它的依赖，而现场没有公网 —— 表现是「包明明在源里，还是装不上」。</p>
              <p>仓库里的 <code>scripts/pack-nodes.sh</code> 会把某个节点包
                <b>连同整个依赖闭包</b>打成一堆 tgz，拿那个目录里的文件导最省事。</p>
            </FieldHelp>
          </div>
        </div>

        <NSpin :show="importing">
          <div v-if="importReport.length" class="rep">
            <div v-for="r in importReport" :key="r.file" class="rrow">
              <span :class="['dot', r.ok ? 'ok' : 'bad']" />
              <span class="mono rf">{{ r.file }}</span>
              <span class="rd">{{ r.detail }}</span>
            </div>
          </div>
        </NSpin>
        <NAlert v-if="importErr" type="error" :bordered="false">{{ importErr }}</NAlert>

        <NEmpty v-if="packages.length === 0 && !importing" class="empty" description="包库是空的">
          <template #extra>
            <p class="hint" style="max-width:460px">
              有外网的现场用不上它（直接从公网装）。<b>无外网的现场必须先把包导进来</b>：
              在有网的机器上跑 <code>scripts/pack-nodes.sh</code> 取包，
              拷过来从上面导入；或者随离线安装包一起发。
            </p>
          </template>
        </NEmpty>

        <div v-if="packages.length" class="filt">
          <NCheckbox v-model:checked="showDeps" size="small">
            连依赖包一起列（{{ depCount }} 个）
          </NCheckbox>
          <span class="hint mono">{{ storeRoot }}</span>
        </div>

        <NCard v-for="p in visiblePackages" :key="p.module" class="card" :bordered="false">
          <div class="th">
            <div class="tn">
              <span class="name mono">{{ p.module }}</span>
              <NTag size="small" :bordered="false">{{ p.latest }}</NTag>
              <NTag v-if="!p.isNodeRedNode" size="small" :bordered="false">依赖包</NTag>
              <NTag v-if="p.approved" size="small" :bordered="false" type="success">已批准</NTag>
              <NTag v-if="p.missingDeps.length" size="small" :bordered="false" type="error">
                缺依赖
              </NTag>
            </div>
            <NSpace :size="8">
              <NButton v-if="manage && p.isNodeRedNode && !p.approved" size="tiny" secondary
                       @click="openApprove(p.module)">批准</NButton>
              <NPopconfirm v-if="manage" @positive-click="removePackage(p, p.latest)">
                <template #trigger>
                  <NButton size="tiny" secondary type="error">删 {{ p.latest }}</NButton>
                </template>
                从包库删除 {{ p.module }}@{{ p.latest }}？
                已经装到实例上的不受影响，但以后无外网现场就装不了这个版本了。
              </NPopconfirm>
            </NSpace>
          </div>

          <p v-if="p.description" class="desc">{{ p.description }}</p>

          <NAlert v-if="p.missingDeps.length" type="error" :bordered="false" class="warn">
            <b>依赖没配齐，无外网现场装不上：</b>
            <span class="mono">{{ p.missingDeps.join('、') }}</span>
            <br>
            npm 会去公网找这几个包，现场连不上就整包安装失败。
            用 <code>scripts/pack-nodes.sh</code> 重新取一次会把闭包一并带上。
          </NAlert>

          <NAlert v-else-if="p.missingOptionalDeps.length" type="warning" :bordered="false" class="warn">
            <b>缺的是可选依赖，装得上、但会少一部分功能：</b>
            <span class="mono">{{ p.missingOptionalDeps.join('、') }}</span>
            <br>
            而且<b>不会报错</b>——比如 Modbus 节点的串口（RTU）支持就在可选依赖里，
            缺了它 TCP 一切正常、串口那半边静悄悄地不工作。用得上就补进来。
          </NAlert>

          <div class="meta">
            <span>{{ sizeText(p.size) }}</span>
            <span v-if="p.versions.length > 1" class="mono">版本 {{ p.versions.join('、') }}</span>
            <span v-if="p.types.length" class="mono types">
              节点 {{ p.types.slice(0, 8).join(' ')
              }}<template v-if="p.types.length > 8"> …共 {{ p.types.length }} 种</template>
            </span>
          </div>
        </NCard>
      </section>

      <!-- ── 已装台账 ─────────────────────────────────── -->
      <section v-show="section === 'inventory'" class="sec">
        <p class="lead">
          各实例<b>此刻实际装着</b>什么，逐台现问、不缓存 ——
          缓存一份「上次看到的」只会在有人手工装过之后骗人，
          而这一页恰恰是用来发现那种偏差的。
        </p>

        <NEmpty v-if="inventory.length === 0" class="empty" description="没有可查看的实例" />

        <NCard v-for="inv in inventory" :key="inv.instanceId" class="card" :bordered="false">
          <div class="th">
            <div class="tn">
              <span class="name">{{ nameOf(inv.instanceId) }}</span>
              <NTag size="small" :bordered="false" class="mono">{{ inv.instanceId }}</NTag>
              <NTag v-if="inv.ok" size="small" :bordered="false">
                {{ inv.modules.length }} 个模块
              </NTag>
              <NTag v-if="inv.unapproved > 0" size="small" :bordered="false" type="warning">
                {{ inv.unapproved }} 个未批准
              </NTag>
            </div>
          </div>

          <NAlert v-if="!inv.ok" type="info" :bordered="false" class="warn">
            <b>读不到这台的节点清单。</b>{{ inv.reason }}
            <br>
            实例停着时读不到是正常的 —— 清单存在实例自己的管理接口后面，容器停着那个接口就不存在。
          </NAlert>

          <div v-else class="mods">
            <div v-for="m in sortedModules(inv)" :key="m.module"
                 :class="['mod', m.compliance === 'unapproved' ? 'alert' : '']">
              <span class="mono mname">{{ m.module }}</span>
              <span class="mono mver">{{ m.version }}</span>
              <NTag size="small" :bordered="false" :type="COMPLIANCE[m.compliance].type">
                {{ COMPLIANCE[m.compliance].text }}
              </NTag>
              <NButton v-if="manage && m.compliance === 'unapproved'" size="tiny" secondary
                       @click="openApprove(m.module)">补批准</NButton>
              <span v-if="!m.enabled" class="off">有节点被禁用</span>
            </div>
          </div>
        </NCard>
      </section>
    </NSpin>

    <!-- 批准 -->
    <NModal v-model:show="showApprove" preset="card" title="批准节点包" style="max-width: 620px">
      <NAlert type="info" :bordered="false" style="margin-bottom:14px">
        批准一个包 = 允许它在<b>所有</b>实例里被安装并执行代码。
        请确认这个包的来路，以及现场确实需要它。
      </NAlert>

      <NForm label-placement="top">
        <NFormItem>
          <template #label>
            包名
            <FieldHelp>
              <p>npm 上的完整包名，例如 <code>node-red-contrib-modbus</code>。</p>
              <p>带 scope 的写全，例如 <code>@flowfuse/node-red-dashboard</code>。</p>
              <p>写错不会当场报错，但现场会一直装不上那个包 —— 名字请从
                npm 页面或包库列表里复制。</p>
            </FieldHelp>
          </template>
          <NInput v-model:value="approveForm.module" placeholder="node-red-contrib-modbus" />
        </NFormItem>

        <NFormItem>
          <template #label>
            版本范围
            <FieldHelp>
              <p>留空 = <b>不限版本</b>，这个包的任何版本都能装。</p>
              <p>写了就只允许这个范围，例如 <code>5.x</code> 或 <code>~5.60.0</code>。
                想钉死某个已验证过的版本时才用得上。</p>
            </FieldHelp>
          </template>
          <NInput v-model:value="approveForm.version" placeholder="留空表示不限版本" />
        </NFormItem>

        <NFormItem>
          <template #label>
            备注
            <FieldHelp>
              <p>写给下一个人看的：<b>为什么批它</b>。</p>
              <p>比如「二号产线西门子 PLC 采集需要」——半年后有人想清理清单时，
                这一句是唯一能判断「还能不能删」的依据。</p>
            </FieldHelp>
          </template>
          <NInput v-model:value="approveForm.note" type="textarea"
                  :autosize="{ minRows: 2, maxRows: 4 }" placeholder="为什么需要这个节点" />
        </NFormItem>

        <NAlert v-if="approveErr" type="error" :bordered="false">{{ approveErr }}</NAlert>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="showApprove = false">取消</NButton>
          <NButton size="small" type="primary" :loading="approving"
                   :disabled="approveForm.module.trim() === ''" @click="submitApprove">
            批准
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 下发 -->
    <NModal v-model:show="showApply" preset="card" title="下发批准清单" style="max-width: 620px">
      <NAlert type="warning" :bordered="false" style="margin-bottom:14px">
        <b>下发会重写实例配置并重启选中的实例。</b>
        重启期间那台实例的采集与上报会中断几秒到几十秒。
        产线正在跑关键工序时，请等一个可以停的时间点。
      </NAlert>

      <p class="hint" style="margin-bottom:10px">
        默认全选。<b>漏掉一台的后果是那台的白名单与别处不一致</b>，
        而这种不一致平时看不出来，只有下一次有人在那台上装节点时才会暴露。
      </p>

      <div class="picks">
        <div v-for="i in instances" :key="i.id" class="pick">
          <NCheckbox :checked="applyTargets.includes(i.id)"
                     @update:checked="(v: boolean) => toggleTarget(i.id, v)">
            {{ i.name }}
          </NCheckbox>
          <span class="mono hint">{{ i.id }}</span>
          <span v-if="!i.running" class="hint">已停止 —— 配置照样写入，下次启动生效</span>
        </div>
      </div>

      <NAlert v-if="applyErr" type="error" :bordered="false" style="margin-top:12px">
        {{ applyErr }}
      </NAlert>

      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="showApply = false">取消</NButton>
          <NPopconfirm @positive-click="confirmApply">
            <template #trigger>
              <NButton size="small" type="primary" :loading="applying"
                       :disabled="applyTargets.length === 0">
                下发到 {{ applyTargets.length }} 台
              </NButton>
            </template>
            选中的实例会被重启，采集会中断。确定现在下发？
          </NPopconfirm>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h2 { margin: 0 0 4px; font-size: 20px; }
.sub { margin: 0; font-size: 12.5px; color: var(--muted); }

.sec { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; }
.sh { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.lead { margin: 0; font-size: 12.5px; color: var(--text-2); line-height: 1.75; max-width: 720px; }

.card { border-radius: var(--r); box-shadow: var(--shadow); }
.th { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.tn { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.name { font-size: 14px; font-weight: 600; }
.desc { margin: 10px 0 0; font-size: 12.5px; color: var(--text-2); line-height: 1.7; }
.meta {
  display: flex; gap: 18px; flex-wrap: wrap;
  margin-top: 10px; font-size: 11.5px; color: var(--muted);
}
.types { max-width: 100%; overflow-wrap: anywhere; }
.warn { margin-top: 12px; line-height: 1.75; }
.drift { line-height: 1.75; }

.filt { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

.file { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.file input { font-size: 12.5px; }

.rep { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--rs); }
.rrow { display: flex; align-items: baseline; gap: 10px; font-size: 12px; flex-wrap: wrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--success); }
.dot.bad { background: var(--error); }
.rf { color: var(--text-2); }
.rd { color: var(--muted); overflow-wrap: anywhere; }

.mods { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; }
.mod { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 5px 8px; border-radius: var(--rs); font-size: 12px; }
/* 未批准的那几行要一眼看见。用 inset 阴影而不是 border-left：
   加边框会把这一行的内容推开 2px，与其它行对不齐 */
.mod.alert { background: var(--grey100); box-shadow: inset 2px 0 0 var(--warning); }
.mname { font-weight: 500; }
.mver { color: var(--muted); }
.off { font-size: 11.5px; color: var(--muted); }

.picks { display: flex; flex-direction: column; gap: 8px; }
.pick { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }

.empty { padding: 40px 0; }
.hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0; }
/* 限定在正文内：scoped 样式会跟着插槽内容跑进 FieldHelp 的传送门（12 号文 5.1） */
.hint code, .lead code, .n-alert code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }
</style>
