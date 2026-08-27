<script setup lang="ts">
/**
 * 健康监测。
 *
 * 看板要回答的从来不只是「此刻好不好」，而是「这段时间发生过什么」——
 * 纯数字看板看不出内存在缓慢爬升，也看不出凌晨那次短暂重启。
 * 所以每一项都配了时间维度：宿主三项资源一张趋势图，每个实例一条状态带
 * 加三条曲线（CPU / 内存 / 探针延迟）。
 *
 * 两个数据源分工明确：
 *   `/api/health`  —— 此刻的三层探针，每 5 秒现探一次
 *   `/api/metrics` —— 后台采样攒下的历史，纯读内存，刷曲线不加探针压力
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard, NTag, NSpin, NEmpty, NAlert, NButton, NRadioGroup, NRadioButton, useMessage,
} from 'naive-ui';
import { api, ApiError } from '../api/client';
import type {
  InstanceHealth, HostStats, HealthSummary, MetricsSeries, MetricsRange,
} from '../api/types';
import TrendChart, { type TrendSeries } from '../components/TrendChart.vue';
import RingGauge from '../components/RingGauge.vue';
import StatusStrip from '../components/StatusStrip.vue';
import FieldHelp from '../components/FieldHelp.vue';

const router = useRouter();
const message = useMessage();

const summary = ref<HealthSummary | null>(null);
const host = ref<HostStats | null>(null);
const list = ref<InstanceHealth[]>([]);
const loading = ref(true);

const RANGES: { value: MetricsRange; label: string }[] = [
  { value: '10m', label: '10 分钟' },
  { value: '1h', label: '1 小时' },
  { value: '6h', label: '6 小时' },
  { value: '24h', label: '24 小时' },
];
const range = ref<MetricsRange>('1h');
const trend = ref<MetricsSeries | null>(null);

let healthTimer: number | undefined;
let trendTimer: number | undefined;

async function refresh(quiet = false) {
  try {
    const r = await api.health();
    summary.value = r.summary; host.value = r.host; list.value = r.instances;
  } catch (e) {
    if (!quiet) message.error(e instanceof ApiError ? e.message : '加载失败');
  } finally { loading.value = false; }
}

async function loadTrend(quiet = false) {
  try {
    trend.value = await api.metrics(range.value);
  } catch (e) {
    if (!quiet) message.error(e instanceof ApiError ? e.message : '趋势加载失败');
  }
}

onMounted(() => {
  void refresh();
  void loadTrend();
  healthTimer = window.setInterval(() => void refresh(true), 5000);
  // 曲线刷得比探针慢：一个点最快也要 10 秒才生成，刷再快也只是重画同一张图
  trendTimer = window.setInterval(() => void loadTrend(true), 15000);
});
onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer);
  if (trendTimer) clearInterval(trendTimer);
});
watch(range, () => void loadTrend());

// ── 曲线数据 ────────────────────────────────────────────

const points = computed(() => trend.value?.points ?? []);
const timestamps = computed(() => points.value.map((p) => p.t));

const hostSeries = computed<TrendSeries[]>(() => [
  { key: 'load', name: 'CPU 负载', color: 'var(--chart-1)',
    values: points.value.map((p) => p.host.loadPercent) },
  { key: 'mem', name: '内存', color: 'var(--chart-2)',
    values: points.value.map((p) => p.host.memPercent) },
  { key: 'disk', name: '磁盘', color: 'var(--chart-3)',
    values: points.value.map((p) => p.host.diskPercent) },
]);

function instanceSeries(id: string, field: 'cpuPercent' | 'memUsedMb' | 'latencyMs',
                        name: string, color: string): TrendSeries[] {
  return [{ key: `${id}-${field}`, name, color,
            values: points.value.map((p) => p.instances[id]?.[field] ?? null) }];
}

function statusPoints(id: string) {
  return points.value.map((p) => ({ t: p.t, verdict: p.instances[id]?.verdict ?? null }));
}

/**
 * 图里没有数据时，必须说清是哪一种「没有」——
 * 「没开采样」「刚启动还没攒够」「这个实例当时还不存在」是三件不同的事，
 * 都显示成「暂无数据」的话，运维只能靠猜。
 */
