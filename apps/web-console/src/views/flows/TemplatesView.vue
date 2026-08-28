<script setup lang="ts">
/**
 * 流程模板（T4.6）。
 *
 * 模板解决的是**同一套流程要铺到很多台**这件事：调好一条产线，
 * 剩下九条不该再手工画一遍。所以这一页围绕两个动作组织 ——
 * 「把某台调好的流程存下来」和「把它铺到另一台上」。
 *
 * 全页最危险的一步是**套用**：它整体替换目标实例的全部流程，旧流程不保留。
 * 因此套用被拆成两段，中间必须过一次试算：
 *
 *     选目标实例 → 试算（只查不动）→ 看清楚要覆盖什么 → 才出现确认按钮
 *
 * 不做「选完直接套」的快捷路径。少点一次的代价，是有人把别的产线覆盖掉。
 */
import { ref, computed, onMounted } from 'vue';
import {
  NButton, NCard, NModal, NForm, NFormItem, NInput, NSelect, NSpin, NAlert,
  NTag, NSpace, NPopconfirm, NEmpty, useMessage,
} from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type { FlowTemplate, Instance, ApplyPreview, CompatResult } from '../../api/types';
import { can, canOperate, loadPermissions } from '../../api/permissions';
// 这里的 createdAt 来自 SQLite 的 datetime('now')：是 UTC 但不带 Z，
// 直接 new Date() 会按本地解析，东八区差 8 小时（见 api/datetime.ts）
import { localTime } from '../../api/datetime';
import FieldHelp from '../../components/FieldHelp.vue';

const message = useMessage();

const templates = ref<FlowTemplate[]>([]);
const instances = ref<Instance[]>([]);
const loading = ref(true);
const loadError = ref('');

const manage = computed(() => can('template:manage'));

async function refresh() {
  loading.value = true;
  loadError.value = '';
  /*
   * 两个请求的地位不一样，所以不能用 `Promise.all` 一荣俱荣：
   * 模板是这一页的主体，实例列表只用来显示来源名字和挑套用目标。
   * 后者失败时仍应把模板列出来（还能下载、改名、删除），
   * 而不是整页空白 —— 那会让「实例接口抖了一下」看起来像「模板全没了」。
   */
  try {
    templates.value = (await api.templates()).templates;
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载模板失败';
  }
  try {
    instances.value = (await api.instances()).instances;
  } catch {
    // 静默降级：套用入口会自己置灰并说明原因，不必再报一次错
    instances.value = [];
  }
  loading.value = false;
}

/** 来源实例已被删除时，退回显示 id —— 比显示空白强，至少还能对上审计 */
function sourceLabel(t: FlowTemplate): string {
  if (t.source === 'upload') return '文件导入';
  return instances.value.find((i) => i.id === t.source)?.name ?? t.source;
}

// ── 新建 ────────────────────────────────────────────────

const showCreate = ref(false);
const creating = ref(false);
const createErr = ref('');
/** 两种来源。默认「从实例导出」——这是绝大多数模板的真实来源 */
const fromKind = ref<'instance' | 'file'>('instance');
const form = ref({ name: '', description: '', instanceId: '' });
/** 上传文件解析出来的流程数组。解析失败时为 null，同时 fileErr 有值 */
const fileFlows = ref<unknown[] | null>(null);
const fileName = ref('');
const fileErr = ref('');

/** 能建模板的来源实例：要能查看那台（后端会再判一次矩阵） */
const sourceOptions = computed(() =>
  instances.value.map((i) => ({
    label: `${i.name}（${i.id}）${i.running ? '' : ' · 已停止'}`,
    value: i.id,
    // 停着的实例取不到流程 —— 它的 admin 接口根本不在
    disabled: !i.running,
  })));

function openCreate() {
  form.value = { name: '', description: '', instanceId: '' };
  fromKind.value = 'instance';
  fileFlows.value = null;
  fileName.value = '';
  fileErr.value = '';
  createErr.value = '';
  showCreate.value = true;
}

async function pickFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  fileName.value = f.name;
  fileErr.value = '';
  fileFlows.value = null;
  try {
    const parsed = JSON.parse(await f.text());
    /*
     * Node-RED 导出的是**数组**。有人会导出整个 settings 或从编辑器里
     * 复制一个对象过来，那种在这里就要挡下，而不是等后端回一句
     * 「流程格式不正确」——那时候用户还不知道是文件选错了。
     */
    if (!Array.isArray(parsed)) {
      fileErr.value = '这不是 Node-RED 的流程文件：顶层应当是一个数组。'
        + '请用编辑器里「导出 → 全部流程」得到的那份 JSON。';
      return;
    }
    fileFlows.value = parsed;
    // 没填名字就拿文件名兜底，省一次输入
    if (form.value.name === '') form.value.name = f.name.replace(/\.json$/i, '');
  } catch {
    fileErr.value = '文件不是合法的 JSON，读不出来。';
  }
}

