<script setup lang="ts">
/**
 * 云平台对接。
 *
 * 页面分成三块，顺序是有意的：**先状态、再参数、最后数据面**。
 * 打开这一页的人九成是在问「现在到底连上没有」，那件事必须在第一屏。
 *
 * 密钥字段永远拿不到明文（后端只回「设没设」），所以输入框留空 = 不修改，
 * 这条规则必须在界面上写死说明 —— 否则用户会以为留空是清空。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  NButton, NCard, NForm, NFormItem, NInput, NSelect, NSwitch, NSpace,
  NAlert, NSpin, NTag, NInputNumber, useMessage, useDialog,
} from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type {
  CloudConfigView, CloudStatus, SpoolMetrics, CipherFlag, EdgeMetrics,
  TlsMode, CertSummary, BrokerScheme, MqttVersion,
} from '../../api/types';
import {
  DEFAULT_BROKER_HOST, BROKER_SCHEMES, } from '../../api/types';
import { can } from '../../api/permissions';
import FieldHelp from '../../components/FieldHelp.vue';
import {
  splitBroker, joinBroker, isWs, isSecure,
  portOnSchemeChange, pathOnSchemeChange, defaultBroker,
} from './broker-url.ts';
import { summarizeOutage, summarizeReplay } from './outage-format.ts';
import type { ReplayProgress, OutageRecord } from '../../api/types.ts';

const message = useMessage();
const dialog = useDialog();

const loading = ref(true);
const saving = ref(false);
const config = ref<CloudConfigView | null>(null);
const status = ref<CloudStatus | null>(null);
const spool = ref<SpoolMetrics | null>(null);
/** 补传进度与预计完成。etaSec 为 null 时由 reason 说明原因，界面照原样转述 */
const replay = ref<ReplayProgress | null>(null);
/** 最近断网记录。当前状态答不了「昨晚断了多久」，这张表才能 */
const outages = ref<OutageRecord[] | null>(null);
/** 数据面明细。与 api.cloud() 的 spool 概要分开取：那边只够画一条提示，这边要画整张卡 */
const metrics = ref<EdgeMetrics | null>(null);
const replaying = ref(false);
let timer: number | undefined;

const canReplay = computed(() => can('replay:run'));

/** 补传按钮为什么不能点。**必须说清楚** —— 一个灰着不解释的按钮等于没有 */
const replayBlock = computed(() => {
  const m = metrics.value;
  if (!m) return '正在读取数据面状态';
  if (!m.spool) return '未启用断网缓存，没有可补传的数据';
  if (m.cloud !== 'configured') return '云连接未配置，补传无处可发';
  if (m.spool.pending === 0) return '当前没有积压，不需要补传';
  return '';
});

async function doReplay() {
  replaying.value = true;
  try {
    const r = await api.replaySpool();
    // 报实数而不是「已触发」：现场要的是「到底补出去几条」
    message.success(
      r.failed > 0
        ? `补传 ${r.sent} 条，仍有 ${r.failed} 条失败`
        : `补传完成，共 ${r.sent} 条`,
    );
    await refresh(true);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '补传失败');
  } finally {
    replaying.value = false;
  }
}

const form = ref({
  enabled: true,
  /*
   * 地址在界面上拆成四段填，提交前拼回一整条 URL。
   *
   * 拆开是因为手敲整条 URL 最容易错在两处：协议写成 http、端口漏掉。
   * 下拉选协议就写不错，端口单独一格就漏不掉。
   *
   * 新装的现场直接给默认地址：绝大多数人接的就是公有云，
   * 让他去文档里翻一个固定不变的地址是没有必要的一步。
   */
  scheme: 'mqtt://' as BrokerScheme,
  host: DEFAULT_BROKER_HOST,
  port: 11883,
  /** 只有 ws/wss 用得上 */
  path: '/mqtt',
  clientId: '',
  deviceIdentification: '',
  username: '',
  password: '',
  cipherFlag: 0 as CipherFlag,
  signKey: '',
  encryptKey: '',
  encryptVector: '',
  /** 证书部分。ca/cert/key 留空一律表示「不修改」，与口令同一套语义 */
  tls: {
    mode: 'system' as TlsMode,
    ca: '',
    cert: '',
    key: '',
    rejectUnauthorized: true,
    servername: '',
  },
  connection: {
    mqttVersion: 5 as MqttVersion,
    keepaliveSec: 60,
    connectTimeoutSec: 15,
    autoReconnect: true,
    reconnectPeriodMs: 5000,
  },
  protocolVersion: 'v1',
  qos: 1 as 0 | 1 | 2,
});

const CIPHER_OPTIONS = [
  { label: '0 · 明文（仅签名，不加密）', value: 0 },
  { label: '1 · SM4（国密，密钥 16 字节）', value: 1 },
  { label: '2 · AES（密钥 16/24/32 字节）', value: 2 },
];
const SCHEME_OPTIONS = BROKER_SCHEMES.map((value) => ({ label: value, value }));
const MQTT_VERSION_OPTIONS = [
  { label: 'MQTT 5.0（推荐）', value: 5 },
  { label: 'MQTT 3.1.1', value: 4 },
  { label: 'MQTT 3.1', value: 3 },
];
const TLS_MODE_OPTIONS = [
  { label: '系统根证书（公网签发的证书选这个）', value: 'system' },
  { label: '自签 CA（上传 CA 证书）', value: 'ca' },
  { label: '双向认证（CA + 客户端证书与私钥）', value: 'mutual' },
];
const QOS_OPTIONS = [
  { label: 'QoS 0 · 最多一次', value: 0 },
  { label: 'QoS 1 · 至少一次（推荐）', value: 1 },
  { label: 'QoS 2 · 恰好一次', value: 2 },
];

