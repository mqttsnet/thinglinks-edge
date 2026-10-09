<script setup lang="ts">
/**
 * 现场设备（T4.5）。
 *
 * 这一页有**两块来源完全不同**的内容，它们在界面上必须始终分开：
 *
 *   · **已纳管**：实例里的 `@thinglinks` 节点主动回报的台账，有在线状态、
 *     点位当前值与质量码 —— 这是可信的。
 *   · **未纳管**：从那台实例的 flows.json 反推出来的尽力探测，没有运行时数据、
 *     可能漏、可能认错 —— 这只是「看起来还接了这些东西」。
 *
 * 两边的数字**绝不相加**，也不放进同一张表。06 号文把这条定为诚信问题：
 * 让用户以为看到的是全厂全部设备，比让他知道「平台只看得见一部分」更糟 ——
 * 他会据此判断现场是不是都正常。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { NSelect, NSpin, NEmpty, NTag, NButton, NAlert, NPagination, useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../../api/client';
import TrendChart from '../../components/TrendChart.vue';
import FieldValue from './components/FieldValue.vue';
import { fieldDeviceStatus } from './field-status';
import { createFieldRefreshTask } from './field-refresh';
import { fieldTagKey, fieldServiceLabel, fieldTagPage, fieldServiceOptions } from './field-tags';
import type { TagHistory } from '../../api/types';
import type {
  Instance, FieldDeviceRecord, FieldTagRecord, FieldSummary, ProbeResult,
} from '../../api/types';
import FieldHelp from '../../components/FieldHelp.vue';
import RefreshButton from '../../components/RefreshButton.vue';

const router = useRouter();
const message = useMessage();

const loading = ref(true);
const manualRefreshing = ref(false);
const refreshError = ref('');
const instanceRefreshError = ref('');
const instances = ref<Instance[]>([]);
/** 空串 = 跨实例聚合。后端按登录者的授权逐条过滤，这里拿到多少就是他能看多少 */
const scope = ref('');
const summary = ref<FieldSummary | null>(null);
const devices = ref<FieldDeviceRecord[]>([]);
const instancesById = computed(() => new Map(instances.value.map((instance) => [instance.id, instance])));
const deviceStatus = (device: FieldDeviceRecord) =>
  fieldDeviceStatus(device, instancesById.value.get(device.instanceId));
const managedOnline = computed(() => devices.value.filter((device) => deviceStatus(device).online).length);

const scopeOptions = computed(() => [
  { label: '全部实例', value: '' },
  ...instances.value.map((i) => ({ label: `${i.name}（${i.id}）`, value: i.id })),
]);

// ── 已纳管台账 ──────────────────────────────────────────

const keyOf = (d: { instanceId: string; nodeId: string }) => `${d.instanceId}/${d.nodeId}`;

/*
 * 点位按设备懒加载，不在列表阶段全量拉：
 * 现场一台实例几千个点，全拉进来首屏要等，而用户一次只看一台设备。
 */
const expanded = ref<Set<string>>(new Set());
const tagsOf = ref<Map<string, FieldTagRecord[]>>(new Map());
const tagsBusy = ref<Set<string>>(new Set());
const tagErrors = ref<Map<string, string>>(new Map());
const tagRequests = new Map<string, Promise<void>>();
let tagGeneration = 0;

const serviceScopes = ref<Map<string, string>>(new Map());
const tagPages = ref<Map<string, number>>(new Map());
const visibleTags = computed(() => new Map([...tagsOf.value].map(([key, tags]) =>
  [key, fieldTagPage(tags, serviceScopes.value.get(key) ?? '*', tagPages.value.get(key) ?? 1)])));
const tagPage = (device: FieldDeviceRecord) => visibleTags.value.get(keyOf(device)) ?? fieldTagPage([], '*', 1);
function selectService(device: FieldDeviceRecord, serviceCode: string) {
  serviceScopes.value = new Map(serviceScopes.value).set(keyOf(device), serviceCode);
  tagPages.value = new Map(tagPages.value).set(keyOf(device), 1);
  closeTrend();
}
function selectTagPage(device: FieldDeviceRecord, page: number) {
  tagPages.value = new Map(tagPages.value).set(keyOf(device), page);
  closeTrend();
}

