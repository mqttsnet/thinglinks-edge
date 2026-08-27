<script setup lang="ts">
import { ref, onMounted, onUnmounted, h } from 'vue';
import {
  NButton, NCard, NTag, NModal, NForm, NFormItem, NInput,
  NInputNumber, NSelect, NSpace, NSpin, NEmpty, NAlert, NCheckbox,
  useMessage, useDialog,
} from 'naive-ui';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api/client';
import type { Instance, PortRecord } from '../api/types';
import FieldHelp from '../components/FieldHelp.vue';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const instances = ref<Instance[]>([]);
const loading = ref(true);
let timer: number | undefined;

async function refresh(quiet = false) {
  if (!quiet) loading.value = true;
  try {
    instances.value = (await api.instances()).instances;
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

// ── 新建 ────────────────────────────────────────────────

const showCreate = ref(false);
const creating = ref(false);
const IMAGE_TAGS = [
  { label: '5.0.4-24-minimal（推荐）', value: '5.0.4-24-minimal' },
  { label: '4.1.13-22-minimal', value: '4.1.13-22-minimal' },
];
/**
 * 监听网卡。
 *
 * 这里不去枚举宿主网卡：Manager 跑在容器里，os.networkInterfaces() 看到的是
 * 容器自己那几张，不是宿主的 —— 列出来只会误导。所以给两个明确选项加自填。
 */
const HOST_IP_OPTIONS = [
  { label: '仅本机 127.0.0.1', value: '127.0.0.1' },
  { label: '所有网卡 0.0.0.0', value: '0.0.0.0' },
];

const PROTOCOLS = [
  { label: 'TCP', value: 'tcp' },
  { label: 'UDP', value: 'udp' },
];

const emptyForm = () => ({
  id: '', name: '', imageTag: '5.0.4-24-minimal',
  memoryMb: 512, cpus: 0.5, ports: [] as PortRecord[],
});
const form = ref(emptyForm());
const recommended = ref<number[]>([]);

/** 新增一行时给个不与现有行冲突的宿主端口建议 */
function nextFreePort(): number {
  const used = new Set(form.value.ports.map((p) => p.hostPort));
  for (const p of recommended.value) if (!used.has(p)) return p;
  const base = form.value.ports.length ? Math.max(...used) + 1 : 30000;
  return base;
}

function addPort() {
  form.value.ports.push({
    hostPort: nextFreePort(), containerPort: 1883, protocol: 'tcp',
    hostIp: '127.0.0.1', purpose: '',
  });
}
const removePort = (i: number) => form.value.ports.splice(i, 1);

async function openCreate() {
  form.value = emptyForm();
  showCreate.value = true;
  try {
    const spec = (await api.recommendPorts(8)).recommended;
    // 推荐接口回的是 "30000-30007" 这种区间串，这里摊平成候选池
    const m = /^(\d+)-(\d+)$/.exec(spec);
    recommended.value = m
      ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i)
      : spec ? [Number(spec)] : [];
  } catch { recommended.value = []; }
}

async function submitCreate() {
  creating.value = true;
  try {
    await api.createInstance({
      id: form.value.id.trim(),
      name: form.value.name.trim(),
      imageTag: form.value.imageTag,
      memoryMb: form.value.memoryMb,
      cpus: form.value.cpus,
      ports: form.value.ports.map((p) => ({ ...p, purpose: p.purpose.trim() })),
    });
    showCreate.value = false;
    message.success('实例已创建，正在拉起容器');
    await refresh();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '创建失败');
  } finally {
    creating.value = false;
  }
}

// ── 操作 ────────────────────────────────────────────────

async function act(fn: () => Promise<void>, ok: string) {
  try { await fn(); message.success(ok); await refresh(); }
  catch (e) { message.error(e instanceof ApiError ? e.message : '操作失败'); }
}

function confirmRemove(inst: Instance) {
  const removeData = ref(false);
  dialog.warning({
    title: `删除实例 · ${inst.name}`,
    content: () => h('div', [
      h('p', `将停止并移除容器，释放 ${inst.ports.length} 个端口。此操作不可撤销。`),
      h(NCheckbox, {
        checked: removeData.value,
        'onUpdate:checked': (v: boolean) => { removeData.value = v; },
      }, { default: () => '同时删除数据卷（流程与凭据将永久丢失）' }),
    ]),
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => act(() => api.removeInstance(inst.id, removeData.value), '实例已删除'),
  });
}

