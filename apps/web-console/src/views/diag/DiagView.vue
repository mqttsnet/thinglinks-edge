<script setup lang="ts">
/**
 * 远程诊断（T4.5）。
 *
 * 两件事，顺序是有意的：**先探测、再导包**。
 * 现场排障九成先问「连不连得上」，那一步秒级出结果、能边改配置边看；
 * 导整包是把现场状态寄回来给别人看的，属于第二步。
 *
 * 这里没有「受控终端」。需求里写过，但实现它要在受限 docker 代理上重新放开
 * `exec` —— 那正是整个隔离模型的支点，不能为了方便打开。替代方案就是下面
 * 这组固定的、每次进审计的诊断动作。
 */
import { ref, computed, onMounted } from 'vue';
import {
  NButton, NCard, NInput, NInputNumber, NSpin, NAlert, NTag, NSpace, useMessage,
} from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type { DiagProbeResponse, EndpointProbe } from '../../api/types';
import FieldHelp from '../../components/FieldHelp.vue';

const message = useMessage();

/** 一行一个目标。用多行文本而不是标签输入：现场常常是从配置里整段粘过来的 */
const targetsText = ref('');
const timeoutMs = ref(5000);
const probing = ref(false);
const result = ref<DiagProbeResponse | null>(null);
const probeError = ref('');
/**
 * 「没目标可探」不是错误。
 *
 * 页面一打开就自动探一次云 broker，但这台还没配云的话后端会回 400。
 * 那时候用户什么都没做错，弹红色报错会让页面看起来是坏的 ——
 * 这种情况要走中性空状态，把「该做什么」说出来。
 */
const nothingToProbe = ref(false);

const targets = computed(() =>
  targetsText.value.split('\n').map((s) => s.trim()).filter(Boolean));

/** 后端上限 8 个，这里提前提示，不等提交才报错 */
const tooMany = computed(() => targets.value.length > 8);

const localTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';