function loadTags(d: FieldDeviceRecord, quiet = false): Promise<void> {
  const k = keyOf(d);
  const active = tagRequests.get(k);
  if (active) return active;
  const generation = tagGeneration;
  tagsBusy.value = new Set(tagsBusy.value).add(k);
  const request = (async () => {
    try {
      const r = await api.fieldTags(d.instanceId, d.nodeId);
      if (generation !== tagGeneration) return;
      tagsOf.value = new Map(tagsOf.value).set(k, r.tags);
      const errors = new Map(tagErrors.value); errors.delete(k); tagErrors.value = errors;
    } catch (e) {
      if (generation !== tagGeneration) return;
      const error = e instanceof ApiError ? e.message : '点位加载失败';
      tagErrors.value = new Map(tagErrors.value).set(k, error);
      if (!quiet) message.error(error);
    }
  })().finally(() => {
    if (tagRequests.get(k) === request) tagRequests.delete(k);
    if (generation === tagGeneration) {
      const busy = new Set(tagsBusy.value); busy.delete(k); tagsBusy.value = busy;
    }
  });
  tagRequests.set(k, request);
  return request;
}

async function toggle(d: FieldDeviceRecord) {
  const k = keyOf(d);
  const next = new Set(expanded.value);
  if (next.has(k)) {
    next.delete(k);
    expanded.value = next;
    return;
  }
  next.add(k);
  expanded.value = next;
  await loadTags(d);
}

const instanceRefresh = createFieldRefreshTask();
const deviceRefresh = createFieldRefreshTask();
function loadInstances(): Promise<void> {
  return instanceRefresh.run(async (current) => {
    try {
      const r = await api.instances();
      if (current()) { instances.value = r.instances; instanceRefreshError.value = ''; }
    } catch { if (current()) instanceRefreshError.value = '实例状态刷新失败，当前保留上次状态；采集值仍可独立刷新。'; }
  });
}
function load(quiet = false, replace = false): Promise<void> {
  // 两路读取互不阻塞；慢请求由后续轮询复用，失败时保留最近确认的实例状态。
  void loadInstances();
  return deviceRefresh.run(async (current) => {
    try {
      const id = scope.value || undefined;
      const [s, d] = await Promise.all([api.fieldSummary(id), api.fieldDevices(id)]);
      if (!current()) return;
      summary.value = s;
      devices.value = d.devices;
      refreshError.value = '';

      // 展开着的设备跟着一起刷 —— 点位当前值本来就是这一页要盯的东西
      const alive = new Set(d.devices.map(keyOf));
      for (const k of manualRefreshing.value ? [] : expanded.value) {
        if (!alive.has(k)) continue;
        const dev = d.devices.find((x) => keyOf(x) === k);
        // 点位请求有自己的 busy 守卫；慢点位不占用台账刷新任务。
        if (dev) void loadTags(dev, true);
      }
    } catch (e) {
      if (current()) {
        refreshError.value = e instanceof ApiError ? e.message : '现场设备刷新失败';
        if (!quiet) message.error(refreshError.value);
      }
    } finally {
      if (current()) loading.value = false;
    }
  }, replace);
}

async function refreshField() {
  if (manualRefreshing.value) return;
  const generation = tagGeneration;
  manualRefreshing.value = true;
  try {
    const instanceRequest = loadInstances();
    await load();
    if (generation !== tagGeneration) return;
    await Promise.all([instanceRequest, ...devices.value.filter(d => expanded.value.has(keyOf(d))).map(d => loadTags(d))]);
    if (generation !== tagGeneration) return;
    const selected = [...tagsOf.value.values()].flat().find(tag => fieldTagKey(tag) === openTag.value);
    if (selected) await toggleTrend(selected, true);
  } finally { manualRefreshing.value = false; }
}

async function onScopeChange(v: string) {
  scope.value = v;
  // 换了范围，上一台实例的探测结果与展开状态都不再适用
  probe.value = null;
  probeNote.value = '';
  expanded.value = new Set();
  tagGeneration++; tagRequests.clear(); tagsBusy.value = new Set(); tagErrors.value = new Map();
  tagsOf.value = new Map();
  serviceScopes.value = new Map(); tagPages.value = new Map(); closeTrend();
  loading.value = true;
  await load(false, true);
}

