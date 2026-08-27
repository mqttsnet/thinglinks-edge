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
import { api, ApiError } from '../api/client';
import type { CloudConfigView, CloudStatus, SpoolMetrics, CipherFlag, EdgeMetrics } from '../api/types';
import { can } from '../api/permissions';
import FieldHelp from '../components/FieldHelp.vue';

const message = useMessage();
const dialog = useDialog();

const loading = ref(true);
const saving = ref(false);
const config = ref<CloudConfigView | null>(null);
const status = ref<CloudStatus | null>(null);
const spool = ref<SpoolMetrics | null>(null);
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
  brokerUrl: '',
  clientId: '',
  deviceIdentification: '',
  username: '',
  password: '',
  cipherFlag: 0 as CipherFlag,
  signKey: '',
  encryptKey: '',
  encryptVector: '',
  protocolVersion: 'v1',
  qos: 1 as 0 | 1 | 2,
});

const CIPHER_OPTIONS = [
  { label: '0 · 明文（仅签名，不加密）', value: 0 },
  { label: '1 · SM4（国密，密钥 16 字节）', value: 1 },
  { label: '2 · AES（密钥 16/24/32 字节）', value: 2 },
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
    // 单独一路，失败不影响上面的连接状态显示
    metrics.value = await api.edgeMetrics().catch(() => null);
    // 只在非静默刷新时回填表单，否则用户正在输入的内容会被轮询冲掉
    if (!quiet && r.config) {
      form.value = {
        enabled: r.config.enabled,
        brokerUrl: r.config.brokerUrl,
        clientId: r.config.clientId,
        deviceIdentification: r.config.deviceIdentification,
        username: r.config.username,
        password: '',
        cipherFlag: r.config.cipherFlag,
        signKey: '',
        encryptKey: '',
        encryptVector: '',
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
      brokerUrl: form.value.brokerUrl.trim(),
      clientId: form.value.clientId.trim(),
      deviceIdentification: form.value.deviceIdentification.trim(),
      username: form.value.username.trim(),
      password: secretField(form.value.password, set?.password),
      cipherFlag: form.value.cipherFlag,
      signKey: secretField(form.value.signKey, set?.signKey),
      encryptKey: needsCipherKeys.value ? secretField(form.value.encryptKey, set?.encryptKey) : undefined,
      encryptVector: needsCipherKeys.value ? secretField(form.value.encryptVector, set?.encryptVector) : undefined,
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
    content: '将断开连接并**删除**已保存的接入凭据（口令、signKey、加密密钥）。'
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
          断网缓存里还有 <b>{{ spool.pending }}</b> 条待补传，
          占用 {{ mb(spool.bytes) }} MB / {{ mb(spool.maxBytes) }} MB。
          链路恢复后会在实时数据之外的余量里自动补发。
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
                <p>形如 <code>mqtts://iot.thinglinks.cn:8883</code>，
                  协议由地址本身决定：<code>mqtts</code>/<code>wss</code> 加密，
                  <code>mqtt</code>/<code>ws</code> 不加密。</p>
                <p class="fh-warn">不要把账号口令写进地址（<code>mqtt://user:pass@host</code>），
                  填到下面的字段里 —— 写进地址会让凭据同时躺在两处。</p>
              </FieldHelp>
            </template>
            <NInput v-model:value="form.brokerUrl" class="mono" placeholder="mqtts://iot.thinglinks.cn:8883" />
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
              协议版本
              <FieldHelp>
                <p>topic 首段，当前为 <code>v1</code>。除非平台明确要求，保持默认。</p>
              </FieldHelp>
            </template>
            <NInput v-model:value="form.protocolVersion" class="mono ver-input" />
          </NFormItem>

          <NAlert type="info" :bordered="false">
            口令与密钥加密存储，界面永远读不回明文；保存后会立即应用，无需重启。
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
.sm { font-size: 12px; }
/* 「已设置」提示紧跟在标签后面，弱化处理，不跟字段名抢注意力 */
.kept { margin-left: 8px; font-size: 11.5px; font-weight: 400; color: var(--muted); }
.ver-input { max-width: 160px; }
</style>