function humanUptime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${(sec / 86400).toFixed(1)} 天`;
}

/** 一条探测的总体结论：解析失败 / 连不通 / 通 */
function verdict(p: EndpointProbe): { text: string; type: 'success' | 'error' | 'warning' } {
  if (p.tcp?.ok) return { text: '可达', type: 'success' };
  if (p.dns && !p.dns.ok) return { text: '域名解析失败', type: 'error' };
  return { text: '连不通', type: 'error' };
}

async function runProbe() {
  probing.value = true;
  probeError.value = '';
  nothingToProbe.value = false;
  try {
    result.value = await api.diagProbe(targets.value, timeoutMs.value);
  } catch (e) {
    result.value = null;
    // 后端在「没给目标且没配云」时回 400。这是空状态，不是故障
    if (e instanceof ApiError && e.status === 400 && targets.value.length === 0) {
      nothingToProbe.value = true;
    } else {
      probeError.value = e instanceof ApiError ? e.message : '探测失败';
    }
  } finally {
    probing.value = false;
  }
}

// ── 诊断包 ──────────────────────────────────────────────

const exporting = ref(false);
const logTail = ref(500);

async function exportBundle() {
  exporting.value = true;
  try {
    const { blob, filename } = await api.diagBundle(targets.value, logTail.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    message.success(`诊断包已生成：${filename}`);
  } catch (e) {
    // 自检拒绝时后端会给出 hint，那句才是能照做的部分，别截断
    message.error(e instanceof ApiError ? e.message : '导出失败', { duration: 8000 });
  } finally {
    exporting.value = false;
  }
}

// 打开就先探一次云 broker —— 不填任何东西也该有结果，那是最常问的一件事
onMounted(runProbe);
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>远程诊断</h2>
        <p class="sub">先确认连不连得上，再把现场状态打包寄回来</p>
      </div>
    </div>

    <!-- 一、连通性 -->
    <NCard class="card" :bordered="false">
      <div class="head">
        <h3>
          连通性探测
          <FieldHelp>
            <p>做三件现场真正会问的事：<b>域名解析得出来吗 / 端口通不通 / 时间对不对</b>。</p>
            <p>全部用标准库在进程内完成，<b>不执行任何外部命令</b> —— 所以它不是「终端」，
              能做的动作是固定的那几个。</p>
            <p>每次探测都会进审计：它能对任意地址发起连接，属于要留痕的能力。</p>
          </FieldHelp>
        </h3>
        <NButton type="primary" size="small" :loading="probing"
                 :disabled="tooMany" @click="runProbe">开始探测</NButton>
      </div>

      <div class="form">
        <div class="fl">
          <span class="lb">
            探测目标
            <FieldHelp>
              <p><b>留空就探当前配置的云 broker</b> —— 现场十次里九次问的就是这个。</p>
              <p>一行一个。支持 <code>host:port</code>，也支持带协议的 URL，
                协议能推出默认端口：<code>mqtts://broker.example.com</code> 走 8883、
                <code>https://x.com</code> 走 443。</p>
              <p>IPv6 要带方括号：<code>[2001:db8::1]:1883</code>，
                否则分不清冒号是分隔符还是地址的一部分。</p>
              <p class="fh-warn">最多 8 个目标，超出的会被后端截掉 ——
                不会报错，只是后面几个静默不探。</p>
            </FieldHelp>
          </span>
          <NInput
            v-model:value="targetsText" type="textarea" class="mono"
            :autosize="{ minRows: 3, maxRows: 8 }"
            placeholder="留空 = 探当前云 broker&#10;mqtts://broker.example.com&#10;10.0.1.20:502" />
          <span class="hint">
            {{ targets.length === 0 ? '将探测当前配置的云 broker' : `共 ${targets.length} 个目标` }}
          </span>
        </div>

        <div class="fs">
          <span class="lb">
            超时（毫秒）
            <FieldHelp>
              <p>单个目标等多久算失败。现场网络慢，但排障时也不能让人干等。</p>
              <p>上限 15000 毫秒，超出会被后端裁掉。</p>
            </FieldHelp>
          </span>
          <NInputNumber v-model:value="timeoutMs" :min="500" :max="15000" :step="500"
                        style="width: 100%" />
        </div>
      </div>

      <NAlert v-if="tooMany" type="warning" :bordered="false" style="margin-top:12px">
        目标超过 8 个，后端只会探前 8 个，其余静默忽略。请分批探测。
      </NAlert>
      <NAlert v-if="probeError" type="error" :bordered="false" style="margin-top:12px">
        {{ probeError }}
      </NAlert>
      <NAlert v-else-if="nothingToProbe" type="info" :bordered="false" style="margin-top:12px">
        这台还没配置云对接，也没填探测目标，所以没有可探的地址。
        在上面填一个 <code class="mono">host:port</code> 就能开始，
        或者先到「云平台」页完成对接。
      </NAlert>

      <NSpin :show="probing">
        <div v-if="result?.probes.length" class="results">
          <div v-for="p in result.probes" :key="p.target" class="probe">
            <div class="ph">
              <span class="tgt mono">{{ p.target }}</span>
              <NTag size="small" :bordered="false" :type="verdict(p).type">{{ verdict(p).text }}</NTag>
            </div>
            <div class="kv">
              <div>
                <span class="lb2">域名解析</span>
                <span v-if="!p.dns" class="muted">—</span>
                <span v-else-if="p.dns.ok" class="mono">
                  {{ p.dns.addresses.join('、') || '（无地址）' }}
                  <span class="muted">· {{ p.dns.elapsedMs }}ms</span>
                </span>
                <span v-else class="bad">{{ p.dns.error || '解析失败' }}</span>
              </div>
              <div>
                <span class="lb2">
                  端口连通
                  <FieldHelp>
                    <p>只做 <b>TCP 握手</b>，不发任何业务报文。</p>
                    <p class="fh-warn">握手成功<b>不代表服务可用</b>：透明代理、
                      运营商劫持都会让这一步误报成功。云平台是否真能用，
                      以「云平台」页的链路状态为准。</p>
                  </FieldHelp>
                </span>
                <span v-if="!p.tcp" class="muted">未连（解析没成功）</span>
                <span v-else-if="p.tcp.ok" class="mono">
                  {{ p.tcp.host }}:{{ p.tcp.port }}
                  <span class="muted">· {{ p.tcp.elapsedMs }}ms</span>
                  <span v-if="p.tcp.remoteAddress" class="muted">· 实连 {{ p.tcp.remoteAddress }}</span>
                </span>
                <span v-else class="bad">{{ p.tcp.error || '连接失败' }}</span>
              </div>
            </div>
            <p class="summary">{{ p.summary }}</p>
          </div>

          <NAlert type="info" :bordered="false" style="margin-top:4px">{{ result.note }}</NAlert>
        </div>
        <p v-else-if="!probing && !probeError && !nothingToProbe" class="hint pad">还没有探测结果。</p>
      </NSpin>
    </NCard>

    <!-- 二、本机时钟 -->
    <NCard v-if="result" class="card" :bordered="false">
      <h3>
        本机时钟
        <FieldHelp>
          <p>时间不对会让上报数据的时间戳全错，而且<b>不会报错</b> ——
            云端看到的是「数据来了但时间乱跳」，很难联想到是边缘的钟有问题。</p>
          <p>配了 <code>NTP_SERVER</code> 才会去对时钟源；没配就只报本机时间，
            <b>不假装检查过</b>。</p>
        </FieldHelp>
      </h3>
      <div class="kv wide">
        <div><span class="lb2">本机时间</span><span class="mono">{{ localTime(result.clock.localTime) }}</span></div>
        <div><span class="lb2">时区</span><span class="mono">{{ result.clock.timezone }}</span></div>
        <div>
          <span class="lb2">
            已运行
            <FieldHelp>
              <p>管理台进程启动到现在的时长。</p>
              <p>数字很小说明<b>刚重启过</b> —— 排障时这条能省掉「是不是刚才重启导致的」这一轮猜测。</p>
            </FieldHelp>
          </span>
          <span class="num">{{ humanUptime(result.clock.uptimeSec) }}</span>
        </div>
        <div v-if="result.clock.offsetMs !== undefined">
          <span class="lb2">
            与时钟源偏差
            <FieldHelp>
              <p>正数表示<b>本机比参考时间慢</b>。</p>
              <p>偏差超过几秒就要处理：云端按时间戳排序与去重，钟不准会让数据顺序错乱。</p>
            </FieldHelp>
          </span>
          <span class="num" :class="{ bad: Math.abs(result.clock.offsetMs) > 5000 }">
            {{ result.clock.offsetMs }} ms
            <span v-if="result.clock.roundtripMs" class="muted">· 往返 {{ result.clock.roundtripMs }}ms</span>
          </span>
        </div>
        <div v-if="result.clock.server">
          <span class="lb2">时钟源</span><span class="mono">{{ result.clock.server }}</span>
        </div>
      </div>
      <p class="hint" style="margin-top:10px">{{ result.clock.note }}</p>
    </NCard>

    <!-- 三、诊断包 -->
    <NCard class="card" :bordered="false">
      <div class="head">
        <h3>
          诊断包
          <FieldHelp>
            <p>把现场状态打成一个 tar：实例清单与健康、宿主资源、云链路与缓存、
              审计记录、以及各实例的最近日志。</p>
            <p><b>导出前会自检脱敏</b>：口令、密钥、令牌一律抹掉。
              自检不通过时<b>整包拒绝导出</b>，不会降级成「删减版」——
              那样你拿到的仍可能含凭据，只是自己不知道。</p>
            <p class="fh-warn">包里仍有现场拓扑与日志正文，按敏感文件传递，
              不要丢进公共网盘或工单附件区。</p>
          </FieldHelp>
        </h3>
        <NButton type="primary" size="small" :loading="exporting" @click="exportBundle">
          导出诊断包
        </NButton>
      </div>

      <div class="fs">
        <span class="lb">
          每个实例带多少行日志
          <FieldHelp>
            <p>行数越多越容易定位问题，包也越大。上限 5000 行，超出会被后端裁掉。</p>
            <p>现场网络差、要把包传出去时，先用小一点的值。</p>
          </FieldHelp>
        </span>
        <NInputNumber v-model:value="logTail" :min="0" :max="5000" :step="100" style="width: 200px" />
      </div>

      <p class="hint" style="margin-top:10px">
        上面「探测目标」里填的地址会一并写进包里探测一次，方便对方看到当时的连通情况。
      </p>
    </NCard>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h2 { margin: 0 0 4px; font-size: 20px; }
h3 { margin: 0; font-size: 14px; }
.sub { margin: 0; font-size: 12.5px; color: var(--muted); }
.card { border-radius: var(--r); box-shadow: var(--shadow); margin-bottom: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }

.form { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.fl { flex: 1; min-width: 280px; display: flex; flex-direction: column; gap: 5px; }
.fs { display: flex; flex-direction: column; gap: 5px; min-width: 160px; }
.lb { font-size: 12px; color: var(--text-2); }
.lb2 { font-size: 11.5px; color: var(--muted); }

.results { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.probe { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--rs); }
.ph { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.tgt { font-size: 13px; color: var(--text); font-weight: 600; }

.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 20px; }
.kv.wide { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.kv > div { display: flex; flex-direction: column; gap: 3px; }
.summary { margin: 10px 0 0; font-size: 12.5px; color: var(--text-2); line-height: 1.7; }

.bad { color: var(--error); }
.muted { color: var(--muted); }
.hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0; }
.hint.pad { padding: 24px 0; text-align: center; }
/* 限定在正文内：scoped 样式会跟着插槽内容跑进 FieldHelp 的传送门（12 号文 5.1） */
.hint code, .summary code, .n-alert code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }
</style>