async function refresh(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    const r = await api.cloud();
    config.value = r.config;
    status.value = r.status;
    spool.value = r.spool;
    replay.value = r.replay;
    outages.value = r.outages;
    // 单独一路，失败不影响上面的连接状态显示
    metrics.value = await api.edgeMetrics().catch(() => null);
    // 只在非静默刷新时回填表单，否则用户正在输入的内容会被轮询冲掉
    if (!quiet && r.config) {
      const parts = splitBroker(r.config.brokerUrl);
      form.value = {
        enabled: r.config.enabled,
        scheme: parts.scheme,
        host: parts.host,
        port: parts.port,
        path: parts.path,
        clientId: r.config.clientId,
        deviceIdentification: r.config.deviceIdentification,
        username: r.config.username,
        password: '',
        cipherFlag: r.config.cipherFlag,
        signKey: '',
        encryptKey: '',
        encryptVector: '',
        tls: {
          mode: r.config.tls.mode,
          // 证书材料一律不回填：后端回的是摘要不是 PEM，
          // 拿摘要去填输入框，用户一保存就把真正的证书覆盖成一串摘要文字了
          ca: '',
          cert: '',
          key: '',
          rejectUnauthorized: r.config.tls.rejectUnauthorized,
          servername: r.config.tls.servername,
        },
        connection: { ...r.config.connection },
        protocolVersion: r.config.protocolVersion,
        qos: r.config.qos,
      };
    }
  } catch (e) {
    if (!quiet) message.error(e instanceof ApiError ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(true), 5000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });

const STATE_TEXT: Record<string, { text: string; type: 'success' | 'error' | 'warning' | 'default' }> = {
  online: { text: '已连接', type: 'success' },
  connecting: { text: '连接中', type: 'warning' },
  offline: { text: '已断开', type: 'error' },
  disabled: { text: '已关闭', type: 'default' },
  unconfigured: { text: '未配置', type: 'default' },
};
const stateInfo = computed(() => STATE_TEXT[status.value?.state ?? 'unconfigured']
  ?? { text: status.value?.state ?? '—', type: 'default' as const });

/** 加密关闭时不必填密钥，界面也不该逼着填 */
const needsCipherKeys = computed(() => form.value.cipherFlag !== 0);

/** 拼回给后端的整条地址。拆拼规则与它的单测都在 ./broker-url.ts */
const brokerUrl = computed(() => joinBroker(form.value));

/** 链路加不加密，只看 scheme —— 与后端同一条规则 */
const secure = computed(() => isSecure(form.value.scheme));

/**
 * 换协议时把端口与路径一并带过去。规则与单测都在 ./broker-url.ts：
 * 端口只在用户没自己改过时跟随，路径只在为空时补默认值。
 */
function onSchemeChange(next: BrokerScheme) {
  form.value.port = portOnSchemeChange(form.value.port, next);
  form.value.path = pathOnSchemeChange(form.value.path, next);
  form.value.scheme = next;
}

/** mutual 才需要客户端证书；system 连 CA 都不用传 */
const needsCa = computed(() => form.value.tls.mode !== 'system');
const needsClientCert = computed(() => form.value.tls.mode === 'mutual');

/**
 * 地址改成明文、而库里存着证书 —— 保存会把那套证书清掉。
 *
 * 这件事必须**提前说**：证书是现场找运维要来的，被静默清掉之后
 * 没有任何地方能看出是哪一步弄丢的。
 */
const willDropCerts = computed(() =>
  !secure.value && config.value != null && config.value.tls.mode !== 'system');

/** 一键填默认地址。现场手敲域名最容易把协议和端口配错 */
function useDefaultBroker(tls: boolean) {
  Object.assign(form.value, defaultBroker(tls));
  if (!tls) form.value.tls.mode = 'system';
}

/**
 * 从文件读 PEM。
 *
 * 现场拿到的证书是 `.crt`/`.pem`/`.key` 文件，不是一段能复制的文本；
 * 逼着用户拿记事本打开再粘贴，很容易粘漏最后一行或带上多余字符。
 */
async function pickPem(field: 'ca' | 'cert' | 'key') {
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = '.pem,.crt,.cer,.key,.txt,application/x-pem-file,text/plain';
  el.onchange = async () => {
    const file = el.files?.[0];
    if (!file) return;
    try {
      form.value.tls[field] = (await file.text()).trim();
    } catch {
      message.error('读取证书文件失败');
    }
  };
  el.click();
}

/** 摘要里的有效期给本地时间，别让人去换算 UTC */
const certValid = (c: CertSummary) =>
  `${new Date(c.validFrom).toLocaleDateString()} — ${new Date(c.validTo).toLocaleDateString()}`;

/** 已存过的密钥字段留空表示不改；没存过的必须填 */
function secretField(local: string, alreadySet: boolean | undefined): string | undefined {
  if (local !== '') return local;
  return alreadySet ? undefined : '';
}

