<script setup lang="ts">
/**
 * 实例实时日志。
 *
 * 用 EventSource 而不是轮询：日志是单向流，浏览器原生带自动重连。
 * 但它无法带自定义头，所以鉴权只能靠同源 Cookie —— 后端 SSE 路由也正是这么校验的。
 *
 * 「暂停」不断开连接，只是把新行压进待入缓冲。读日志时最烦的就是刚看到一行
 * 就被新内容顶走，而断开重连又会丢掉这期间的行。
 */
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NTag, NSelect, NInput, NEmpty, NSpin, useMessage } from 'naive-ui';
import { basePath } from '../api/client';

/** 超过这个行数就丢最旧的 —— 现场机器长期挂着不能无限吃内存 */
const MAX_LINES = 5000;

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'audit', 'metric'] as const;
type Level = (typeof LEVELS)[number] | 'other';

interface Line { seq: number; stream: 'stdout' | 'stderr'; text: string; level: Level }

const route = useRoute();
const router = useRouter();
const message = useMessage();
const id = String(route.params['id'] ?? '');

const lines = ref<Line[]>([]);
const pending: Line[] = [];
const paused = ref(false);
const pendingCount = ref(0);
const connected = ref(false);
const connecting = ref(true);
const levelFilter = ref<Level[]>([]);
const keyword = ref('');
const follow = ref(true);
const body = ref<HTMLElement | null>(null);

let source: EventSource | undefined;
let seq = 0;

/** Node-RED 行形如 `26 Aug 10:00:00 - [info] Started flows` */
const LEVEL_RE = /\[(fatal|error|warn|info|debug|trace|audit|metric)\]/i;
function levelOf(text: string): Level {
  const m = LEVEL_RE.exec(text);
  return m ? (m[1]!.toLowerCase() as Level) : 'other';
}

function append(raw: { stream: 'stdout' | 'stderr'; text: string }) {
  const line: Line = { seq: seq++, stream: raw.stream, text: raw.text, level: levelOf(raw.text) };
  if (paused.value) {
    pending.push(line);
    pendingCount.value = pending.length;
    return;
  }
  lines.value.push(line);
  if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES);
}

function resume() {
  paused.value = false;
  lines.value.push(...pending.splice(0));
  if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES);
  pendingCount.value = 0;
}

function connect() {
  connecting.value = true;
  source = new EventSource(`${basePath}/api/instances/${id}/logs/stream?tail=500`);
  source.onopen = () => { connected.value = true; connecting.value = false; };
  source.onmessage = (e) => {
    try { append(JSON.parse(e.data)); } catch { /* 忽略半截事件 */ }
  };
  source.onerror = () => {
    connected.value = false;
    // readyState 为 CLOSED 说明浏览器已放弃重连（401/404 都会走到这里）
    if (source?.readyState === EventSource.CLOSED) {
      connecting.value = false;
      message.error('日志连接已断开，可能是登录态失效或实例已删除');
    }
  };
}

onMounted(connect);
onUnmounted(() => source?.close());

const visible = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const levels = levelFilter.value;
  return lines.value.filter(
    (l) => (levels.length === 0 || levels.includes(l.level)) &&
           (kw === '' || l.text.toLowerCase().includes(kw)),
  );
});

// 只有贴着底部时才自动滚动，否则会把正在看的内容顶走
watch(visible, () => {
  if (!follow.value) return;
  void nextTick(() => { if (body.value) body.value.scrollTop = body.value.scrollHeight; });
});

function onScroll() {
  const el = body.value;
  if (!el) return;
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function exportLogs() {
  // 导出的是**当前过滤结果**，不是全部 —— 通常要发给别人的就是筛出来的那段
  const text = visible.value.map((l) => l.text).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `${id}-${stamp}.log`;
  a.click();
  URL.revokeObjectURL(url);
  message.success(`已导出 ${visible.value.length} 行`);
}

const levelOptions = [...LEVELS, 'other' as const].map((l) => ({ label: l, value: l }));
const counts = computed(() => ({
  error: lines.value.filter((l) => l.level === 'error' || l.level === 'fatal').length,
  warn: lines.value.filter((l) => l.level === 'warn').length,
}));
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>
          <NButton text @click="router.push('/instances')">实例</NButton>
          <span class="sep">/</span>
          <span class="mono">{{ id }}</span>
          <span class="sub">日志</span>
        </h2>
        <p class="hint">
          实时跟随，最多保留 {{ MAX_LINES.toLocaleString() }} 行
          <template v-if="counts.error"> · <span class="e">{{ counts.error }} 条错误</span></template>
          <template v-if="counts.warn"> · <span class="w">{{ counts.warn }} 条告警</span></template>
        </p>
      </div>
      <NTag :type="connected ? 'success' : connecting ? 'warning' : 'error'" size="small" round>
        {{ connected ? '已连接' : connecting ? '连接中' : '已断开' }}
      </NTag>
    </div>

    <div class="tools">
      <NSelect v-model:value="levelFilter" multiple clearable :options="levelOptions"
               placeholder="按级别过滤（默认全部）" style="min-width: 260px" size="small" />
      <NInput v-model:value="keyword" clearable placeholder="关键字" size="small" style="max-width: 240px" />
      <div class="spacer" />
      <NButton v-if="paused" size="small" type="primary" @click="resume">
        继续{{ pendingCount ? `（${pendingCount} 行待入）` : '' }}
      </NButton>
      <NButton v-else size="small" @click="paused = true">暂停</NButton>
      <NButton size="small" @click="lines = []">清空</NButton>
      <NButton size="small" :disabled="visible.length === 0" @click="exportLogs">导出</NButton>
    </div>

    <div ref="body" class="body mono" @scroll="onScroll">
      <NSpin v-if="connecting && lines.length === 0" size="small" style="margin: 40px auto; display: block" />
      <NEmpty v-else-if="visible.length === 0" description="没有匹配的日志" style="margin: 48px 0" />
      <div v-for="l in visible" :key="l.seq" class="line" :class="[l.level, l.stream]">{{ l.text }}</div>
    </div>

    <div v-if="!follow" class="jump">
      <NButton size="tiny" round @click="follow = true; body && (body.scrollTop = body.scrollHeight)">
        回到底部
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; position: relative; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h2 { margin: 0; font-size: 20px; display: flex; align-items: baseline; gap: 8px; }
.sep { color: var(--muted); }
.sub { font-size: 14px; color: var(--text-2); font-weight: 400; }
.hint { margin: 4px 0 0; color: var(--text-2); font-size: 13px; }
.e { color: var(--error); }
.w { color: var(--warning); }
.tools { display: flex; align-items: center; gap: 10px; margin: 16px 0 12px; flex-wrap: wrap; }
.spacer { flex: 1; }
.body {
  flex: 1; min-height: 0; overflow: auto; padding: 12px 14px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r);
  box-shadow: var(--shadow); font-size: 12.5px; line-height: 1.65;
}
.line { white-space: pre-wrap; word-break: break-all; padding: 1px 0; border-left: 3px solid transparent; padding-left: 8px; }
.line.error, .line.fatal { color: var(--error); border-left-color: var(--error); background: var(--l-error); }
.line.warn { color: var(--warning); border-left-color: var(--warning); background: var(--l-warning); }
.line.stderr { border-left-color: var(--error); }
.line.debug, .line.trace { color: var(--muted); }
.jump { position: absolute; right: 26px; bottom: 22px; }
</style>
