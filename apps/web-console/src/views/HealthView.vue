<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { NCard, NTag, NProgress, NSpin, NEmpty, NAlert, useMessage } from 'naive-ui';
import { api, ApiError } from '../api/client';
import type { InstanceHealth, HostStats, HealthSummary } from '../api/types';

const message = useMessage();
const summary = ref<HealthSummary | null>(null);
const host = ref<HostStats | null>(null);
const list = ref<InstanceHealth[]>([]);
const loading = ref(true);
let timer: number | undefined;

async function refresh(quiet = false) {
  try {
    const r = await api.health();
    summary.value = r.summary; host.value = r.host; list.value = r.instances;
  } catch (e) {
    if (!quiet) message.error(e instanceof ApiError ? e.message : '加载失败');
  } finally { loading.value = false; }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(true), 5000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });

const verdict = (v: InstanceHealth['verdict']) =>
  v === 'healthy' ? { type: 'success' as const, text: '正常' }
  : v === 'degraded' ? { type: 'warning' as const, text: '降级' }
  : { type: 'error' as const, text: '异常' };

const barStatus = (p: number) => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success');
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>健康监测</h2>
        <p class="sub">三层探针：容器 · 应用 · 业务，每 5 秒刷新</p>
      </div>
    </div>

    <NSpin :show="loading">
      <div v-if="summary" class="kpis">
        <NCard class="kpi" :bordered="false">
          <span class="k">实例总数</span><div class="v num">{{ summary.total }}</div>
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

      <NCard v-if="host" title="宿主资源" class="block" :bordered="false">
        <div class="host">
          <div class="m">
            <div class="r"><span class="lb">CPU 负载</span>
              <span class="num">{{ host.loadPercent ?? '—' }}%（{{ host.cpuCount }} 核）</span></div>
            <NProgress v-if="host.loadPercent !== null" type="line" :percentage="Math.min(host.loadPercent, 100)"
                       :status="barStatus(host.loadPercent)" :show-indicator="false" :height="6" />
          </div>
          <div class="m">
            <div class="r"><span class="lb">内存</span>
              <span class="num">{{ host.memUsedMb }} / {{ host.memTotalMb }} MB</span></div>
            <NProgress type="line" :percentage="host.memPercent"
                       :status="host.memReliable ? barStatus(host.memPercent) : 'default'"
                       :show-indicator="false" :height="6" />
          </div>
          <div class="m">
            <div class="r"><span class="lb">磁盘</span>
              <span class="num">{{ host.diskUsedGb ?? '—' }} / {{ host.diskTotalGb ?? '—' }} GB</span></div>
            <NProgress v-if="host.diskPercent !== null" type="line" :percentage="host.diskPercent"
                       :status="barStatus(host.diskPercent)" :show-indicator="false" :height="6" />
          </div>
        </div>
        <NAlert v-if="!host.memReliable" type="info" :bordered="false" style="margin-top:14px">
          当前平台读不到 <code class="mono">MemAvailable</code>，内存百分比包含可回收缓存、会偏高，
          因此不作为阻止创建实例的依据。生产环境（Linux）读数准确。
        </NAlert>
      </NCard>

      <NEmpty v-if="!loading && list.length === 0" description="还没有实例" style="padding: 40px 0" />

      <div v-else class="grid">
        <NCard v-for="h in list" :key="h.id" class="item" :bordered="false">
          <div class="head">
            <span class="id mono">{{ h.id }}</span>
            <NTag :type="verdict(h.verdict).type" size="small" round>{{ verdict(h.verdict).text }}</NTag>
          </div>

          <div class="layer">
            <div class="lname">容器层</div>
            <div class="r"><span class="lb">状态</span>
              <span>{{ h.container.state }}<span v-if="h.container.restartCount" class="warn">
                · 重启 {{ h.container.restartCount }} 次</span></span></div>
            <div class="r" v-if="h.container.cpuPercent !== null">
              <span class="lb">CPU</span><span class="num">{{ h.container.cpuPercent }}%</span></div>
            <div class="r" v-if="h.container.memUsedMb !== null">
              <span class="lb">内存</span>
              <span class="num">{{ h.container.memUsedMb }} / {{ h.container.memLimitMb }} MB</span></div>
          </div>

          <div class="layer">
            <div class="lname">应用层</div>
            <div class="r"><span class="lb">HTTP 探针</span>
              <span v-if="h.app.ok" class="ok num">{{ h.app.status }} · {{ h.app.latencyMs }}ms</span>
              <span v-else class="bad">{{ h.app.error ?? '不通' }}</span></div>
          </div>

          <div class="layer last">
            <div class="lname">业务层</div>
            <div class="r"><span class="lb">流程</span>
              <span :class="h.flow.started ? 'ok' : 'bad'">{{ h.flow.started ? '已启动' : '未启动' }}</span></div>
            <div class="r"><span class="lb">近期错误</span>
              <span :class="h.flow.recentErrors ? 'bad num' : 'num'">{{ h.flow.recentErrors }}</span></div>
            <div v-if="h.flow.lastError" class="err mono">{{ h.flow.lastError }}</div>
          </div>
        </NCard>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 18px; }
.kpi { border-radius: var(--r); box-shadow: var(--shadow); }
.kpi .k { font-size: 12.5px; color: var(--muted); }
.kpi .v { font-size: 25px; font-weight: 650; line-height: 1.25; }
.block { border-radius: var(--r); box-shadow: var(--shadow); margin-bottom: 18px; }
.host { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
.m { display: flex; flex-direction: column; gap: 7px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; }
.item { border-radius: var(--r); box-shadow: var(--shadow); }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.id { font-weight: 600; }
.layer { padding-bottom: 11px; margin-bottom: 11px; border-bottom: 1px solid var(--border); }
.layer.last { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
.lname { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
.r { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 2px 0; }
.lb { color: var(--muted); }
.ok { color: var(--success); } .bad { color: var(--error); } .warn { color: var(--warning); }
.err { margin-top: 6px; font-size: 11px; color: var(--error); word-break: break-all; line-height: 1.5; }
code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }
</style>