let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(true), 10_000);
});
onBeforeUnmount(() => {
  tagGeneration++; tagRequests.clear();
  instanceRefresh.dispose();
  deviceRefresh.dispose();
  if (timer !== undefined) window.clearInterval(timer);
});

// ── 未纳管：南向探测 ─────────────────────────────────────

const probe = ref<ProbeResult | null>(null);
const probeNote = ref('');
const probing = ref(false);

/*
 * 探测不自动跑，要用户点。
 * 它读的是实例的 flows.json（可能几 MB），且结果对现场没有实时意义 ——
 * 用轮询定期解析纯属浪费，用户想看时点一下就够。
 */
async function runProbe() {
  if (!scope.value) return;
  probing.value = true;
  probeNote.value = '';
  try {
    const r = await api.southbound(scope.value);
    probe.value = r;
    if (r.reason) probeNote.value = r.reason;
  } catch (e) {
    probe.value = null;
    probeNote.value = e instanceof ApiError ? e.message : '探测失败';
  } finally {
    probing.value = false;
  }
}

/** 探测出的点位按设备归组；归不上的（认不出 owner）单独一组 */
const probedTagsOf = computed(() => {
  const m = new Map<string, number>();
  for (const t of probe.value?.tags ?? []) m.set(t.nodeId, (m.get(t.nodeId) ?? 0) + 1);
  return m;
});
const orphanTags = computed(() => (probe.value?.tags ?? []).filter((t) => t.nodeId === ''));

// ── 点位趋势 ────────────────────────────────────────────
/*
 * **点开哪个点位才查哪个**，不是展开设备就把所有点位的历史一起拉。
 * 一台设备几十个点位很常见，那样一次就是几十个查询打在正在跑采集的盒子上 ——
 * 而现场看趋势时，一次只关心一个点位。
 */
const openTag = ref('');
const hist = ref<TagHistory | null>(null);
const histBusy = ref(false);
let historyGeneration = 0;
function closeTrend() { historyGeneration++; openTag.value = ''; hist.value = null; histBusy.value = false; }

async function toggleTrend(tag: FieldTagRecord, force = false): Promise<void> {
  const k = fieldTagKey(tag);
  if (openTag.value === k && !force) { closeTrend(); return; }
  const generation = ++historyGeneration;
  openTag.value = k;
  hist.value = null;
  histBusy.value = true;
  try {
    const response = await api.tagHistory(tag.instanceId, tag.nodeId, tag.tagId, 300, tag.serviceCode || '');
    if ((response.serviceCode ?? '') !== (tag.serviceCode || '')) throw new ApiError(409, '历史记录的服务与当前点位不一致，请刷新后重试');
    if (generation === historyGeneration) hist.value = response;
  } catch (e) {
    if (generation === historyGeneration) { message.error(e instanceof ApiError ? e.message : '读取趋势失败'); openTag.value = ''; }
  } finally {
    if (generation === historyGeneration) histBusy.value = false;
  }
}

/** TrendChart 要的是等长的时间戳与数值数组；非数值点位画不出趋势，一律给 null 断线 */
const trendData = computed(() => {
  const pts = hist.value?.points ?? [];
  return {
    timestamps: pts.map((p) => Date.parse(p.at)),
    series: [{
      key: 'v', name: '数值', color: 'var(--chart-1)',
      values: pts.map((p) => (typeof p.value === 'number' ? p.value : null)),
    }],
  };
});

// ── 展示 ────────────────────────────────────────────────

