<script setup lang="ts">
/**
 * 系统设置。
 *
 * 页面分两块，对应两种人：
 *   · **我的两步验证** —— 每个登录用户都看得到、都能操作自己的
 *   · **安全策略** —— 只有管理员能改，其他人只读。这几项一改影响所有人的登录，
 *     藏起来反而会让人对着「怎么突然被踢出去了」发懵，所以给看不给改
 *
 * 这里**没有** EXTERNAL_URL、主密钥、数据根、缓存写满策略 —— 那些留在 compose 里，
 * 从 Web 改前两个能把自己锁在外面，改最后一个是替客户做数据取舍。
 */
import { ref, computed, onMounted, h } from 'vue';
import {
  NButton, NCard, NForm, NFormItem, NInputNumber, NSwitch, NSpace, NAlert, NSpin,
  NTag, NInput, NModal, useMessage, useDialog,
} from 'naive-ui';
import { api, ApiError } from '../../api/client';
import type { SystemSettings, TotpStatus, TotpSetup } from '../../api/types';
import FieldHelp from '../../components/FieldHelp.vue';

const message = useMessage();
const dialog = useDialog();

const loading = ref(true);
const saving = ref(false);
const canManage = ref(false);
const totp = ref<TotpStatus | null>(null);
const updatedAt = ref('');
const updatedBy = ref('');

/** 浏览器与服务端的时钟偏差，秒。TOTP 全靠时钟，绑定前必须让人看见它 */
const skewSec = ref<number | null>(null);

const form = ref<Pick<SystemSettings,
  'sessionIdleMin' | 'loginMaxFailures' | 'loginLockMin' | 'require2fa' | 'updateCheckEnabled'>>({
  sessionIdleMin: 480,
  loginMaxFailures: 5,
  loginLockMin: 5,
  require2fa: false,
  updateCheckEnabled: true,
});

async function refresh() {
  loading.value = true;
  try {
    /*
     * 偏差要在请求**两端**各取一次时间，减掉往返的一半 ——
     * 只用响应到达时刻的话，网络慢一点就会把延迟算成时钟不准。
     */
    const t0 = Date.now();
    const r = await api.settings();
    const rtt = Date.now() - t0;
    const server = new Date(r.serverTime).getTime();
    skewSec.value = Math.round((t0 + rtt / 2 - server) / 1000);

    canManage.value = r.canManage;
    updatedAt.value = r.settings.updatedAt;
    updatedBy.value = r.settings.updatedBy;
    form.value = {
      sessionIdleMin: r.settings.sessionIdleMin,
      loginMaxFailures: r.settings.loginMaxFailures,
      loginLockMin: r.settings.loginLockMin,
      require2fa: r.settings.require2fa,
      updateCheckEnabled: r.settings.updateCheckEnabled,
    };
    totp.value = await api.totpStatus();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

/** 超过 30 秒就该提醒：TOTP 的窗口是 ±30 秒，再多就会开始验不过 */
const skewBad = computed(() => skewSec.value !== null && Math.abs(skewSec.value) > 30);

async function save() {
  saving.value = true;
  try {
    const r = await api.saveSettings(form.value);
    updatedAt.value = r.settings.updatedAt;
    updatedBy.value = r.settings.updatedBy;
    message.success('已保存，立即生效');
    totp.value = await api.totpStatus();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

// ── 我的两步验证 ────────────────────────────────────────

const setup = ref<TotpSetup | null>(null);
const enrollCode = ref('');
const enrolling = ref(false);
/** 恢复码只在确认那一刻回一次，拿到后必须让用户当场存走 */
const codes = ref<string[]>([]);

async function beginEnroll() {
  try {
    setup.value = await api.totpSetup();
    enrollCode.value = '';
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '无法开始绑定');
  }
}

async function confirmEnroll() {
  enrolling.value = true;
  try {
    const r = await api.totpConfirm(enrollCode.value);
    codes.value = r.codes;
    setup.value = null;
    totp.value = await api.totpStatus();
    message.success('两步验证已开启');
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '验证码不正确');
  } finally {
    enrolling.value = false;
  }
}

/** 模板里够不到 navigator，复制一律走这里 */
async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success(okMsg);
  } catch {
    message.warning('浏览器不允许复制，请手动选中');
  }
}

function copySecret() {
  if (setup.value) void copyText(setup.value.secret, '密钥已复制');
}

function copyCodes() {
  void copyText(codes.value.join('\n'), '恢复码已复制');
}