const canSubmitCreate = computed(() => {
  if (form.value.name.trim() === '') return false;
  return fromKind.value === 'instance'
    ? form.value.instanceId !== ''
    : fileFlows.value !== null;
});

async function submitCreate() {
  creating.value = true;
  createErr.value = '';
  try {
    const body = fromKind.value === 'instance'
      ? { name: form.value.name, description: form.value.description, instanceId: form.value.instanceId }
      : { name: form.value.name, description: form.value.description, content: fileFlows.value };
    const { template } = await api.createTemplate(body);
    showCreate.value = false;
    message.success(`模板「${template.name}」已保存：${template.nodeCount} 个节点`);
    if (template.warnings.length) {
      message.warning(
        `扫出 ${template.warnings.length} 处疑似写死的凭据，分发前请先看模板详情`,
        { duration: 8000 },
      );
    }
    await refresh();
  } catch (e) {
    createErr.value = e instanceof ApiError ? e.message : '保存失败';
  } finally {
    creating.value = false;
  }
}

// ── 重命名 ──────────────────────────────────────────────

const showRename = ref(false);
const renaming = ref(false);
const renameTarget = ref<FlowTemplate | null>(null);
const renameForm = ref({ name: '', description: '' });

function openRename(t: FlowTemplate) {
  renameTarget.value = t;
  renameForm.value = { name: t.name, description: t.description };
  showRename.value = true;
}

async function submitRename() {
  const t = renameTarget.value;
  if (!t) return;
  renaming.value = true;
  try {
    await api.renameTemplate(t.id, renameForm.value.name, renameForm.value.description);
    showRename.value = false;
    message.success('已保存');
    await refresh();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    renaming.value = false;
  }
}