function resetPassword(inst: Instance) {
  dialog.info({
    title: `重置口令 · ${inst.id}`,
    content: '重置后实例将重启以使新口令生效，正在运行的流程会中断数秒。',
    positiveText: '重置', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const { password } = await api.resetCredential(inst.id, 'admin');
        dialog.success({
          title: '新口令（仅此一次可见）',
          content: () => h('code', { class: 'mono', style: 'word-break:break-all' }, password),
          positiveText: '我已记录',
        });
        await refresh();
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '重置失败');
      }
    },
  });
}

const stateTag = (i: Instance) =>
  i.running ? { type: 'success' as const, text: '运行中' }
  : i.state === 'exited' ? { type: 'error' as const, text: '已停止' }
  : i.state === 'missing' ? { type: 'warning' as const, text: '容器缺失' }
  : { type: 'default' as const, text: i.state };
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>实例</h2>
        <p class="sub">「打开编辑器」直接进入，无需再输实例口令</p>
      </div>
      <div class="spacer" />
      <NButton type="primary" @click="openCreate">+ 新建实例</NButton>
    </div>

    <NSpin :show="loading">
      <NEmpty v-if="!loading && instances.length === 0" description="还没有实例" style="padding: 60px 0">
        <template #extra><NButton size="small" @click="openCreate">创建第一个实例</NButton></template>
      </NEmpty>

      <div v-else class="grid">
        <NCard v-for="i in instances" :key="i.id" class="item" :bordered="false">
          <div class="head">
            <div class="min">
              <div class="nm">{{ i.name }}</div>
              <div class="id mono">{{ i.id }}</div>
            </div>
            <NTag :type="stateTag(i).type" size="small" round>{{ stateTag(i).text }}</NTag>
          </div>

          <div class="rows">
            <div class="r"><span class="lb">版本</span><NTag size="small" :bordered="false">{{ i.imageTag }}</NTag></div>
            <div class="r"><span class="lb">配额</span>
              <span class="num">{{ i.memLimit }} MB · {{ i.cpuLimit }} 核</span></div>
            <div class="r"><span class="lb">端口</span>
              <span v-if="i.ports.length" class="ports">
                <NTag v-for="p in i.ports" :key="p.hostPort" size="tiny" :bordered="false" class="mono">
                  {{ p.hostPort }}→{{ p.containerPort }}
                </NTag>
              </span>
              <span v-else class="muted">无</span>
            </div>
            <div class="r"><span class="lb">访问路径</span><span class="mono sm">{{ i.adminRoot }}</span></div>
          </div>

          <div class="foot">
            <NButton v-if="!i.running" size="small" @click="act(() => api.startInstance(i.id), '已启动')">启动</NButton>
            <NButton v-else size="small" @click="act(() => api.stopInstance(i.id), '已停止')">停止</NButton>
            <NButton size="small" type="primary" :disabled="!i.running"
                     tag="a" :href="i.openUrl" target="_blank">打开编辑器</NButton>
            <NButton size="small" @click="router.push(`/instances/${i.id}/logs`)">日志</NButton>
            <NButton size="small" @click="resetPassword(i)">重置口令</NButton>
            <NButton size="small" quaternary type="error" @click="confirmRemove(i)">删除</NButton>
          </div>
        </NCard>
      </div>
    </NSpin>

    <NModal v-model:show="showCreate" preset="card" title="新建实例" style="max-width: 780px">
      <NForm label-placement="top">
        <NSpace :size="14">
          <NFormItem style="flex:1">
            <template #label>
              实例 ID
              <FieldHelp>
                <p>容器名、内部网络名和访问网址都用它，<b>创建后不能改</b>，要换只能删了重建。</p>
                <p>只允许小写字母、数字和连字符，字母开头、字母或数字结尾，长度 3–32。
                  例：<code>line-a</code>、<code>oven-2</code>。</p>
                <p>想用中文或以后要改的，写到右边的「名称」里。</p>
              </FieldHelp>
            </template>
            <NInput v-model:value="form.id" placeholder="line-a" class="mono" />
          </NFormItem>
          <NFormItem style="flex:1">
            <template #label>
              名称
              <FieldHelp>
                <p>只用于界面显示，<b>随时可改</b>，不影响容器和网址。</p>
                <p>建议写现场认得出的位置或用途，例如「一号产线」「注塑车间温控」，
                  以后卡片多了才分得清。</p>
              </FieldHelp>
            </template>
            <NInput v-model:value="form.name" placeholder="一号产线" />
          </NFormItem>
        </NSpace>
        <NFormItem>
          <template #label>
            Node-RED 版本
            <FieldHelp>
              <p>实例容器使用的镜像版本。流程和已装节点存在数据目录里，不随版本走，
                但<b>换版本需要重建实例</b>。</p>
              <p>下拉里只列出本机已允许的版本 —— 现场无外网时，没预先拉取过的版本装不上，
                所以不要临时改成没见过的版本号。</p>
              <p>拿不准就用标注「推荐」的那个。</p>
            </FieldHelp>
          </template>
          <NSelect v-model:value="form.imageTag" :options="IMAGE_TAGS" />
        </NFormItem>
        <NSpace :size="14">
          <NFormItem style="flex:1">
            <template #label>
              内存上限（MB）
              <FieldHelp>
                <p>容器能用的内存<b>硬上限</b>。超过这个数，进程会被系统直接杀掉并自动重启，
                  表现是实例反复重启、流程时断时续。</p>
                <p>常规采集与转发 512 够用；做图像处理、大批量缓存或装了很多节点时往上调。</p>
                <p>不确定就保持默认，之后看健康页的内存曲线再调。</p>
              </FieldHelp>
            </template>
            <NInputNumber v-model:value="form.memoryMb" :min="64" :step="128" style="width:100%" />
          </NFormItem>
          <NFormItem style="flex:1">
            <template #label>
              CPU 配额（核）
              <FieldHelp>
                <p>容器最多能用多少个 CPU 核，可填小数：<code>0.5</code> 就是半个核。</p>
                <p class="fh-warn">填小了<b>不会报错</b>，只是流程变慢、定时任务延迟 ——
                  这种问题现场很难查，宁可给宽一点。</p>
                <p>整机核数有限，所有实例加起来别超过物理核数太多。</p>
              </FieldHelp>
            </template>
            <NInputNumber v-model:value="form.cpus" :min="0.1" :step="0.1" style="width:100%" />
          </NFormItem>
        </NSpace>
        <NFormItem>
          <template #label>
            端口映射
            <FieldHelp>
              <p>只有当<b>现场设备要主动连进来</b>时才需要加 —— 比如流程里放了
                MQTT broker 节点、Modbus TCP 从站、TCP/UDP 监听节点。</p>
              <p>Node-RED 编辑器和 HTTP/WebSocket 类节点<b>不用加</b>，
                它们走管理台统一入口，不占宿主端口。</p>
              <p>一行一条，各自独立：协议端口从来不连号（MQTT 1883、Modbus 502、
                OPC UA 4840），所以逐条填写。</p>
            </FieldHelp>
          </template>
          <NSpace vertical style="width:100%">
            <div v-if="form.ports.length" class="port-head">
              <span>
                宿主端口
                <FieldHelp>
                  <p>现场设备来连的是<b>这个</b>端口，即边缘盒子对外开放的端口。</p>
                  <p>可用范围由部署时的 <code>INSTANCE_PORT_MIN/MAX</code> 决定，
                    与其它实例、以及机器上已有服务都不能撞。</p>
                </FieldHelp>
              </span>
              <span></span>
              <span>
                容器端口
                <FieldHelp>
                  <p>Node-RED <b>容器里</b>那个节点实际监听的端口。</p>
                  <p>照节点配置填：MQTT broker 通常 <code>1883</code>、
                    Modbus TCP 从站 <code>502</code>、OPC UA <code>4840</code>。</p>
                  <p class="fh-warn">容器里没有节点监听这个端口的话<b>不会报错</b>，
                    只是设备连上后没反应 —— 现场很难查，填之前先确认流程里的节点配置。</p>
                </FieldHelp>
              </span>
              <span>协议</span>
              <span>
                监听网卡
                <FieldHelp>
                  <p><b>决定现场设备能不能连上的就是这一项。</b></p>
                  <p><code>仅本机 127.0.0.1</code>：只有边缘盒子自己能连，
                    外部设备一律连不上。默认选它是出于安全，不是因为它更常用。</p>
                  <p><code>所有网卡 0.0.0.0</code>：这台机器接入的每个网络都能连，
                    包括办公网。</p>
                  <p>盒子同时接了设备网和办公网时，<b>直接填设备网那块网卡的 IP</b>
                    （可手工输入），只对设备网开放，最稳妥。</p>
                </FieldHelp>
              </span>
              <span>用途</span><span></span>
            </div>
            <div v-for="(p, i) in form.ports" :key="i" class="port-row">
              <NInputNumber v-model:value="p.hostPort" :min="1" :max="65535"
                            size="small" :show-button="false" placeholder="30000" />
              <span class="arrow">→</span>
              <NInputNumber v-model:value="p.containerPort" :min="1" :max="65535"
                            size="small" :show-button="false" placeholder="1883" />
              <NSelect v-model:value="p.protocol" :options="PROTOCOLS" size="small" />
              <!-- consistent-menu-width=false：列宽只有 142px，下拉菜单跟着截断
                   会让「所有网卡 0.0.0.0」显示成「所有网卡 0.0...」，选之前看不清 -->
              <NSelect v-model:value="p.hostIp" :options="HOST_IP_OPTIONS"
                       size="small" filterable tag placeholder="127.0.0.1"
                       :consistent-menu-width="false" />
              <NInput v-model:value="p.purpose" size="small" placeholder="MQTT broker" />
              <NButton quaternary size="small" @click="removePort(i)">移除</NButton>
            </div>

            <NSpace align="center" :size="10">
              <NButton dashed size="small" @click="addPort">+ 添加端口映射</NButton>
              <span v-if="!form.ports.length" class="hint">
                不需要设备直连就留空。编辑器与 HTTP 类节点不占宿主端口。
              </span>
            </NSpace>

            <NAlert v-if="form.ports.some((p) => p.hostIp === '0.0.0.0')"
                    type="warning" :bordered="false" size="small">
              有端口绑到<b>所有网卡</b>：这台机器接入的每个网络都能访问，办公网也在内。
              只想让设备网连的话，把「监听网卡」改成设备网那块网卡的 IP。
            </NAlert>
          </NSpace>
        </NFormItem>
        <NAlert type="info" :bordered="false" style="margin-top:4px">
          实例账号由管理台自动创建，口令加密存储；创建后可在卡片上重置。
        </NAlert>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="submitCreate">创建</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 18px; }