async function save() {
  saving.value = true;
  try {
    const set = config.value?.secretsSet;
    const r = await api.saveCloud({
      enabled: form.value.enabled,
      brokerUrl: brokerUrl.value,
      clientId: form.value.clientId.trim(),
      deviceIdentification: form.value.deviceIdentification.trim(),
      username: form.value.username.trim(),
      password: secretField(form.value.password, set?.password),
      cipherFlag: form.value.cipherFlag,
      signKey: secretField(form.value.signKey, set?.signKey),
      encryptKey: needsCipherKeys.value ? secretField(form.value.encryptKey, set?.encryptKey) : undefined,
      encryptVector: needsCipherKeys.value ? secretField(form.value.encryptVector, set?.encryptVector) : undefined,
      tls: {
        // 明文地址下强制 system：后端会拒绝「明文地址 + 证书」，
        // 界面这里跟着收敛，用户才不会卡在一个救不回来的报错上
        mode: secure.value ? form.value.tls.mode : 'system',
        ca: needsCa.value ? secretField(form.value.tls.ca, config.value?.tls.ca != null) : undefined,
        cert: needsClientCert.value
          ? secretField(form.value.tls.cert, config.value?.tls.cert != null) : undefined,
        key: needsClientCert.value ? secretField(form.value.tls.key, set?.tlsKey) : undefined,
        rejectUnauthorized: form.value.tls.rejectUnauthorized,
        servername: form.value.tls.servername.trim(),
      },
      connection: { ...form.value.connection },
      protocolVersion: form.value.protocolVersion.trim() || 'v1',
      qos: form.value.qos,
    });
    config.value = r.config;
    status.value = r.status;
    // 保存成功后清空密钥输入框，避免明文长期停留在页面上
    form.value.password = '';
    form.value.signKey = '';
    form.value.encryptKey = '';
    form.value.encryptVector = '';
    form.value.tls.ca = '';
    form.value.tls.cert = '';
    form.value.tls.key = '';

    if (r.status.state === 'online') message.success('已保存，云平台连接成功');
    else if (r.status.state === 'disabled') message.success('已保存（云对接处于关闭状态）');
    else message.warning(`已保存，但当前状态为「${STATE_TEXT[r.status.state]?.text ?? r.status.state}」，后台仍在重试`);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function reconnect() {
  try {
    const r = await api.reconnectCloud();
    status.value = r.status;
    if (r.status.state === 'online') message.success('已重新连接');
    else message.warning(`重连未成功：${r.status.lastError || r.status.state}`);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '重连失败');
  }
}

function unlink() {
  dialog.warning({
    title: '解除云平台对接',
    content: '将断开连接并**删除**已保存的接入凭据（口令、signKey、加密密钥、客户端私钥与证书）。'
      + '本地采集与实例不受影响，但上行数据会开始堆积在断网缓存里。',
    positiveText: '解除对接',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const r = await api.unlinkCloud();
        status.value = r.status;
        config.value = null;
        message.success('已解除对接');
        await refresh();
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '操作失败');
      }
    },
  });
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const kb = (n: number) => (n / 1024).toFixed(1);
const localTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * SQLite 的 `datetime('now')` 是 **UTC**，且不带时区标记（`2026-08-27 08:46:02`）。
 * 直接丢给 `new Date()` 会被当成本地时间，于是同一张卡上「上次修改 08:46」
 * 与「上次连上 16:46」差了 8 小时 —— 看的人会以为是两回事。补上 Z 再转本地。
 */