const emptyText = computed(() => {
  if (!trend.value) return '正在加载趋势数据…';
  if (!trend.value.enabled) return '未启用指标采样：Manager 的 EDGE_METRICS_INTERVAL_SEC 设为 0，趋势曲线不可用';
  if (points.value.length === 0) return '正在累计数据 —— 历史只存在 Manager 内存里，重启后从零开始';
  return '所选窗口内没有采样点';
});

const sinceText = computed(() => {
  const first = trend.value?.firstSampleAt;
  if (!first) return '';
  const min = Math.floor((Date.now() - first) / 60000);
  if (min < 1) return '刚开始采集';
  if (min < 60) return `已累计 ${min} 分钟`;
  return `已累计 ${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
});

// ── 状态呈现 ────────────────────────────────────────────

const verdict = (v: InstanceHealth['verdict']) =>
  v === 'healthy' ? { type: 'success' as const, text: '正常' }
  : v === 'degraded' ? { type: 'warning' as const, text: '降级' }
  : { type: 'error' as const, text: '异常' };

/** 把秒数说成人话 */
function duration(sec: number): string {
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/** 运行时长：连续运行多久，是判断「是不是偷偷重启过」的第一眼线索 */
function uptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return duration(ms / 1000);
}

function currentOf(h: InstanceHealth, field: 'cpuPercent' | 'memUsedMb' | 'latencyMs'): string {
  if (field === 'cpuPercent') return h.container.cpuPercent === null ? '—' : `${h.container.cpuPercent}%`;
  if (field === 'memUsedMb') {
    return h.container.memUsedMb === null ? '—'
      : `${h.container.memUsedMb} / ${h.container.memLimitMb ?? '—'} MB`;
  }
  return h.app.ok && h.app.latencyMs !== null ? `${h.app.latencyMs} ms` : '不通';
}

/** 汇总条的占比。总数为 0 时不画，免得出现一条含义不明的空条 */
const shares = computed(() => {
  const s = summary.value;
  if (!s || s.total === 0) return [];
  return ([
    { key: 'healthy', n: s.healthy, color: 'var(--success)' },
    { key: 'degraded', n: s.degraded, color: 'var(--warning)' },
    { key: 'down', n: s.down, color: 'var(--error)' },
  ]).filter((x) => x.n > 0);
});
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>健康监测</h2>
        <p class="sub">
          三层探针：容器 · 应用 · 业务，每 5 秒刷新
          <FieldHelp>
            <p>上方数字是<b>此刻</b>的探针结果；下方曲线是后台每
              {{ trend?.intervalSec || 10 }} 秒采一次攒出来的历史。</p>
            <p>历史<b>只存在 Manager 内存里</b>，重启后从零开始 ——
              这是为了不往边缘盒子的 SD 卡上反复写库。要长期留存请接云端。</p>
            <p class="fh-warn">因此看到曲线只有一小段，多半是 Manager 刚重启过，不是采集坏了。</p>
          </FieldHelp>
        </p>
      </div>
      <div class="rng">
        <NRadioGroup v-model:value="range" size="small">
          <NRadioButton v-for="r in RANGES" :key="r.value" :value="r.value" :label="r.label" />
        </NRadioGroup>
        <span v-if="sinceText" class="since">{{ sinceText }}</span>
      </div>
    </div>

    <NSpin :show="loading">
      <div v-if="summary" class="kpis">
        <NCard class="kpi" :bordered="false">
          <span class="k">实例总数</span>
          <div class="v num">{{ summary.total }}</div>
          <div v-if="shares.length" class="share">
            <i v-for="s in shares" :key="s.key" :style="{ flexGrow: s.n, background: s.color }" />
          </div>
        </NCard>
        <NCard class="kpi" :bordered="false">
          <span class="k">正常</span>
          <div class="v num" style="color: var(--success)">{{ summary.healthy }}</div>
        </NCard>
        <NCard class="kpi" :bordered="false">
          <span class="k">降级</span>
          <div class="v num" style="color: var(--warning)">{{ summary.degraded }}</div>
        </NCard>
        <NCard class="kpi" :bordered="false">
          <span class="k">异常</span>
          <div class="v num" style="color: var(--error)">{{ summary.down }}</div>
        </NCard>
      </div>

      <NCard v-if="host" class="block" :bordered="false">
        <div class="ch">
          <h3>宿主资源</h3>
          <span class="hint">{{ host.cpuCount }} 核 · 已运行 {{ duration(host.uptimeSec) }}</span>
        </div>

        <div class="host">
          <div class="rings">
            <RingGauge label="CPU 负载" :percent="host.loadPercent"
                       :detail="`${host.cpuCount} 核`" />
            <RingGauge label="内存" :percent="host.memPercent"
                       :detail="`${host.memUsedMb} / ${host.memTotalMb} MB`" />
            <RingGauge label="磁盘" :percent="host.diskPercent"
                       :detail="host.diskTotalGb === null ? '读不到' : `${host.diskUsedGb} / ${host.diskTotalGb} GB`" />
          </div>
          <div class="chart">
            <div class="ct">
              资源趋势
              <FieldHelp>
                <p>CPU 负载是<b>1 分钟平均负载相对核数</b>的百分比，不是瞬时占用率。</p>
                <p>它可以超过 100%：<code>100%</code> 表示所有核刚好排满，
                  <code>200%</code> 表示还有同样多的任务在排队等 CPU。</p>
                <p>纵轴按数据自动缩放，不固定 0–100 —— 现场 CPU 常年个位数，
                  钉死 100 的话曲线永远贴着底边，什么都看不出来。</p>
              </FieldHelp>
            </div>
            <TrendChart :timestamps="timestamps" :series="hostSeries" unit="%"
                        :height="212" :empty-text="emptyText" />
          </div>
        </div>

        <NAlert v-if="!host.memReliable" type="info" :bordered="false" style="margin-top:14px">
          当前平台读不到 <code class="hint-code mono">MemAvailable</code>，内存百分比包含可回收缓存、会偏高，
          因此不作为阻止创建实例的依据，曲线上的内存线同样偏高。生产环境（Linux）读数准确。
        </NAlert>
      </NCard>

      <NEmpty v-if="!loading && list.length === 0" description="还没有实例" style="padding: 40px 0">
        <template #extra>
          <NButton size="small" type="primary" @click="router.push({ name: 'instances' })">
            创建第一个实例
          </NButton>
        </template>
      </NEmpty>

      <template v-else>
        <div class="sect">
          <h3>实例</h3>
          <span class="lgd">
            <i style="background: var(--success)" />正常
            <i style="background: var(--warning)" />降级
            <i style="background: var(--error)" />异常
            <i style="background: var(--border)" />无数据
          </span>
        </div>

        <div class="grid">
          <NCard v-for="h in list" :key="h.id" class="item" :bordered="false">
            <div class="head">
              <span class="id mono">{{ h.id }}</span>
              <NTag :type="verdict(h.verdict).type" size="small" round>{{ verdict(h.verdict).text }}</NTag>
            </div>

            <div class="stat">
              <div class="sr">
                <span class="lb">状态带 · 最近 {{ RANGES.find((r) => r.value === range)?.label }}</span>
                <span class="hint">连续运行 {{ uptime(h.container.startedAt) }}</span>
              </div>
              <StatusStrip :points="statusPoints(h.id)" />
            </div>

            <div class="metrics">
              <div class="m">
                <div class="mr"><span class="lb">CPU</span><b class="num">{{ currentOf(h, 'cpuPercent') }}</b></div>
                <TrendChart :timestamps="timestamps"
                            :series="instanceSeries(h.id, 'cpuPercent', 'CPU', 'var(--chart-1)')"
                            unit="%" :height="46" compact empty-text="无历史数据" />
              </div>
              <div class="m">
                <div class="mr"><span class="lb">内存</span><b class="num">{{ currentOf(h, 'memUsedMb') }}</b></div>
                <TrendChart :timestamps="timestamps"
                            :series="instanceSeries(h.id, 'memUsedMb', '内存', 'var(--chart-2)')"
                            unit="MB" :height="46" compact empty-text="无历史数据" />
              </div>
              <div class="m">
                <div class="mr">
                  <span class="lb">探针延迟
                    <FieldHelp>
                      <p>Manager 请求实例编辑器入口的往返耗时，反映的是
                        <b>Node-RED 进程还答不答得动</b>，不是设备侧的通信延迟。</p>
                      <p>探不通时曲线<b>断开</b>而不是画成一个很大的值 ——
                        失败用了多久不是延迟，混进来会把整条曲线带偏。</p>
                    </FieldHelp>
                  </span>
                  <b class="num" :class="{ bad: !h.app.ok }">{{ currentOf(h, 'latencyMs') }}</b>
                </div>
                <TrendChart :timestamps="timestamps"
                            :series="instanceSeries(h.id, 'latencyMs', '延迟', 'var(--chart-4)')"
                            unit="ms" :height="46" compact empty-text="无历史数据" />
              </div>
            </div>

            <div class="layers">
              <div class="layer">
                <div class="lname">容器层</div>
                <div class="r"><span class="lb">状态</span>
                  <span>{{ h.container.state }}<span v-if="h.container.restartCount" class="warn">
                    · 重启 {{ h.container.restartCount }} 次</span></span></div>
              </div>
              <div class="layer">
                <div class="lname">应用层</div>
                <div class="r"><span class="lb">HTTP 探针</span>
                  <span v-if="h.app.ok" class="ok num">{{ h.app.status }} · {{ h.app.latencyMs }}ms</span>
                  <span v-else class="bad">{{ h.app.error ?? '不通' }}</span></div>
              </div>
              <div class="layer">
                <div class="lname">业务层</div>
                <div class="r"><span class="lb">流程</span>
                  <span :class="h.flow.started ? 'ok' : 'bad'">{{ h.flow.started ? '已启动' : '未启动' }}</span></div>
                <div class="r"><span class="lb">近期错误</span>
                  <span :class="h.flow.recentErrors ? 'bad num' : 'num'">{{ h.flow.recentErrors }}</span></div>
              </div>
            </div>

            <div v-if="h.flow.lastError" class="err mono">{{ h.flow.lastError }}</div>
          </NCard>
        </div>
      </template>
    </NSpin>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.rng { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.since { font-size: 11.5px; color: var(--muted); }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 18px; }
.kpi { border-radius: var(--r); box-shadow: var(--shadow); }
.kpi .k { font-size: 12.5px; color: var(--muted); }
.kpi .v { font-size: 25px; font-weight: 650; line-height: 1.25; }
.share { display: flex; gap: 2px; height: 4px; margin-top: 6px; border-radius: 3px; overflow: hidden; }
.share i { flex-basis: 0; }

.block { border-radius: var(--r); box-shadow: var(--shadow); margin-bottom: 18px; }
.ch { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.ch h3, .sect h3 { margin: 0; font-size: 15px; font-weight: 650; }
.hint { font-size: 11.5px; color: var(--muted); }
.host { display: grid; grid-template-columns: auto 1fr; gap: 26px; align-items: center; }
.rings { display: flex; gap: 18px; flex-wrap: wrap; justify-content: center; }
.chart { min-width: 0; }
.ct { font-size: 12.5px; color: var(--text-2); margin-bottom: 2px; }

.sect { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: -4px; }
.lgd { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); }
.lgd i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-left: 7px; }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
.item { border-radius: var(--r); box-shadow: var(--shadow); }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.id { font-weight: 600; }

.stat { margin-bottom: 14px; }
.sr { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 14px; }
.m { min-width: 0; }
.mr { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; font-size: 12px; }
.mr b { font-weight: 600; font-size: 12.5px; }
.mr b.bad { color: var(--error); }

.layers { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px;
          border-top: 1px solid var(--border); padding-top: 11px; }
.lname { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 5px; }
.r { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; padding: 1px 0; }
.lb { color: var(--muted); }
.ok { color: var(--success); } .bad { color: var(--error); } .warn { color: var(--warning); }
.err { margin-top: 10px; font-size: 11px; color: var(--error); word-break: break-all; line-height: 1.5; }
/* 元素选择器一律加类名限定：裸 code{} 会顺着插槽跑进 tooltip 的传送门，见 12 号文 5.1 */
.hint-code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }

@media (max-width: 900px) {
  .host { grid-template-columns: 1fr; gap: 16px; }
  .grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .metrics { grid-template-columns: 1fr; }
}
</style>