.bar { display: flex; align-items: flex-start; gap: 16px; }
.bar h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.02em; color: var(--primary); }
.bar .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.spacer { margin-left: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.item { border-radius: var(--r); box-shadow: var(--shadow); }
.head { display: flex; align-items: flex-start; gap: 10px; }
.min { min-width: 0; flex: 1; }
.nm { font-size: 15px; font-weight: 600; }
.id { font-size: 11.5px; color: var(--muted); }
.rows { display: flex; flex-direction: column; gap: 9px; margin: 13px 0; }
.r { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.lb { color: var(--muted); }
.ports { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.muted { color: var(--muted); }
.sm { font-size: 11.5px; }
.foot { display: flex; gap: 7px; padding-top: 12px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--muted); line-height: 1.6; }

/* 端口映射表：七列固定栅格，表头与数据行用同一套列宽才对得齐 */
.port-head, .port-row {
  display: grid;
  grid-template-columns: 88px 12px 88px 72px 142px minmax(120px, 1fr) 48px;
  gap: 8px;
  align-items: center;
}
.port-head {
  font-size: 11.5px;
  color: var(--muted);
  padding: 0 2px;
}
.arrow { color: var(--muted); text-align: center; }

/* 窄屏下不横向挤压，改为每行一块卡片 */
@media (max-width: 620px) {
  .port-head { display: none; }
  .port-row {
    grid-template-columns: 1fr 1fr;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--rs);
  }
  .arrow { display: none; }
}
/* 限定在 .hint 内：scoped 样式会跟着插槽内容跑进 tooltip 的传送门，
   裸 code 选择器会把提示框里的示例值刷成白底白字（实测不可见） */
.hint code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }
</style>