const dbTime = (v: string | undefined) =>
  (v ? new Date(`${v.replace(' ', 'T')}Z`).toLocaleString() : '—');
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>云平台对接</h2>
        <p class="sub">边缘以一台「网关设备」的身份接入，现场设备作为它的子设备</p>
      </div>
    </div>

    <NSpin :show="loading">
      <!-- 第一屏：现在到底连上没有 -->
      <NCard class="card" :bordered="false">
        <div class="st">
          <span class="dot" :class="`s-${stateInfo.type}`" />
          <span class="st-text" :class="`t-${stateInfo.type}`">{{ stateInfo.text }}</span>
          <span v-if="status?.brokerUrl" class="mono muted">{{ status.brokerUrl }}</span>
          <NTag v-if="status?.configured" size="small" :bordered="false"
                :type="status.secure ? 'success' : 'default'">
            {{ status.secure ? 'TLS 加密' : '明文' }}
          </NTag>
          <!-- 关掉证书校验是一次安全降级，必须一直挂在第一屏，而不是只在保存那一刻提一句 -->
          <NTag v-if="status?.secure && !status.rejectUnauthorized" size="small"
                :bordered="false" type="warning">未校验服务端证书</NTag>
          <div class="spacer" />
          <NButton size="small" :disabled="!status?.configured" @click="reconnect">重新连接</NButton>
          <NButton size="small" quaternary type="error" :disabled="!config" @click="unlink">解除对接</NButton>
        </div>

        <div class="kv">
          <div><span class="lb">网关设备</span><span class="mono">{{ status?.deviceIdentification || '—' }}</span></div>
          <div><span class="lb">上次连上</span><span>{{ localTime(status?.connectedAt ?? null) }}</span></div>
          <div><span class="lb">已上行</span><span class="num">{{ status?.published ?? 0 }} 批</span></div>
          <div><span class="lb">发送失败</span><span class="num">{{ status?.failed ?? 0 }} 批</span></div>
        </div>

        <NAlert v-if="status?.lastError" type="warning" :bordered="false" style="margin-top:12px">
          最近一次错误（{{ localTime(status.lastErrorAt) }}）：{{ status.lastError }}
        </NAlert>

        <NAlert v-if="spool && spool.pending > 0" type="info" :bordered="false" style="margin-top:12px">
          {{ summarizeReplay(replay) }}，占用 {{ mb(spool.bytes) }} MB / {{ mb(spool.maxBytes) }} MB。
          <template v-if="replay?.etaSec === null">
            <br /><span class="sm muted">
              预计完成时间要有实测速率才算得出来 —— 没有就如实说没有，不猜一个数。
            </span>
          </template>
        </NAlert>
      </NCard>

      <!-- 第一屏半：数据面明细。紧跟状态卡，回答「数据到底走没走出去」 -->
      <NCard class="card" :bordered="false">
        <div class="head">
          <h3>
            微批与积压
            <FieldHelp>
              <p>点位不是一条一发。<b>攒批</b>把同一时间窗内的点合成一条消息上行，
                现场几千个点时能把消息数降两个数量级。</p>
              <p>发不出去时（断网、云端拒绝）转入<b>断网缓存</b>落盘，
                链路恢复后在实时数据之外的余量里自动补发。</p>
              <p>这张卡回答的是「数据到底走没走出去」—— 连接是绿的但积压一直涨，
                说明能连上却发不成功。</p>
            </FieldHelp>
          </h3>
          <NButton
            v-if="canReplay" size="small" :loading="replaying"
            :disabled="replayBlock !== ''" :title="replayBlock"
            @click="doReplay">立即补传</NButton>
        </div>

        <template v-if="metrics">
          <h4 class="sec">
            微批
            <span class="lim mono">
              {{ metrics.batch.limits.windowMs }}ms /
              {{ metrics.batch.limits.maxPoints }} 点 /
              {{ Math.round(metrics.batch.limits.maxBytes / 1024) }}KB
            </span>
            <FieldHelp>
              <p>三个阈值<b>任一达到就立刻发出</b>，不是等三个都满。</p>
              <p>时间窗保证低频点位不会一直压着不发；点数与字节上限保证高频时
                单条消息不至于过大。</p>
            </FieldHelp>
          </h4>
          <div class="kv">
            <div>
              <span class="lb">当前待发</span>
              <span class="num">{{ metrics.batch.pending }} 点 · {{ kb(metrics.batch.pendingBytes) }} KB</span>
            </div>
            <div><span class="lb">累计发出</span><span class="num">{{ metrics.batch.batches }} 批 / {{ metrics.batch.points }} 点</span></div>
            <div>
              <span class="lb">
                发送失败
                <FieldHelp>
                  <p>失败的点<b>不会丢</b>，会转入下面的断网缓存等待补传。</p>
                  <p>这个数只增不减 —— 它记的是「历史上失败过多少点」，
                    不是「现在还有多少没发出去」。后者看下面的「待补传」。</p>
                </FieldHelp>
              </span>
              <span class="num" :class="{ bad: metrics.batch.failures > 0 }">{{ metrics.batch.failures }} 点</span>
            </div>
            <div><span class="lb">转入缓存</span><span class="num">{{ metrics.batch.spooled }} 批</span></div>
          </div>

          <template v-if="metrics.spool">
            <h4 class="sec">
              断网缓存
              <span class="lim mono">{{ metrics.spool.policy }}</span>
              <FieldHelp>
                <p>写满之后怎么办由<b>写满策略</b>决定，部署时配置：
                  丢最旧、丢最新、或拒绝新数据。</p>
                <p>三种都会丢数据，区别只在丢哪一头 —— 现场要按业务性质选：
                  趋势类丢最旧，告警类宁可拒绝新写入也不能丢历史。</p>
              </FieldHelp>
            </h4>
            <div class="kv">
              <div>
                <span class="lb">待补传</span>
                <span class="num" :class="{ warn: metrics.spool.pending > 0 }">{{ metrics.spool.pending }} 条</span>
              </div>
              <div>
                <span class="lb">占用</span>
                <span class="num" :class="{ bad: metrics.spool.usagePercent >= 90 }">
                  {{ mb(metrics.spool.bytes) }} / {{ mb(metrics.spool.maxBytes) }} MB
                  （{{ metrics.spool.usagePercent }}%）
                </span>
              </div>
              <div><span class="lb">分段数</span><span class="num">{{ metrics.spool.segments }}</span></div>
              <div><span class="lb">已补传</span><span class="num">{{ metrics.spool.replayed }} 条</span></div>
            </div>

            <NAlert v-if="metrics.spool.full" type="error" :bordered="false" style="margin-top:12px">
              断网缓存<b>已写满</b>，正在按「{{ metrics.spool.policy }}」策略丢弃数据。
              已丢弃：最旧 {{ metrics.spool.droppedOldest }} 条 ·
              最新 {{ metrics.spool.droppedNewest }} 条 ·
              拒绝写入 {{ metrics.spool.rejected }} 条。
              请尽快恢复云链路，或扩大缓存上限。
            </NAlert>
            <NAlert
              v-else-if="metrics.spool.droppedOldest + metrics.spool.droppedNewest + metrics.spool.rejected > 0"
              type="warning" :bordered="false" style="margin-top:12px">
              历史上曾因写满丢弃过数据：最旧 {{ metrics.spool.droppedOldest }} 条 ·
              最新 {{ metrics.spool.droppedNewest }} 条 · 拒绝写入 {{ metrics.spool.rejected }} 条。
            </NAlert>
          </template>
          <p v-else class="hint sec">
            未启用断网缓存。发不出去的数据会<b>直接丢弃</b>并计入上面的「发送失败」，
            断网期间的现场数据不会保留。
          </p>

          <NAlert v-if="metrics.batch.lastError" type="warning" :bordered="false" style="margin-top:12px">
            数据面最近一次错误：{{ metrics.batch.lastError }}
          </NAlert>
        </template>
        <p v-else class="hint">读取数据面状态失败，稍后自动重试。</p>
      </NCard>

      <!-- 断网记录：事后追溯「昨晚断了多久、丢没丢、补完没有」 -->
      <NCard v-if="outages && outages.length" class="card" title="最近断网记录" :bordered="false">
        <template #header-extra>
          <span class="sm muted">最近 {{ outages.length }} 次</span>
        </template>
        <div class="outages">
          <div v-for="o in outages" :key="o.id" class="outage">
            <span class="dot" :class="`s-${summarizeOutage(o).tone}`" />
            <div class="o-main">
              <div class="o-when mono">{{ dbTime(o.startedAt.replace('T', ' ').replace('Z', '')) }}</div>
              <div class="o-text" :class="`t-${summarizeOutage(o).tone}`">
                {{ summarizeOutage(o).text }}
              </div>
              <div v-if="o.note" class="sm muted">{{ o.note }}</div>
            </div>
            <div class="o-num sm muted">
              峰值 {{ o.peakPending }} 条
            </div>
          </div>
        </div>
      </NCard>

      <!-- 第二屏：接入参数 -->
      <NCard class="card" title="接入参数" :bordered="false">
        <NForm label-placement="top">
          <NFormItem>
            <template #label>
              启用云对接
              <FieldHelp>
                <p>关掉之后<b>不删除凭据</b>，只是断开连接、停止上行。</p>
                <p class="fh-warn">关闭期间采集到的数据会进断网缓存，缓存写满后按部署时配置的策略取舍。
                  长期不接云的现场应当用「解除对接」而不是长期关闭。</p>
              </FieldHelp>
            </template>
            <NSwitch v-model:value="form.enabled" />
          </NFormItem>

          <NFormItem>
            <template #label>
              Broker 地址
              <FieldHelp>
                <p>ThingLinks 公有云默认主机 <code>{{ DEFAULT_BROKER_HOST }}</code>，
                  明文端口 <code>11883</code>、加密端口 <code>11884</code>。自建平台按实际地址填。</p>
                <p>加不加密<b>由左边的协议决定</b>：<code>mqtts</code>/<code>wss</code> 加密，
                  <code>mqtt</code>/<code>ws</code> 不加密 —— 选了加密协议，下面的
                  「传输加密（TLS）」那一段才会展开。走公网请务必用加密的，
                  明文链路上的 MQTT 口令等于没有口令。</p>
                <p>换协议时端口会跟着换成该协议的默认值，但<b>你自己改过的端口不会被动</b>。</p>
                <p class="fh-warn">不要把账号口令填进主机格（<code>user:pass@host</code>），
                  填到下面的用户名与口令里 —— 写进地址会让凭据同时躺在两处。</p>
              </FieldHelp>
            </template>
            <!-- 协议下拉 + 主机 + 端口：手敲整条 URL 最容易错在协议和端口这两处 -->
            <div class="addr">
              <NSelect
                class="addr-scheme mono" :value="form.scheme" :options="SCHEME_OPTIONS"
                :consistent-menu-width="false" @update:value="onSchemeChange" />
              <NInput v-model:value="form.host" class="mono addr-host"
                      :placeholder="DEFAULT_BROKER_HOST" />
              <span class="colon">:</span>
              <NInputNumber v-model:value="form.port" class="mono addr-port"
                            :min="1" :max="65535" :show-button="false" placeholder="端口" />
              <NInput v-if="isWs(form.scheme)" v-model:value="form.path"
                      class="mono addr-path" placeholder="/mqtt" />
            </div>
            <template #feedback>
              <span class="quick">
                <!-- 无 href 的 a 默认不可聚焦，补 tabindex 与回车，别让只用键盘的人够不着 -->
                <a tabindex="0" @click="useDefaultBroker(true)"
                   @keydown.enter="useDefaultBroker(true)">用默认加密地址（11884）</a>
                <span class="sep">·</span>
                <a tabindex="0" @click="useDefaultBroker(false)"
                   @keydown.enter="useDefaultBroker(false)">用默认明文地址（11883）</a>
                <span class="sep">·</span>
                <!-- 拼出来的整条地址就在眼前，省得人去脑补四段拼起来是什么样 -->
                <span class="mono url">{{ brokerUrl }}</span>
                <span class="sep">·</span>
                <span :class="secure ? 'ok' : 'warn'">
                  {{ secure ? '加密' : '明文' }}
                </span>
              </span>
            </template>
          </NFormItem>

          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                clientId
                <FieldHelp>
                  <p>平台分配的 <b>雪花ID@租户ID</b>，例如 <code>2130020836696064@1</code>。</p>
                  <p class="fh-warn">它与下面的「设备标识」<b>不是同一个值</b>（同一台网关实测差 1），
                    互相代填会连不上，而且报错只说鉴权失败，看不出是这里错了。</p>
                  <p>从云平台的设备详情页原样复制，不要自己拼。</p>
                </FieldHelp>
              </template>
              <NInput v-model:value="form.clientId" class="mono" placeholder="2130020836696064@1" />
            </NFormItem>
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                设备标识
                <FieldHelp>
                  <p>网关设备的 <code>deviceIdentification</code>，所有 topic 里用的就是它，
                    例如 <code>/v1/devices/&lt;设备标识&gt;/datas</code>。</p>
                  <p>不能含空格、<code>/</code>、<code>+</code>、<code>#</code> —— 会把 topic 切坏，
                    而云端不会报错，只是收不到。</p>
                </FieldHelp>
              </template>
              <NInput v-model:value="form.deviceIdentification" class="mono" placeholder="edge-gw-01" />
            </NFormItem>
          </NSpace>

          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:280px" label="MQTT 用户名">
              <NInput v-model:value="form.username" class="mono" />
            </NFormItem>
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                MQTT 口令
                <span v-if="config?.secretsSet.password" class="kept">已设置 · 留空表示不修改</span>
              </template>
              <NInput v-model:value="form.password" type="password" show-password-on="click"
                      :placeholder="config?.secretsSet.password ? '留空表示不修改' : ''" />
            </NFormItem>
          </NSpace>

          <NFormItem>
            <template #label>
              signKey
              <span v-if="config?.secretsSet.signKey" class="kept">已设置 · 留空表示不修改</span>
              <FieldHelp>
                <p>每条上行报文的 <code>dataSign</code> 都由它算出：
                  <code>sha256(时间戳 + ":" + signKey)</code>。</p>
                <p class="fh-warn">填错<b>不会连不上</b>，只是云端每条都验签失败、数据全被丢弃 ——
                  现场表现为「连接正常但平台看不到数据」，很难查。</p>
              </FieldHelp>
            </template>
            <NInput v-model:value="form.signKey" type="password" show-password-on="click"
                    :placeholder="config?.secretsSet.signKey ? '留空表示不修改' : ''" />
          </NFormItem>

          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                报文加密
                <FieldHelp>
                  <p>决定 <code>dataBody</code> 是否加密传输，必须与云端产品配置<b>完全一致</b>。</p>
                  <p>加密算法为 CBC + PKCS5Padding，密钥与初始向量按 UTF-8 取字节：
                    SM4 密钥 16 字节，AES 密钥 16/24/32 字节，初始向量固定 16 字节。</p>
                </FieldHelp>
              </template>
              <NSelect v-model:value="form.cipherFlag" :options="CIPHER_OPTIONS" />
            </NFormItem>
            <NFormItem style="flex:1;min-width:280px" label="上行 QoS">
              <NSelect v-model:value="form.qos" :options="QOS_OPTIONS" />
            </NFormItem>
          </NSpace>

          <NSpace v-if="needsCipherKeys" :size="14">
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                encryptKey
                <span v-if="config?.secretsSet.encryptKey" class="kept">已设置 · 留空表示不修改</span>
              </template>
              <NInput v-model:value="form.encryptKey" type="password" show-password-on="click"
                      :placeholder="config?.secretsSet.encryptKey ? '留空表示不修改' : ''" />
            </NFormItem>
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                encryptVector
                <span v-if="config?.secretsSet.encryptVector" class="kept">已设置 · 留空表示不修改</span>
              </template>
              <NInput v-model:value="form.encryptVector" type="password" show-password-on="click"
                      :placeholder="config?.secretsSet.encryptVector ? '留空表示不修改' : ''" />
            </NFormItem>
          </NSpace>

          <NFormItem>
            <template #label>
              Topic 协议版本
              <FieldHelp>
                <p>topic 首段，当前为 <code>v1</code>，例如
                  <code>/v1/devices/&lt;设备标识&gt;/datas</code>。除非平台明确要求，保持默认。</p>
                <p class="fh-warn">它<b>不是</b> MQTT 版本 —— MQTT 版本在下面的「连接参数」里。
                  两者名字挨着，改错了会连不上，而报错看不出是哪一个。</p>
              </FieldHelp>
            </template>
            <NInput v-model:value="form.protocolVersion" class="mono ver-input" />
          </NFormItem>

          <!-- ── 连接参数。写死在代码里的时候现场没得调，这几项恰恰是要按现场调的 ── -->
          <h4 class="sec">
            连接参数
            <FieldHelp>
              <p>这几项决定<b>怎么连</b>，不决定连上之后发什么。默认值就是这些参数
                可配之前写死的那一组，不动它与升级前的行为完全一致。</p>
            </FieldHelp>
          </h4>

          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                MQTT 版本
                <FieldHelp>
                  <p>默认 <b>5.0</b>。ThingLinks 云支持 5.0，保持默认即可。</p>
                  <p>只有在云侧或中间的网关/负载均衡不认 5.0 时才往下调 ——
                    表现是连接被拒或握手后立刻断开，而不是连上了没数据。</p>
                  <p class="fh-warn">3.1 是给老旧网关兜底的，除非对方明确要求，
                    不要选它：没有会话过期、没有原因码，出了问题什么都查不到。</p>
                </FieldHelp>
              </template>
              <NSelect v-model:value="form.connection.mqttVersion" :options="MQTT_VERSION_OPTIONS" />
            </NFormItem>
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                心跳间隔
                <FieldHelp>
                  <p>每隔这么久发一次 PINGREQ，让链路上的设备知道连接还活着。默认 60 秒。</p>
                  <p><b>什么时候要调小</b>：中间过 NAT 网关或 4G 拨号的现场，
                    空闲连接常在 60 秒左右被回收 —— 表现是「看着在线，数据却发不出去」，
                    压到 30 甚至 20 秒就好了。</p>
                  <p class="fh-warn">填 0 表示不发心跳。链路被无声掐断后，
                    要等到下一次发数据失败才会发现，不确定的话别用。</p>
                </FieldHelp>
              </template>
              <NInputNumber v-model:value="form.connection.keepaliveSec" :min="0" :max="65535">
                <template #suffix>秒</template>
              </NInputNumber>
            </NFormItem>
          </NSpace>

          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                连接超时
                <FieldHelp>
                  <p>一次连接尝试等多久算失败，默认 15 秒。卫星或窄带链路可以放大到 30 以上。</p>
                </FieldHelp>
              </template>
              <NInputNumber v-model:value="form.connection.connectTimeoutSec" :min="1" :max="300">
                <template #suffix>秒</template>
              </NInputNumber>
            </NFormItem>
            <NFormItem style="flex:1;min-width:280px">
              <template #label>
                重连周期
                <FieldHelp>
                  <p>断开后每隔这么久重试一次，默认 5000 毫秒。</p>
                  <p>4G 弱网现场可以放大到 10000 以上：重连本身也要占上行带宽，
                    在本来就不通的链路上密集重试只会让恢复更慢。</p>
                </FieldHelp>
              </template>
              <NInputNumber
                v-model:value="form.connection.reconnectPeriodMs"
                :min="500" :max="300000" :step="500"
                :disabled="!form.connection.autoReconnect">
                <template #suffix>毫秒</template>
              </NInputNumber>
            </NFormItem>
          </NSpace>

          <NFormItem>
            <template #label>
              自动重连
              <FieldHelp>
                <p>默认开启。断开后按上面的周期一直重试，直到连上。</p>
                <p class="fh-warn">关掉之后断线就<b>不再自己恢复</b>，要人来点「重新连接」。
                  现场没人值守，关掉等于断一次就一直断着 —— 数据会一路堆在断网缓存里
                  直到写满。除非在排查问题，否则不要关。</p>
              </FieldHelp>
            </template>
            <NSwitch v-model:value="form.connection.autoReconnect" />
          </NFormItem>

          <NAlert v-if="!form.connection.autoReconnect" type="warning" :bordered="false"
                  style="margin-bottom:14px">
            已关闭自动重连：断开后不会自己恢复，需要人工点「重新连接」。
            无人值守的现场请开着它。
          </NAlert>

          <!-- ── 传输加密。与上面的「报文加密」是两回事，标题里就把话说清楚 ── -->
          <h4 class="sec">
            传输加密（TLS）
            <FieldHelp>
              <p>这一段管的是 <b>链路</b> 加不加密、认不认得对方，与上面的
                「报文加密」是两回事：那个管 <code>dataBody</code> 的密文，
                <b>两者可以同时开</b>，也常常同时开。</p>
              <p>是否启用由 Broker 地址的协议决定；这里配的是<b>拿什么证书去校验</b>。</p>
            </FieldHelp>
          </h4>

          <p v-if="!secure" class="hint">
            当前地址是明文协议，TLS 设置不参与连接。
            需要加密请把地址改成 <code class="mono">mqtts://</code> 或
            <code class="mono">wss://</code>（
            <a class="quick" tabindex="0" @click="useDefaultBroker(true)"
               @keydown.enter="useDefaultBroker(true)">用默认加密地址</a>）。
          </p>

          <NAlert v-if="willDropCerts" type="warning" :bordered="false" style="margin:10px 0">
            地址已改为明文协议，保存后会<b>清除已保存的证书与客户端私钥</b>。
            证书通常要向运维重新索取，改回加密地址前请先确认这是你想要的。
          </NAlert>

          <template v-if="secure">
            <NSpace :size="14">
              <NFormItem style="flex:1;min-width:280px">
                <template #label>
                  证书模式
                  <FieldHelp>
                    <p><b>系统根证书</b>：云平台用的是公网 CA 签发的证书（多数公有云如此），
                      不用传任何文件。</p>
                    <p><b>自签 CA</b>：私有化部署最常见 —— 平台证书由自家 CA 签发，
                      系统根证书里没有它，必须把 CA 传上来。</p>
                    <p><b>双向认证</b>：平台还要反过来验网关的身份，需要客户端证书与私钥。
                      没被明确要求就不必选。</p>
                  </FieldHelp>
                </template>
                <NSelect v-model:value="form.tls.mode" :options="TLS_MODE_OPTIONS" />
              </NFormItem>
              <NFormItem style="flex:1;min-width:280px">
                <template #label>
                  SNI 主机名
                  <FieldHelp>
                    <p>留空即用地址里的主机名，绝大多数情况留空。</p>
                    <p>只有一种情况要填：<b>用 IP 连、而证书签的是域名</b>。
                      不填会报「主机名不匹配」，填了才对得上。</p>
                  </FieldHelp>
                </template>
                <NInput v-model:value="form.tls.servername" class="mono" placeholder="留空即用地址里的主机名" />
              </NFormItem>
            </NSpace>

            <template v-if="needsCa">
              <NFormItem>
                <template #label>
                  CA 证书
                  <span v-if="config?.tls.ca" class="kept">已上传 · 留空表示不修改</span>
                  <FieldHelp>
                    <p>用来验证<b>平台</b>证书的那份根证书，通常叫 <code>ca.crt</code>
                      或 <code>ca.pem</code>，由平台运维提供。</p>
                    <p>可以是一整条链（根 + 中间），直接把多段 PEM 拼在一起即可。</p>
                    <p class="fh-warn">别把平台的服务器证书当 CA 传上来 —— 两个文件长得很像，
                      传错了握手只会报一句看不出所以然的错。</p>
                  </FieldHelp>
                </template>
                <div class="pem">
                  <NInput v-model:value="form.tls.ca" type="textarea" class="mono pem-in"
                          :rows="3" :placeholder="config?.tls.ca ? '留空表示不修改' : '-----BEGIN CERTIFICATE-----'" />
                  <NButton size="small" @click="pickPem('ca')">选择文件…</NButton>
                </div>
                <template v-if="config?.tls.ca" #feedback>
                  <span class="cert">
                    <b>{{ config.tls.ca.subject }}</b>
                    <span class="sep">·</span>{{ certValid(config.tls.ca) }}
                    <span v-if="config.tls.ca.expired" class="warn">（已过期）</span>
                    <span class="sep">·</span>
                    <span class="fp mono">{{ config.tls.ca.fingerprint }}</span>
                  </span>
                </template>
              </NFormItem>
            </template>

            <template v-if="needsClientCert">
              <NFormItem>
                <template #label>
                  客户端证书
                  <span v-if="config?.tls.cert" class="kept">已上传 · 留空表示不修改</span>
                  <FieldHelp>
                    <p>本网关的身份证明，平台用它来认这台设备，通常叫
                      <code>client.crt</code>。</p>
                    <p>必须与下面的私钥<b>来自同一次签发</b> —— 配错了两份文件各自都合法，
                      只有配到一起才不对，保存时会当场告诉你。</p>
                  </FieldHelp>
                </template>
                <div class="pem">
                  <NInput v-model:value="form.tls.cert" type="textarea" class="mono pem-in"
                          :rows="3" :placeholder="config?.tls.cert ? '留空表示不修改' : '-----BEGIN CERTIFICATE-----'" />
                  <NButton size="small" @click="pickPem('cert')">选择文件…</NButton>
                </div>
                <template v-if="config?.tls.cert" #feedback>
                  <span class="cert">
                    <b>{{ config.tls.cert.subject }}</b>
                    <span class="sep">·</span>{{ certValid(config.tls.cert) }}
                    <span v-if="config.tls.cert.expired" class="warn">（已过期）</span>
                    <span class="sep">·</span>
                    <span class="fp mono">{{ config.tls.cert.fingerprint }}</span>
                  </span>
                </template>
              </NFormItem>

              <NFormItem>
                <template #label>
                  客户端私钥
                  <span v-if="config?.secretsSet.tlsKey" class="kept">已设置 · 留空表示不修改</span>
                  <FieldHelp>
                    <p>与上面的客户端证书配对的私钥，通常叫 <code>client.key</code>。
                      与口令同级加密存储，界面永远读不回。</p>
                    <p class="fh-warn">必须是<b>未加密</b>的 PEM。带口令保护的私钥请先解密：
                      <code>openssl pkcs8 -topk8 -nocrypt -in enc.key -out plain.key</code></p>
                  </FieldHelp>
                </template>
                <div class="pem">
                  <NInput v-model:value="form.tls.key" type="textarea" class="mono pem-in"
                          :rows="3" :placeholder="config?.secretsSet.tlsKey ? '留空表示不修改' : '-----BEGIN PRIVATE KEY-----'" />
                  <NButton size="small" @click="pickPem('key')">选择文件…</NButton>
                </div>
              </NFormItem>
            </template>

            <NFormItem>
              <template #label>
                校验服务端证书
                <FieldHelp>
                  <p>默认开启，<b>不要关</b>。</p>
                  <p class="fh-warn">关掉之后链路仍然加密，但<b>不再验证对方是谁</b> ——
                    任何人只要能劫持流量就能冒充云平台，把这台网关的数据收走、
                    再往下发命令，而界面上一切正常。</p>
                  <p>证书报错的正确解法是把 CA 传上来（选「自签 CA」），不是关掉校验。</p>
                </FieldHelp>
              </template>
              <NSwitch v-model:value="form.tls.rejectUnauthorized" />
            </NFormItem>

            <NAlert v-if="!form.tls.rejectUnauthorized" type="warning" :bordered="false"
                    style="margin-bottom:14px">
              已关闭服务端证书校验：链路仍加密，但<b>无法确认对方是不是真的云平台</b>，
              中间人可冒充。仅限内网自测，生产现场请改用「自签 CA」并传入 CA 证书。
            </NAlert>
          </template>

          <NAlert type="info" :bordered="false">
            口令、密钥与客户端私钥加密存储，界面永远读不回明文（证书只回摘要）；
            保存后会立即应用，无需重启。
          </NAlert>
        </NForm>

        <template #footer>
          <NSpace justify="space-between" align="center">
            <span v-if="config" class="muted sm">
              上次修改 {{ dbTime(config.updatedAt) }} · {{ config.updatedBy }}
            </span>
            <span v-else class="muted sm">尚未配置</span>
            <NButton type="primary" :loading="saving" @click="save">保存并连接</NButton>
          </NSpace>
        </template>
      </NCard>
    </NSpin>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.card { border-radius: var(--r); box-shadow: var(--shadow); margin-bottom: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.head h3 { margin: 0; font-size: 14px; }
h4.sec {
  display: flex; align-items: center; gap: 8px;
  margin: 18px 0 8px; font-size: 13px; color: var(--text-2);
}
.lim { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.num.warn { color: var(--warning); }
.num.bad { color: var(--error); }
.hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0; }
.hint.sec { margin-top: 18px; }

.st { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.spacer { margin-left: auto; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--muted); }
.dot.s-success { background: var(--success); }
.dot.s-error { background: var(--error); }
.dot.s-warning { background: var(--warning); }
.st-text { font-size: 15px; font-weight: 600; }
.st-text.t-success { color: var(--success); }
.st-text.t-error { color: var(--error); }
.st-text.t-warning { color: var(--warning); }

/* 状态明细：窄屏自动降到两列或一列，不横向挤 */
.kv {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px 20px; margin-top: 14px; font-size: 12.5px;
}
.kv > div { display: flex; justify-content: space-between; gap: 10px; }
.lb { color: var(--muted); }
.muted { color: var(--muted); }

/* 一键填地址 / 当前是否加密。放在输入框的 feedback 位，不占额外一行。
   下方留白是必要的：贴着下一个字段时，这行会被读成下一个字段的说明 */
.quick { display: inline-block; padding-bottom: 8px; font-size: 11.5px; color: var(--muted); }
.quick a, a.quick { color: var(--primary); cursor: pointer; }
.quick a:hover, a.quick:hover { text-decoration: underline; }
.quick a:focus-visible, a.quick:focus-visible {
  outline: 2px solid rgba(var(--primary-glow), .5); outline-offset: 2px; border-radius: 3px;
}
.quick .sep, .cert .sep { margin: 0 6px; opacity: .45; }
.quick .ok { color: var(--success); }
.quick .warn, .cert .warn { color: var(--warning); }

/* PEM 输入：文本框占满，选文件的按钮贴在右侧顶端 */
.pem { display: flex; align-items: flex-start; gap: 10px; width: 100%; }
.pem-in { flex: 1; }
.pem-in :deep(textarea) { font-size: 11.5px; line-height: 1.5; }

/* 已存证书的摘要。指纹很长，窄屏时让它自己断行而不是把卡片撑宽 */
.cert { font-size: 11.5px; color: var(--muted); }
.cert .fp { word-break: break-all; opacity: .8; }
.sm { font-size: 12px; }
/* 「已设置」提示紧跟在标签后面，弱化处理，不跟字段名抢注意力 */
.kept { margin-left: 8px; font-size: 11.5px; font-weight: 400; color: var(--muted); }
.ver-input { max-width: 160px; }

/* 协议 + 主机 + 端口（+ ws 的 path）排成一行，窄屏时端口和 path 换行不挤主机 */
.addr { display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; }
/* NSelect 默认 width:100%，只写 flex:0 0 auto 会让它按 100% 算基准、独占一行。
   必须给死宽度 */
.addr-scheme { flex: 0 0 118px; width: 118px; }
.addr-host { flex: 1 1 220px; min-width: 160px; }
.addr-port { flex: 0 0 110px; }
.addr-path { flex: 0 0 160px; }
.addr .colon { color: var(--muted); margin: 0 -3px; }
/* 拼出来的整条地址：给得出来但不抢眼，长了就省略 */
.quick .url { max-width: 42ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  vertical-align: bottom; display: inline-block; }
/* 断网记录：一条一行，红点在最左，扫一眼就知道哪次丢过数据 */
.outages { display: flex; flex-direction: column; gap: 10px; }
.outage { display: flex; align-items: flex-start; gap: 10px; }
.o-main { flex: 1; min-width: 0; }
.o-when { font-size: 11.5px; color: var(--muted); }
.o-text { font-size: 12.5px; margin-top: 1px; }
.o-num { white-space: nowrap; padding-top: 12px; }

</style>
