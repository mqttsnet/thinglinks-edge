<script setup lang="ts">
/**
 * 备份（T4.3）。
 *
 * 界面只做**备份**，不做在线恢复 —— 恢复要覆盖正被 Manager 打开的库，
 * 在线做等于自找损坏。所以这里把恢复步骤写清楚，让运维照着敲。
 *
 * 现场最容易栽的是 `MASTER_KEY`：异机恢复时密钥不对，系统能启动、能登录，
 * 但**所有实例凭据都解不开**，表现是「实例起不来」而不是「密钥错了」。
 * 页面把指纹显出来，就是为了让人在恢复前能核对。
 */
import { ref, onMounted } from 'vue';
import { NButton, NCard, NSpin, NAlert, NSpace, NTag, useMessage } from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type { BackupInspect } from '../../api/types';
import FieldHelp from '../../components/FieldHelp.vue';

const message = useMessage();
const loading = ref(true);
const working = ref(false);
const info = ref<BackupInspect | null>(null);
const loadError = ref('');

const localTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refresh() {
  loading.value = true;
  loadError.value = '';
  try {
    info.value = await api.inspectBackup();
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '读取备份内容失败';
  } finally {
    loading.value = false;
  }
}

async function download() {
  working.value = true;
  try {
    const { blob, filename } = await api.downloadBackup();
    // 交给浏览器保存。用完立刻回收 object URL，否则整页存活期间都占着内存
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    message.success(`备份已生成：${filename}`);
    await refresh();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '备份失败');
  } finally {
    working.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>备份</h2>
        <p class="sub">把管理台数据库与全部实例数据打包带走；恢复走命令行</p>
      </div>
      <NButton type="primary" :loading="working" @click="download">立即备份并下载</NButton>
    </div>

    <NSpin :show="loading">
      <NAlert v-if="loadError" type="error" :bordered="false" class="card">{{ loadError }}</NAlert>

      <NCard v-else class="card" :bordered="false">
        <div class="head">
          <h3>
            这次备份会包含什么
            <FieldHelp>
              <p>下面是<b>现在</b>执行备份会打进包里的内容，每次打开本页实时算一遍。</p>
              <p>备份的是数据目录：管理台的 <code>edge.db</code> 与每个实例的
                <code>&lt;数据根&gt;/instances/&lt;实例id&gt;/</code>。</p>
              <p class="fh-warn">包里含<b>实例凭据</b>（已加密，但仍是敏感物），
                请按敏感文件保管，不要放进代码仓或公共网盘。</p>
            </FieldHelp>
          </h3>
          <NButton size="small" quaternary :loading="loading" @click="refresh">刷新</NButton>
        </div>

        <div class="kv">
          <div><span class="lb">文件数</span><span class="num">{{ info?.files ?? 0 }}</span></div>
          <div><span class="lb">解包后大小</span><span class="num">{{ humanSize(info?.bytes ?? 0) }}</span></div>
          <div><span class="lb">数据库版本</span><span class="num">v{{ info?.manifest.schemaVersion ?? '—' }}</span></div>
          <div>
            <span class="lb">
              密钥指纹
              <FieldHelp>
                <p><code>MASTER_KEY</code> 派生出来的指纹，<b>不含密钥本身</b>。</p>
                <p>恢复到另一台机器时，那台的 <code>MASTER_KEY</code> 必须能算出同一个指纹。</p>
                <p class="fh-warn">密钥不对时，系统照样能启动、能登录，
                  但<b>所有实例凭据都解不开</b> —— 现场看到的是「实例起不来」，
                  很难联想到是密钥问题。恢复前先核对这一串。</p>
              </FieldHelp>
            </span>
            <span class="mono">{{ info?.manifest.masterKeyFingerprint ?? '—' }}</span>
          </div>
          <div><span class="lb">生成时间</span><span>{{ localTime(info?.manifest.createdAt) }}</span></div>
        </div>

        <h4 class="sec">包含的实例（{{ info?.manifest.instances.length ?? 0 }}）</h4>
        <p v-if="!info?.manifest.instances.length" class="hint">
          还没有实例。现在备份只会带上管理台自身的数据（账号、权限、审计）。
        </p>
        <NSpace v-else :size="8" style="flex-wrap: wrap">
          <NTag v-for="i in info.manifest.instances" :key="i.id" :bordered="false" size="small">
            {{ i.name }}
            <span class="mono muted">&nbsp;{{ i.id }} · {{ i.imageTag }}</span>
          </NTag>
        </NSpace>
      </NCard>

      <NCard class="card" :bordered="false">
        <h3>
          怎么恢复
          <FieldHelp>
            <p>恢复<b>没有做成界面按钮</b>，这是有意的：恢复要覆盖正被管理台打开的数据库，
              在线做会把库写坏。</p>
            <p>正确顺序是 <b>停服务 → 恢复 → 再启动</b>。</p>
          </FieldHelp>
        </h3>

        <ol class="steps">
          <li>
            把备份文件拷到目标机器，确认那台的 <code class="mono">MASTER_KEY</code>
            与备份时一致（对上面的密钥指纹）。
          </li>
          <li>停掉管理台：<code class="mono">docker compose stop manager</code></li>
          <li>
            执行恢复：
            <pre class="cmd">docker compose run --rm --entrypoint node manager \
  dist/index.js restore /path/to/备份文件.tar</pre>
            <span class="hint">加 <code class="mono">--force</code> 可覆盖已有数据；不加时目标非空会拒绝执行。</span>
          </li>
          <li>启动：<code class="mono">docker compose up -d</code></li>
        </ol>

        <NAlert type="warning" :bordered="false" style="margin-top: 6px">
          恢复会<b>覆盖</b>目标机器上的现有数据。异机恢复前请先确认密钥指纹一致，
          否则实例凭据无法解密，实例将起不来。
        </NAlert>
      </NCard>
    </NSpin>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h2 { margin: 0 0 4px; font-size: 20px; }
h3 { margin: 0; font-size: 14px; }
h4.sec { margin: 18px 0 8px; font-size: 13px; color: var(--text-2); }
.sub { margin: 0; font-size: 12.5px; color: var(--muted); }
.card { border-radius: var(--r); box-shadow: var(--shadow); margin-bottom: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }

.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px 20px; }
.kv > div { display: flex; flex-direction: column; gap: 3px; }
.lb { font-size: 11.5px; color: var(--muted); }

.steps { margin: 10px 0 0; padding-left: 20px; font-size: 13px; line-height: 2; color: var(--text-2); }
.steps li { margin-bottom: 6px; }
.cmd {
  margin: 6px 0 4px;
  padding: 10px 12px;
  background: var(--grey100);
  border-radius: var(--rs);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}
.hint { font-size: 12px; color: var(--muted); line-height: 1.6; }
.muted { color: var(--muted); }
/* 限定在正文内：scoped 样式会跟着插槽内容跑进 FieldHelp 的传送门，
   裸 code 选择器会把提示框里的示例值刷成白底白字（12 号文 5.1） */
.steps code, .hint code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