function disable2fa() {
  const password = ref('');
  dialog.warning({
    title: '关闭两步验证',
    content: () => h('div', [
      h('p', { style: 'margin:0 0 10px' },
        '关闭后只凭口令即可登录。请输入当前口令确认 —— 只凭一个已登录的会话就能关掉，这层防护就形同虚设。'),
      h(NInput, {
        type: 'password', placeholder: '当前口令',
        value: password.value,
        'onUpdate:value': (v: string) => { password.value = v; },
      }),
    ]),
    positiveText: '关闭两步验证',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.totpDisable(password.value);
        totp.value = await api.totpStatus();
        codes.value = [];
        message.success('已关闭两步验证');
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '关闭失败');
        return false;
      }
      return true;
    },
  });
}


const dbTime = (v: string) =>
  (v ? new Date(`${v.replace(' ', 'T')}Z`).toLocaleString() : '—');
</script>

<template>
  <div class="page">
    <div class="bar">
      <div>
        <h2>系统设置</h2>
        <!-- 模板里不会渲染 markdown，强调要用标签 -->
        <p class="sub">只放<b>运行期可改</b>的项；部署参数（外部地址、主密钥、数据根、缓存策略）留在部署文件里</p>
      </div>
    </div>

    <NSpin :show="loading">
      <!-- 第一屏：我的两步验证。每个人都用得上，放最前 -->
      <NCard class="card" title="我的两步验证" :bordered="false">
        <div class="st">
          <NTag :type="totp?.enabled ? 'success' : 'default'" :bordered="false" size="small">
            {{ totp?.enabled ? '已开启' : '未开启' }}
          </NTag>
          <span v-if="totp?.enabled" class="muted sm">
            剩余恢复码 {{ totp.recoveryLeft }} 条
          </span>
          <span v-else-if="totp?.required" class="warn sm">系统要求全员开启</span>
          <div class="spacer" />
          <NButton v-if="!totp?.enabled && !setup" size="small" type="primary" @click="beginEnroll">
            开始绑定
          </NButton>
          <NButton v-if="totp?.enabled && !totp.required" size="small" quaternary type="error"
                   @click="disable2fa">关闭</NButton>
        </div>

        <NAlert v-if="totp?.enabled && totp.recoveryLeft <= 2" type="warning"
                :bordered="false" style="margin-top:12px">
          恢复码只剩 {{ totp.recoveryLeft }} 条。用完之后一旦验证器丢失，就只能找管理员强制解绑。
          建议关闭再重新绑定，换一批新的。
        </NAlert>

        <NAlert v-if="skewBad" type="warning" :bordered="false" style="margin-top:12px">
          这台浏览器与服务端时间相差 <b>{{ skewSec }} 秒</b>。
          两步验证的验证码每 30 秒一换、只容忍 ±30 秒的偏差 ——
          偏差过大时验证码会一直「不正确」，而错误信息看不出是时钟的问题。
          请先给盒子对时（NTP）再绑定。
        </NAlert>

        <!-- 绑定流程：先给密钥，验过码才启用 -->
        <div v-if="setup" class="enroll">
          <p class="hint">
            在验证器 App（Google Authenticator、1Password、Authy 等）里<b>手动添加账号</b>，
            填入下面的密钥，再把它生成的 6 位数字填回来。
          </p>
          <NFormItem label="密钥">
            <div class="secret">
              <code class="mono">{{ setup.grouped }}</code>
              <NButton size="tiny" @click="copySecret">复制</NButton>
            </div>
          </NFormItem>
          <NFormItem label="账号类型">
            <span class="muted sm mono">基于时间（TOTP）· SHA1 · 6 位 · 30 秒</span>
          </NFormItem>
          <NFormItem label="验证码">
            <NSpace :size="10">
              <NInput v-model:value="enrollCode" class="mono code-in" placeholder="6 位数字"
                      inputmode="numeric" @keyup.enter="confirmEnroll" />
              <NButton type="primary" :loading="enrolling" @click="confirmEnroll">确认开启</NButton>
              <NButton quaternary @click="setup = null">取消</NButton>
            </NSpace>
          </NFormItem>
        </div>

        <!-- 恢复码只出现这一次 -->
        <div v-if="codes.length" class="codes">
          <NAlert type="success" :bordered="false">
            <b>请立刻保存这 10 条恢复码</b>，它们只显示这一次 ——
            验证器丢失时，每条可以顶一次验证码使用。
          </NAlert>
          <div class="grid mono">
            <span v-for="c in codes" :key="c">{{ c }}</span>
          </div>
          <NSpace>
            <NButton size="small" @click="copyCodes">复制全部</NButton>
            <NButton size="small" quaternary @click="codes = []">我已保存</NButton>
          </NSpace>
        </div>
      </NCard>

      <!-- 第二屏：安全策略。管理员可改，其他人只读 -->
      <NCard class="card" title="安全策略" :bordered="false">
        <NAlert v-if="!canManage" type="info" :bordered="false" style="margin-bottom:14px">
          这几项只有管理员能改。列在这里是让你知道当前规则 ——
          「怎么突然被退出登录了」多半就是会话超时到了。
        </NAlert>

        <NForm label-placement="top" :disabled="!canManage">
          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:260px">
              <template #label>
                会话空闲上限
                <FieldHelp>
                  <p>多久没有任何操作就自动退出登录。默认 480 分钟（8 小时）。</p>
                  <p>值班室长期开着页面的现场可以放大；工控机放在车间、谁都能碰的，
                    应当压到 30 分钟以内。</p>
                </FieldHelp>
              </template>
              <NInputNumber v-model:value="form.sessionIdleMin" :min="5" :max="43200">
                <template #suffix>分钟</template>
              </NInputNumber>
            </NFormItem>
            <NFormItem style="flex:1;min-width:260px">
              <template #label>
                升级检查
                <FieldHelp>
                  <p>关掉后<b>不再向外发起任何版本检查请求</b>。</p>
                  <p>工业现场对「设备自己往外连」很敏感，出了事要能立刻停掉，
                    而不是去改部署文件再重启一遍。</p>
                </FieldHelp>
              </template>
              <NSwitch v-model:value="form.updateCheckEnabled" />
            </NFormItem>
          </NSpace>

          <NSpace :size="14">
            <NFormItem style="flex:1;min-width:260px">
              <template #label>
                登录失败锁定次数
                <FieldHelp>
                  <p>同一「来源 IP + 用户名」连续失败这么多次后锁定。默认 5 次。</p>
                  <p>计数分摊到来源 IP 上，所以别人对着你的账号乱试，
                    锁住的是他自己那条路，不是你。</p>
                </FieldHelp>
              </template>
              <NInputNumber v-model:value="form.loginMaxFailures" :min="3" :max="20">
                <template #suffix>次</template>
              </NInputNumber>
            </NFormItem>
            <NFormItem style="flex:1;min-width:260px">
              <template #label>
                锁定时长
                <FieldHelp><p>锁定多久后自动解除，期间正确口令也会被拒。默认 5 分钟。</p></FieldHelp>
              </template>
              <NInputNumber v-model:value="form.loginLockMin" :min="1" :max="1440">
                <template #suffix>分钟</template>
              </NInputNumber>
            </NFormItem>
          </NSpace>

          <NFormItem>
            <template #label>
              强制全员两步验证
              <FieldHelp>
                <p>开启后，没绑定的人登录仍能进来，但<b>除了绑定页什么都做不了</b> ——
                  不发会话是做不到的，绑定本身就需要一个已登录的身份。</p>
                <p class="fh-warn">开之前先确认现场的盒子已经对时。TOTP 完全靠时钟，
                  盒子时间偏了会让所有人的验证码一起失效。</p>
                <p>有人手机丢了、恢复码也用光时，管理员可以在「用户与权限」里强制解绑。</p>
              </FieldHelp>
            </template>
            <NSwitch v-model:value="form.require2fa" />
          </NFormItem>

          <NAlert v-if="form.require2fa && !totp?.enabled" type="warning" :bordered="false">
            你自己还没有绑定两步验证。保存后你会被要求先完成绑定才能继续操作 ——
            建议先在上面绑好再开这个开关。
          </NAlert>
        </NForm>

        <template v-if="canManage" #footer>
          <NSpace justify="space-between" align="center">
            <span class="muted sm">
              {{ updatedAt ? `上次修改 ${dbTime(updatedAt)} · ${updatedBy}` : '尚未修改过' }}
            </span>
            <NButton type="primary" :loading="saving" @click="save">保存</NButton>
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

.st { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.spacer { margin-left: auto; }
.muted { color: var(--muted); }
.warn { color: var(--warning); }
.sm { font-size: 12px; }
.hint { font-size: 12.5px; color: var(--muted); line-height: 1.75; margin: 0 0 12px; }

.enroll { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.secret { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/* 密钥要能被肉眼一位位抄下来，字距放开一点 */
.secret code { font-size: 14px; letter-spacing: .12em; user-select: all; }
.code-in { width: 140px; }

.codes { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
/* 恢复码两列排开，抄写和核对都比一长串顺 */
.grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 6px 16px; font-size: 13px; letter-spacing: .06em;
}
</style>