async function remove(t: FlowTemplate) {
  try {
    await api.deleteTemplate(t.id);
    message.success(`模板「${t.name}」已删除`);
    await refresh();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

async function download(t: FlowTemplate) {
  try {
    const { blob, filename } = await api.downloadTemplate(t.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '下载失败');
  }
}

// ── 套用 ────────────────────────────────────────────────

const showApply = ref(false);
const applyTarget = ref<FlowTemplate | null>(null);
const applyInstanceId = ref('');
const preview = ref<ApplyPreview | null>(null);
const previewing = ref(false);
const applying = ref(false);
const applyErr = ref('');

/**
 * 可以被套用的实例：要**能操作**（不是只能看），而且**正在运行**。
 *
 * 不给「不能操作的实例」留一个灰着的选项 —— 现场看到一个点不动的目标，
 * 只会去问为什么，而答案（授权矩阵里没给 operate）不在这一页上。
 */
const targetOptions = computed(() =>
  instances.value
    .filter((i) => canOperate(i.id))
    .map((i) => ({
      label: `${i.name}（${i.id}）${i.running ? '' : ' · 已停止'}`,
      value: i.id,
      disabled: !i.running,
    })));

/**
 * 一个套不了的原因。
 *
 * 「套用到实例」置灰而不说为什么，用户只能猜是权限、是没实例、还是页面坏了 ——
 * 三种猜测里有两种会变成一个电话。所以把当前这台上真实的原因写出来。
 */
const noTargetReason = computed(() => {
  if (targetOptions.value.length > 0) return '';
  if (instances.value.length === 0) {
    // 取不到实例列表时也是这一支。两种情况下一步不同，但都指向「实例」页，
    // 到那儿一眼就能看出是没有还是没取到，不在这里替它下结论
    return '没有可用的实例。到「实例」页看一眼：没有就建一台，有就说明刚才没取到列表，刷新即可。';
  }
  const operable = instances.value.filter((i) => canOperate(i.id));
  if (operable.length === 0) {
    return '你对现有实例只有查看权限，套用属于改动，需要授权矩阵里给到「操作」。'
      + '找管理员在「用户与权限」页调整。';
  }
  return '你能操作的实例都停着。套用要写入实例的流程接口，容器停着时那个接口不存在，'
    + '先到「实例」页把目标实例启动起来。';
});

/**
 * 试算结论的三态。
 *
 * 「没查成」必须和「查过、齐全」分开：后端取不到节点清单时不阻断部署，
 * 那时 `ok` 仍是 true —— 只看 `ok` 就会给一次没做成的检查发绿牌。
 */
function verdictOf(c: CompatResult): { text: string; type: 'success' | 'warning' | 'error' } {
  if (!c.checked) return { text: '没能确认节点是否齐全', type: 'warning' };
  if (!c.ok) return { text: `缺 ${c.missing.length} 种节点`, type: 'error' };
  return { text: '节点齐全，可以套用', type: 'success' };
}

function openApply(t: FlowTemplate) {
  applyTarget.value = t;
  applyInstanceId.value = '';
  preview.value = null;
  applyErr.value = '';
  showApply.value = true;
}

/** 换目标就作废上一次的试算结果，否则会拿 A 的结论去覆盖 B */
async function onTargetChange(id: string) {
  applyInstanceId.value = id;
  preview.value = null;
  applyErr.value = '';
  if (id === '' || !applyTarget.value) return;
  previewing.value = true;
  try {
    preview.value = await api.previewApply(id, applyTarget.value.id);
  } catch (e) {
    applyErr.value = e instanceof ApiError ? e.message : '试算失败';
  } finally {
    previewing.value = false;
  }
}

async function confirmApply() {
  const t = applyTarget.value;
  if (!t || applyInstanceId.value === '') return;
  applying.value = true;
  try {
    const r = await api.applyTemplate(applyInstanceId.value, t.id);
    showApply.value = false;
    const replaced = r.replacedNodeCount === null
      ? ''
      : `，替换掉原有 ${r.replacedNodeCount} 个节点`;
    if (r.compat.ok && r.compat.checked) {
      message.success(`已套用「${t.name}」：${r.nodeCount} 个节点${replaced}`);
    } else {
      // 部署确实成功了，但缺节点 —— 用 warning 而不是 success，
      // 因为这时候流程是「在跑但不出数」，说成功会误导
      message.warning(r.note, { duration: 10000 });
    }
  } catch (e) {
    applyErr.value = e instanceof ApiError ? e.message : '套用失败';
  } finally {
    applying.value = false;
  }
}

onMounted(async () => {
  await loadPermissions();
  await refresh();
});
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>流程模板</h2>
        <p class="sub">把调好的流程存成模板，铺到其它实例上</p>
      </div>
      <NButton v-if="manage" type="primary" size="small" @click="openCreate">新建模板</NButton>
    </div>

    <NAlert v-if="loadError" type="error" :bordered="false">{{ loadError }}</NAlert>

    <NSpin :show="loading">
      <NEmpty v-if="!loading && templates.length === 0" class="empty"
              description="还没有模板">
        <template #extra>
          <p class="hint" style="max-width:420px">
            先在某台实例里把流程调好，再回到这里「新建模板」把它存下来，
            之后就能一键铺到其它实例。也可以直接导入一份 Node-RED 导出的流程文件。
          </p>
        </template>
      </NEmpty>

      <NAlert v-else-if="!loading && noTargetReason" type="info" :bordered="false" class="why">
        <b>现在没有可套用的目标实例。</b>{{ noTargetReason }}
        模板仍然可以下载、改名和删除。
      </NAlert>

      <div v-if="templates.length" class="list">
        <NCard v-for="t in templates" :key="t.id" class="card" :bordered="false">
          <div class="th">
            <div class="tn">
              <span class="name">{{ t.name }}</span>
              <NTag size="small" :bordered="false">{{ t.nodeCount }} 节点</NTag>
              <NTag size="small" :bordered="false">{{ t.tabCount }} 标签页</NTag>
              <NTag v-if="t.warnings.length" size="small" :bordered="false" type="warning">
                {{ t.warnings.length }} 处疑似凭据
              </NTag>
            </div>
            <NSpace :size="8">
              <NButton size="tiny" secondary @click="download(t)">下载</NButton>
              <template v-if="manage">
                <NButton size="tiny" secondary @click="openRename(t)">改名</NButton>
                <NPopconfirm @positive-click="remove(t)">
                  <template #trigger><NButton size="tiny" secondary type="error">删除</NButton></template>
                  删除模板「{{ t.name }}」？已经套用出去的流程不受影响。
                </NPopconfirm>
              </template>
              <NButton size="tiny" type="primary" :disabled="targetOptions.length === 0"
                       @click="openApply(t)">套用到实例</NButton>
            </NSpace>
          </div>

          <p v-if="t.description" class="desc">{{ t.description }}</p>

          <div class="meta">
            <span>来源 <b>{{ sourceLabel(t) }}</b></span>
            <span>{{ t.createdBy }} 建于 {{ localTime(t.createdAt) }}</span>
            <span class="types mono">{{ t.nodeTypes.slice(0, 8).join(' ') }}<template
              v-if="t.nodeTypes.length > 8"> …共 {{ t.nodeTypes.length }} 种</template></span>
          </div>

          <NAlert v-if="t.warnings.length" type="warning" :bordered="false" class="warn">
            <b>这些节点里疑似写着凭据，模板发出去它们会一起走：</b>
            <span class="mono">{{ t.warnings.join('；') }}</span>
            <br>
            按规范声明的节点凭据不会被导出，这里报的是<b>写死在节点内容里</b>的那种。
            只提示不自动删除——改代码比泄漏更容易出事，请自己确认后再分发。
          </NAlert>
        </NCard>
      </div>
    </NSpin>

    <!-- 新建 -->
    <NModal v-model:show="showCreate" preset="card" title="新建模板" style="max-width: 640px">
      <NForm label-placement="top">
        <NFormItem>
          <template #label>
            模板来源
            <FieldHelp>
              <p><b>从实例导出</b>：读那台实例当前正在跑的流程。这是最常见的做法 ——
                在一台上调通，再铺到其它台。</p>
              <p><b>导入文件</b>：用 Node-RED 编辑器「导出 → 全部流程」存下来的 JSON，
                或从别的项目拷来的模板文件。</p>
              <p>实例必须<b>正在运行</b>才导得出来：流程存在实例自己的管理接口后面，
                容器停着时那个接口不存在。</p>
            </FieldHelp>
          </template>
          <NSpace>
            <NButton size="small" :type="fromKind === 'instance' ? 'primary' : 'default'"
                     @click="fromKind = 'instance'">从实例导出</NButton>
            <NButton size="small" :type="fromKind === 'file' ? 'primary' : 'default'"
                     @click="fromKind = 'file'">导入文件</NButton>
          </NSpace>
        </NFormItem>

        <NFormItem v-if="fromKind === 'instance'" label="来源实例">
          <NSelect v-model:value="form.instanceId" :options="sourceOptions"
                   placeholder="选一台正在运行的实例" />
        </NFormItem>

        <NFormItem v-else>
          <template #label>
            流程文件
            <FieldHelp>
              <p>顶层必须是<b>数组</b>——那是 Node-RED 导出流程的格式。</p>
              <p>选错文件（比如导出的是 settings 或单个节点）会在这里当场提示，
                不必等保存失败。</p>
            </FieldHelp>
          </template>
          <div class="file">
            <input type="file" accept="application/json,.json" @change="pickFile">
            <span v-if="fileFlows" class="ok">已读入 {{ fileFlows.length }} 个节点</span>
          </div>
        </NFormItem>
        <NAlert v-if="fileErr" type="error" :bordered="false" style="margin-bottom:12px">
          {{ fileErr }}
        </NAlert>

        <NFormItem>
          <template #label>
            模板名称
            <FieldHelp>
              <p>下载出来的文件名用它，<b>随时可改</b>。上限 64 字。</p>
              <p>写清楚「做什么用的」，例如「产线温度采集+告警」，
                别写「模板1」——半年后没人认得。</p>
            </FieldHelp>
          </template>
          <NInput v-model:value="form.name" placeholder="产线温度采集" />
        </NFormItem>

        <NFormItem>
          <template #label>
            说明
            <FieldHelp>
              <p>给下一个人看的：这套流程<b>假设了什么</b>。</p>
              <p>比如「需要 Modbus 从站在 502 端口」「上报周期 5 秒」——
                这些套用前不知道，套完就要现场返工。</p>
            </FieldHelp>
          </template>
          <NInput v-model:value="form.description" type="textarea"
                  :autosize="{ minRows: 2, maxRows: 4 }"
                  placeholder="适用场景、依赖的现场条件" />
        </NFormItem>

        <NAlert v-if="createErr" type="error" :bordered="false">{{ createErr }}</NAlert>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="showCreate = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creating"
                   :disabled="!canSubmitCreate" @click="submitCreate">保存模板</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 改名 -->
    <NModal v-model:show="showRename" preset="card" title="修改模板信息" style="max-width: 520px">
      <NForm label-placement="top">
        <NFormItem label="模板名称">
          <NInput v-model:value="renameForm.name" />
        </NFormItem>
        <NFormItem label="说明">
          <NInput v-model:value="renameForm.description" type="textarea"
                  :autosize="{ minRows: 2, maxRows: 4 }" />
        </NFormItem>
        <p class="hint">只改名字和说明，流程内容不动。</p>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="showRename = false">取消</NButton>
          <NButton size="small" type="primary" :loading="renaming"
                   :disabled="renameForm.name.trim() === ''" @click="submitRename">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 套用 -->
    <NModal v-model:show="showApply" preset="card"
            :title="`套用模板「${applyTarget?.name ?? ''}」`" style="max-width: 640px">
      <NAlert type="warning" :bordered="false" style="margin-bottom:14px">
        <b>套用会整体替换目标实例的全部流程，旧流程不保留。</b>
        目标实例上现有的流程会被这份模板顶掉——如果那台上有还需要的东西，
        先把它也存成模板再继续。
      </NAlert>

      <NForm label-placement="top">
        <NFormItem>
          <template #label>
            目标实例
            <FieldHelp>
              <p>只列出<b>你有操作权且正在运行</b>的实例。</p>
              <p>看不到某台，要么授权矩阵里只给了你「查看」，要么它停着 ——
                停着的实例没有可写入的流程接口。</p>
            </FieldHelp>
          </template>
          <NSelect :value="applyInstanceId" :options="targetOptions"
                   placeholder="选择要套用到哪一台"
                   @update:value="onTargetChange" />
        </NFormItem>
      </NForm>

      <NSpin :show="previewing">
        <div v-if="preview" class="pv">
          <div class="pvh">
            <span class="lb2">试算结果</span>
            <NTag size="small" :bordered="false" :type="verdictOf(preview.compat).type">
              {{ verdictOf(preview.compat).text }}
            </NTag>
          </div>
          <p class="pvn">
            将写入 <b>{{ preview.nodeCount }}</b> 个节点、
            <b>{{ preview.tabCount }}</b> 个标签页。
          </p>
          <NAlert v-if="!preview.compat.checked" type="warning" :bordered="false" class="warn">
            <b>这次没能确认节点是否齐全。</b>
            读目标实例的已装节点清单失败了（实例刚起、正忙、或网络抖动都会这样）。
            可以继续套用——套用本身不依赖这次检查；但万一缺节点，Node-RED
            <b>不会报错</b>，套完请到实例编辑器里看一眼有没有标红的节点。
          </NAlert>
          <NAlert v-else-if="!preview.compat.ok" type="error" :bordered="false" class="warn">
            <b>目标实例没装这些节点：</b>
            <span class="mono">{{ preview.compat.missing.join('、') }}</span>
            <br>
            Node-RED 遇到不认识的节点<b>不会报错</b>，它照常部署、把节点标红留在那里。
            现场表现是「流程套上了、就是不出数」。先在目标实例装齐这些节点再套。
          </NAlert>
          <!-- 上面两种异常各有一段专门的说明，再把后端的 note 原样贴一遍
               等于让人把同一件事读两遍；只在没有告警时才显示它 -->
          <p v-if="preview.compat.checked && preview.compat.ok" class="hint">{{ preview.note }}</p>
        </div>
        <p v-else-if="!previewing && applyInstanceId === ''" class="hint pad">
          选一台目标实例，会先做一次试算（只查不动），看清楚再决定。
        </p>
      </NSpin>

      <NAlert v-if="applyErr" type="error" :bordered="false" style="margin-top:12px">
        {{ applyErr }}
      </NAlert>

      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="showApply = false">取消</NButton>
          <!-- 没试算过就没有确认按钮：这一步不给「跳过检查直接套」的路径 -->
          <NPopconfirm v-if="preview" @positive-click="confirmApply">
            <template #trigger>
              <NButton size="small" type="primary" :loading="applying">
                {{ preview.compat.checked && !preview.compat.ok ? '仍然套用' : '确认套用' }}
              </NButton>
            </template>
            目标实例上现有的流程会被整体替换且不可撤销，确定继续？
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

.list { display: flex; flex-direction: column; gap: 14px; }
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

.file { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.file input { font-size: 12.5px; }
.ok { font-size: 12px; color: var(--success); }

.pv { margin-top: 6px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--rs); }
.pvh { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.pvn { margin: 0 0 8px; font-size: 12.5px; color: var(--text-2); }
.lb2 { font-size: 11.5px; color: var(--muted); }

.why { margin-bottom: 14px; line-height: 1.75; }
.empty { padding: 48px 0; }
.hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0; }
.hint.pad { padding: 20px 0; text-align: center; }
/* 限定在正文内：scoped 样式会跟着插槽内容跑进 FieldHelp 的传送门（12 号文 5.1） */
.hint code, .desc code, .n-alert code { background: var(--grey100); padding: 1px 5px; border-radius: 4px; }
</style>