/** 相对时间。绝对时刻放 title 里，排障时要对日志还是得看准点 */
function fmtAgo(iso: string | null): string {
  if (!iso) return '从未';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 0) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function fmtAbs(iso: string | null): string {
  if (!iso) return '从未上报过';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

/** 质量码只分「好」与「不好」两档展示：现场关心的是这个数能不能信 */
function qualityBad(q: string): boolean {
  return q !== '' && q.toLowerCase() !== 'good';
}
</script>

<template>
  <div class="page">
    <div class="bar">
      <div class="ttl">
        <h2>现场设备</h2>
        <p class="sub">已纳管的台账来自实例里的 @thinglinks 节点回报，带当前值与质量码</p>
      </div>
      <NSelect :value="scope" :options="scopeOptions" size="small" class="scope"
               :consistent-menu-width="false" @update:value="onScopeChange" />
      <RefreshButton :loading="manualRefreshing" label="刷新设备数据" @click="refreshField" />
    </div>

    <NAlert v-if="refreshError" type="error" :bordered="false">{{ refreshError }}，可点击刷新重试。</NAlert>
    <NAlert v-if="instanceRefreshError" type="warning" :bordered="false">{{ instanceRefreshError }}</NAlert>

    <NSpin :show="loading">
      <!-- ── 已纳管 ── -->
      <div class="card">
        <div class="ch">
          <h3>已纳管</h3>
          <span class="hint">
            节点主动回报，可信
            <FieldHelp>
              <p>实例的流程里用了 <code>tl-device</code> / <code>tl-tag</code> /
                <code>tl-uplink</code> 节点，设备与点位才会出现在这里 ——
                它们是设备<b>自己报上来</b>的，所以有在线状态、当前值和质量码。</p>
              <p>用原生 <code>modbus</code> / <code>opcua</code> / <code>s7</code> 节点采的那部分
                <b>不在这张表里</b>，平台看不见它们的运行时数据。下面那块「未纳管」是从流程文件
                反推出来的，只能告诉你「大概还接了这些」。</p>
              <p>两边的数字<b>不能相加</b>：它们不是同一种东西。</p>
            </FieldHelp>
          </span>
          <div v-if="summary" class="nums">
            <span><b class="num">{{ summary.managed.devices }}</b> 台设备</span>
            <span><b class="num" :class="{ warn: managedOnline < summary.managed.devices }">
              {{ managedOnline }}</b> 台在线</span>
            <span><b class="num">{{ summary.managed.tags }}</b> 个点位</span>
          </div>
        </div>

        <NEmpty v-if="summary && devices.length === 0 && !loading && !refreshError"
                description="还没有设备回报上来" style="padding: 30px 0">
          <template #extra>
            <p class="empty-tip">
              在实例的流程里放 <code>tl-device</code> 注册设备、<code>tl-tag</code> 上报点位值，
              这里就会出现台账。
            </p>
            <NButton size="small" @click="router.push({ name: 'instances' })">去实例页</NButton>
          </template>
        </NEmpty>

        <div v-else class="list">
          <div v-for="d in devices" :key="keyOf(d)" class="dev">
            <button type="button" class="head" :aria-expanded="expanded.has(keyOf(d))"
                    :aria-label="`${expanded.has(keyOf(d)) ? '收起' : '查看'}设备 ${d.name} 的点位`" @click="toggle(d)">
              <span class="caret" :class="{ open: expanded.has(keyOf(d)) }">›</span>
              <span class="dot" :class="{ on: deviceStatus(d).online }"
                    :title="deviceStatus(d).label" :aria-label="deviceStatus(d).label"></span>
              <span class="nm">{{ d.name }}</span>
              <NTag v-if="deviceStatus(d).instanceUnavailable" size="tiny">
                {{ deviceStatus(d).label }}
              </NTag>
              <span class="mono id">{{ d.nodeId }}</span>
              <NTag v-if="d.protocol" size="tiny" round>{{ d.protocol }}</NTag>
              <span v-if="d.address" class="mono addr">{{ d.address }}</span>
              <span v-if="!scope" class="mono inst" title="所属实例">{{ d.instanceId }}</span>
              <span class="seen" :title="fmtAbs(d.lastSeen)">{{ fmtAgo(d.lastSeen) }}</span>
            </button>

            <div v-if="expanded.has(keyOf(d))" class="tags">
              <NAlert v-if="tagErrors.get(keyOf(d))" type="error" :bordered="false">{{ tagErrors.get(keyOf(d)) }}，已保留上次点位数据；点击刷新可重试。</NAlert>
              <NAlert v-if="deviceStatus(d).instanceUnavailable" type="default" :bordered="false" class="last-values-note">
                {{ deviceStatus(d).label }}。以下保留最后一次采集值，可结合更新时间查看。
              </NAlert>
              <NSpin :show="tagsBusy.has(keyOf(d)) && !tagsOf.has(keyOf(d))" size="small">
                <NEmpty v-if="tagsOf.has(keyOf(d)) && (tagsOf.get(keyOf(d)) ?? []).length === 0 && !tagsBusy.has(keyOf(d)) && !tagErrors.has(keyOf(d))"
                        description="这台设备还没有点位" size="small" style="padding: 16px 0" />
                <div v-else class="service-selector">
                  <NSelect :value="serviceScopes.get(keyOf(d)) ?? '*'" :options="fieldServiceOptions(tagsOf.get(keyOf(d)) ?? [])"
                    size="small" :aria-label="`${d.name}的点位服务`" @update:value="selectService(d, $event)" />
                </div>
                <table v-if="tagPage(d).total">
                  <thead>
                    <tr><th>点位</th><th class="point-id">标识</th><th class="r">{{ deviceStatus(d).instanceUnavailable ? '最后采集值' : '当前值' }}</th><th class="point-quality">质量</th><th class="point-updated">更新</th><th class="r trend-action">操作</th></tr>
                  </thead>
                  <tbody>
                    <template v-for="({ value: t }, position) in tagPage(d).items" :key="fieldTagKey(t)">
                    <tr v-if="position === 0 || tagPage(d).items[position - 1]?.value.serviceCode !== t.serviceCode" class="service-group">
                      <td colspan="6">{{ fieldServiceLabel(t.serviceCode || '') }}</td>
                    </tr>
                    <tr>
                      <td class="point-name">{{ t.name || t.tagId }}
                        <span v-if="t.name && t.name !== t.tagId" class="compact-meta mono">{{ t.tagId }}</span>
                        <span class="compact-meta" :class="{ 'quality-warning': qualityBad(t.quality) }">{{ t.quality || 'good' }} · {{ fmtAgo(t.lastAt) }}</span>
                      </td>
                      <td class="mono muted point-id">{{ t.tagId }}</td>
                      <td class="r">
                        <FieldValue :value="t.lastValue" />
                        <span v-if="t.unit" class="unit">{{ t.unit }}</span>
                      </td>
                      <td class="point-quality">
                        <NTag v-if="qualityBad(t.quality)" size="tiny" type="warning">
                          {{ t.quality }}
                        </NTag>
                        <span v-else class="muted">good</span>
                      </td>
                      <td class="muted point-updated" :title="fmtAbs(t.lastAt)">{{ fmtAgo(t.lastAt) }}</td>
                      <td class="r trend-action">
                        <NButton size="small" type="primary" class="trend-button"
                                 :ghost="openTag !== fieldTagKey(t)"
                                 :class="{ 'is-open': openTag === fieldTagKey(t) }"
                                 :aria-expanded="openTag === fieldTagKey(t)"
                                 :aria-label="`${fieldServiceLabel(t.serviceCode || '')} ${t.tagId} ${openTag === fieldTagKey(t) ? '收起趋势' : '查看趋势'}`"
                                 @click="toggleTrend(t)">
                          <template #icon>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path v-if="openTag === fieldTagKey(t)" d="m6 15 6-6 6 6" />
                              <path v-else d="M4 4v16h16M7 14l4-4 4 3 5-7" />
                            </svg>
                          </template>
                          {{ openTag === fieldTagKey(t) ? '收起趋势' : '查看趋势' }}
                        </NButton>
                      </td>
                    </tr>
                    <tr v-if="openTag === fieldTagKey(t)" class="trend">
                      <td colspan="6">
                        <div class="trend-content">
                        <NSpin :show="histBusy" size="small">
                          <!-- 未启用要说清是配置关掉的，不是采集坏了 -->
                          <NAlert v-if="hist && !hist.enabled" type="default" :bordered="false">
                            {{ hist.reason ?? '本部署未启用点位历史' }}
                          </NAlert>
                          <template v-else-if="hist">
                            <TrendChart :timestamps="trendData.timestamps" :series="trendData.series"
                                        :unit="t.unit" :height="150"
                                        empty-text="这个点位还没有历史采样" />
                            <p class="hint">
                              共 {{ hist.points.length }} 个采样点。
                              <template v-if="hist.oldest">
                                全库最早一条是 {{ fmtAbs(hist.oldest) }} —— 历史按**条数**封顶
                                （{{ hist.rows }} / {{ hist.maxRows }}），
                                所以能看多久随点位数量浮动。
                              </template>
                              值没变时不重复记录，只每隔一段留一个锚点，因此曲线上的点是稀疏的。
                            </p>
                          </template>
                        </NSpin>
                        </div>
                      </td>
                    </tr>
                    </template>
                  </tbody>
                </table>
                <div v-if="tagPage(d).total" class="tag-pagination">
                  <span class="hint">第 {{ tagPage(d).start + 1 }}–{{ tagPage(d).end }} 个，共 {{ tagPage(d).total }} 个点位</span>
                  <NPagination v-if="tagPage(d).pageCount > 1" :page="tagPage(d).page" :page-count="tagPage(d).pageCount" :page-slot="5"
                    size="small" :aria-label="`${d.name}点位分页`" @update:page="selectTagPage(d, $event)" />
                </div>
              </NSpin>
            </div>
          </div>
        </div>
      </div>

      <!-- ── 未纳管 ── -->
      <div class="card probe">
        <div class="ch">
          <h3>未纳管</h3>
          <span class="hint">
            从流程文件反推，尽力而为
            <FieldHelp>
              <p>解析这台实例的 <code>flows.json</code>，把你用原生
                <code>modbus</code> / <code>opcua</code> / <code>s7</code> 节点接的设备
                <b>尽量</b>认出来。</p>
              <p>它<b>拿不到运行时数据</b>：没有当前值、没有质量码、也不知道在不在线 ——
                那些只有 @thinglinks 节点回报的设备才有。</p>
              <p>而且<b>可能漏</b>：用 function 节点动态拼地址的，这里认不出来。
                所以它只能用来对照「我还接了什么没纳管」，不能当台账用。</p>
            </FieldHelp>
          </span>
          <div class="acts">
            <NButton size="tiny" :loading="probing" :disabled="!scope" @click="runProbe">
              {{ probe ? '重新探测' : '探测这台实例' }}
            </NButton>
          </div>
        </div>

        <NAlert v-if="!scope" type="default" :bordered="false" size="small">
          探测要读某一台实例的流程文件，请先在右上角选定实例。
        </NAlert>

        <template v-else>
          <NAlert v-if="probeNote" type="warning" :bordered="false" size="small"
                  style="margin-bottom: 12px">
            {{ probeNote }}
          </NAlert>

          <p v-if="!probe && !probing && !probeNote" class="idle">
            还没探测过。点上面的按钮看看这台实例里还接了哪些没纳管的设备。
          </p>

          <template v-if="probe">
            <NEmpty v-if="probe.devices.length === 0 && probe.unrecognized.length === 0"
                    description="没认出任何原生南向节点" size="small" style="padding: 22px 0" />

            <div v-if="probe.devices.length > 0" class="ptable">
              <table>
                <thead>
                  <tr><th>设备</th><th>协议</th><th>地址</th><th>点位</th><th>节点类型</th></tr>
                </thead>
                <tbody>
                  <tr v-for="d in probe.devices" :key="d.nodeId">
                    <td>
                      {{ d.name || d.nodeId }}
                      <NTag size="tiny" round type="warning" class="unmanaged">未纳管</NTag>
                    </td>
                    <td class="mono">{{ d.protocol }}</td>
                    <td class="mono muted">{{ d.address }}</td>
                    <td class="num">{{ probedTagsOf.get(d.nodeId) ?? 0 }}</td>
                    <td class="mono muted">{{ d.sourceType }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p v-if="orphanTags.length > 0" class="note">
              另有 <b class="num">{{ orphanTags.length }}</b> 个点位节点没认出归属设备
              （多半是 OPC UA 的 Item 直接挂在客户端上）。
            </p>

            <div v-if="probe.unrecognized.length > 0" class="unknown">
              <p class="note">
                还见到这些<b>认不出</b>的节点类型 —— 它们背后可能也接着设备，平台看不懂：
              </p>
              <div class="chips">
                <NTag v-for="u in probe.unrecognized" :key="u.type" size="small" round>
                  <span class="mono">{{ u.type }}</span>
                  <span class="cnt">×{{ u.count }}</span>
                </NTag>
              </div>
            </div>
          </template>
        </template>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.scope { min-width: 200px; }

.card {
  background: var(--surface); border-radius: var(--r); box-shadow: var(--shadow);
  padding: 18px 20px; margin-bottom: 2px;
}
/* 未纳管那块整体压一档，视觉上就不会被读成和上面同级的台账 */
.card.probe { margin-top: 18px; background: var(--sidebar); }
.ch { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.ch h3 { margin: 0; font-size: 15px; font-weight: 650; }
.hint { font-size: 11.5px; color: var(--muted); }
.nums { margin-left: auto; display: flex; gap: 16px; font-size: 12.5px; color: var(--text-2); }
.nums b { font-size: 15px; font-weight: 650; color: var(--text); margin-right: 3px; }
.nums b.warn { color: var(--warning); }
.acts { margin-left: auto; }

.list { display: flex; flex-direction: column; }
.dev { border-bottom: 1px solid var(--border); }
.dev:last-child { border-bottom: none; }
.head {
  display: flex; align-items: center; gap: 10px; padding: 10px 0;
  width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left;
  cursor: pointer; user-select: none;
}
.head:hover { background: var(--hover); }
.head:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.caret { color: var(--muted); transition: transform .15s; font-size: 15px; line-height: 1; }
.caret.open { transform: rotate(90deg); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.on { background: var(--success); }
.nm { font-weight: 600; }
.id { color: var(--text-2); }
.addr { color: var(--muted); }
.inst { color: var(--muted); margin-left: 4px; }
.seen { margin-left: auto; font-size: 12px; color: var(--muted); white-space: nowrap; }

.tags { padding: 4px 0 14px 26px; }
.last-values-note { margin-bottom: 10px; }
.service-selector { max-width: 420px; margin: 8px 0 12px; }
.service-group td { color: var(--primary); font-weight: 600; background: var(--sidebar); }
.tag-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; }
.trend-action { width: 1%; white-space: nowrap; }
.compact-meta { display: none; }
.trend-button { min-width: 104px; }
.trend-button:not(.is-open) { background: rgba(var(--primary-glow), .06); }
.trend-button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.trend-content { contain: inline-size; }
.trend > td { padding: 10px 6px 14px; }
.trend .hint { margin: 8px 0 0; font-size: 12px; color: var(--text-3); line-height: 1.7; }
.more, .note, .idle { margin: 10px 0 0; font-size: 12px; color: var(--muted); }
.empty-tip { margin: 0 0 10px; font-size: 12.5px; color: var(--muted); }

table { border-collapse: collapse; width: 100%; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
thead th { font-size: 11.5px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
.r { text-align: right; }
.unit { margin-left: 4px; font-size: 11.5px; color: var(--muted); }
.muted { color: var(--muted); }

.ptable { overflow-x: auto; }
.unmanaged { margin-left: 8px; }
.unknown { margin-top: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cnt { margin-left: 5px; color: var(--muted); }

.page :deep(code) { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }

@media (max-width: 700px) {
  .addr, .inst { display: none; }
  .nums { width: 100%; margin-left: 0; }
  .tags { padding-left: 0; }
  .tags .point-id, .tags .point-quality, .tags .point-updated { display: none; }
  .tags th, .tags td { padding-left: 4px; padding-right: 4px; }
  .point-name { overflow-wrap: anywhere; }
  .compact-meta { display: block; font-size: 11px; color: var(--muted); }
  .compact-meta.quality-warning { color: var(--warning); }
  .head { flex-wrap: wrap; gap: 6px; }
  .head .id { overflow-wrap: anywhere; }
  .trend-button { min-width: 96px; }
}
</style>
