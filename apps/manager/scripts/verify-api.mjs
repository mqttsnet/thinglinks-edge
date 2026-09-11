/**
 * 实例 CRUD API 端到端验证，对着真实 Docker 跑完整生命周期。
 *
 * 每步都回到 Docker 核对真实状态，不只看 API 返回码 ——
 * API 说成功但容器没起来，是最容易漏掉的一类问题。
 */
import { access, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ValueHistory } from '../dist/core/edge/history.js';
import { redact } from '../dist/core/diag/redact.js';
import { Spool } from '../dist/core/spool/spool.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import {
  createFixtureIdentity,
  createRealInstanceFixture,
} from './_real-instance-fixture.mjs';
import { adminSession } from './_session.mjs';

const TAG = '5.0.4-24-minimal';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** 诊断信息永远只能辅助首因，不能因为值缺失再抛一次 TypeError。 */
export function preview(value, limit = 70) {
  let rendered;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return String(rendered ?? value).slice(0, limit);
}

/** 后续步骤依赖的关键断言失败时立即停止，避免用级联噪声覆盖首因。 */
export function requireCheck(name, ok, detail = '') {
  check(name, ok, detail);
  if (!ok) throw new Error(`${name}未通过${detail ? `：${detail}` : ''}`);
}

async function responseError(response) {
  const text = await response.clone().text().catch(() => '');
  if (!text) return '';
  try {
    const body = JSON.parse(text);
    return preview(body?.error ?? body, 120);
  } catch {
    return preview(text, 120);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const containerState = async (raw, id) =>
  raw.getContainer(containerName(id)).inspect().then((i) => i.State.Status).catch(() => 'missing');

const dataDirExists = async (root, id) =>
  access(join(root, id)).then(() => true).catch(() => false);

async function assertImageReferenceAbsent(raw, reference) {
  try {
    await raw.getImage(reference).inspect();
  } catch (error) {
    if (error?.statusCode === 404) return;
    throw error;
  }
  throw new Error(`随机缺镜像夹具意外存在：${reference}`);
}

const canBindPort = (port) => new Promise((resolveBind, reject) => {
  const listener = createTcpServer();
  listener.once('error', (error) => {
    if (error.code === 'EADDRINUSE') { resolveBind(false); return; }
    reject(error);
  });
  listener.listen(port, '127.0.0.1', () => {
    listener.close((error) => {
      if (error) { reject(error); return; }
      resolveBind(true);
    });
  });
});

export async function allocateMappedPort(excluded = [], adapters = {}) {
  const nextCandidate = adapters.nextCandidate ?? (() => randomInt(30000, 61000));
  const canBind = adapters.canBind ?? canBindPort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = nextCandidate();
    if (portIsUsable(port, excluded) && await canBind(port)) return port;
  }
  throw new Error('无法在验证端口范围内分配互不相邻的宿主端口');
}

export function portIsUsable(port, excluded = []) {
  return Number.isInteger(port)
    && port >= 30000
    && port <= 60999
    && excluded.every((used) => Math.abs(used - port) > 1);
}

export function isFreshLogEvent(event, actionAt) {
  const timestamp = Date.parse(String(event?.id ?? ''));
  return Number.isFinite(timestamp) && timestamp >= actionAt;
}

let activeFixture;
let activeSpool;
async function cleanup() {
  const failures = [];
  if (activeSpool) {
    const spool = activeSpool;
    activeSpool = undefined;
    try { await spool.close(); } catch (error) { failures.push(`spool: ${error.message}`); }
  }
  if (activeFixture) {
    const fixture = activeFixture;
    try {
      const fixtureFailures = await fixture.cleanup();
      failures.push(...fixtureFailures);
      if (fixtureFailures.length === 0) activeFixture = undefined;
    } catch (error) {
      failures.push(`fixture: ${error.message}`);
    }
  }
  if (failures.length > 0) throw new Error(`验证资源清理失败：${failures.join(' | ')}`);
}

async function main() {
  console.log('\n──── 实例 CRUD API · 真实 Docker 验证 ────\n');

  const identity = createFixtureIdentity({
    suite: 'api',
    roles: ['primary', 'second', 'missing'],
  });
  const ID = identity.instances.primary;
  const ID2 = identity.instances.second;
  const MISSING_ID = identity.instances.missing;
  // 缺镜像前提绑定本次 96-bit invocation，不依赖共享主机历史镜像集合。
  const MISSING_TAG = `0.0.0-missing-${identity.invocation}`;

  // 假云出口：可开可关，用来验「攒批 → 送出」以及「断网 → 缓存 → 补传」
  const cloudBatches = [];
  let cloudUp = true;
  activeFixture = await createRealInstanceFixture({
    identity,
    allowedImageTags: [TAG, MISSING_TAG],
    createServerExtras: async ({ db, runRoot }) => {
      activeSpool = await Spool.open({
        dir: join(runRoot, 'spool'),
        flushIntervalMs: 5,
        fullPolicy: 'drop-oldest',
      });
      return {
        spool: activeSpool,
        valueHistory: new ValueHistory(db, { maxRows: 1000, minGapSec: 300 }),
        cloudSink: async (payload) => {
          if (!cloudUp) throw new Error('模拟断网');
          cloudBatches.push(payload);
        },
      };
    },
  });
  await assertImageReferenceAbsent(activeFixture.raw, `nodered/node-red:${MISSING_TAG}`);
  const { raw, baseUrl: B, repo, instanceDataRoot } = activeFixture;

  // Helper 已先占用 Manager 与三条 Admin bridge 端口。映射端口必须在它们之后分配，
  // 否则 bind 前释放的“空闲端口”可能被 helper 复用，真正创建容器时才报冲突。
  const reservedPorts = [
    Number(new URL(B).port),
    activeFixture.inboundPort('primary'),
    activeFixture.inboundPort('second'),
    activeFixture.inboundPort('missing'),
  ];
  // 两个互不相邻的宿主端口，配两个互不相邻的容器端口（MQTT 1883 / Modbus 502）
  const PORT_A = await allocateMappedPort(reservedPorts);
  const PORT_B = await allocateMappedPort([...reservedPorts, PORT_A]);

  // 登录并取 CSRF 令牌
  const sess = await adminSession(
    B,
    activeFixture.adminPassword,
    activeFixture.adminNextPassword,
  );
  const { cookie, csrf } = sess;
  requireCheck('登录并下发 CSRF 令牌', sess.ok && sess.status === 200 && Boolean(csrf),
    `stage=${sess.stage} HTTP ${sess.status}`);

  const H = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };

  // 端口推荐
  const rec = await (await fetch(`${B}/api/ports/recommend?count=2`, { headers: { cookie } })).json();
  check('端口推荐可用', /^\d+-\d+$/.test(rec.recommended), rec.recommended);

  // 缺 CSRF 必须被拒
  const noCsrf = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id: ID, name: 'x', imageTag: TAG, ports: [] }),
  });
  check('缺少 CSRF 令牌的写操作被拒绝', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

  // 白名单外镜像被拒
  const badImg = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: 'x', imageTag: 'latest', ports: [] }),
  });
  const badImgError = await responseError(badImg);
  requireCheck('白名单外的镜像 tag 被拒绝',
    badImg.status === 400 && badImgError.includes('不在白名单'),
    `HTTP ${badImg.status} · ${badImgError}`);

  // 创建实例
  let created;
  try {
    // 两条**不连号**的映射：MQTT 1883 与 Modbus 502。
    // 早先「区间 + 起始容器端口递增」的设计根本表达不出这种组合，
    // 而现场协议端口从来就不连号 —— 这条断言就是防它退回去
    created = await activeFixture.createInstance('primary', sess, {
      name: '一号产线', imageTag: TAG, memoryMb: 256, cpus: 0.5,
      ports: [
        { hostPort: PORT_A, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT broker' },
        { hostPort: PORT_B, containerPort: 502, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'Modbus TCP' },
      ],
    });
  } catch (error) {
    requireCheck('创建实例返回 201', false, preview(error?.message ?? error, 400));
  }
  requireCheck('创建实例返回 201', created?.status === 201, `HTTP ${created?.status ?? 'unknown'}`);

  let state = 'missing';
  for (let i = 0; i < 30 && state !== 'running'; i++) { await sleep(1000); state = await containerState(raw, ID); }
  check('Docker 中容器确实在运行', state === 'running', `state=${state}`);
  check('数据目录已创建', await dataDirExists(instanceDataRoot, ID), `${instanceDataRoot}/${ID}`);

  // 列表反映真实状态
  const list = await (await fetch(`${B}/api/instances`, { headers: { cookie } })).json();
  const item = list.instances.find((i) => i.id === ID);
  check('列表反映真实运行状态', item?.running === true, `state=${item?.state}`);
  const byHost = Object.fromEntries((item?.ports ?? []).map((p) => [p.hostPort, p]));
  check('不连号的容器端口按填写原样落库（不再自动递增）',
        item?.ports?.length === 2
          && byHost[PORT_A]?.containerPort === 1883
          && byHost[PORT_B]?.containerPort === 502,
        JSON.stringify(item?.ports?.map((p) => `${p.hostPort}→${p.containerPort}`)));
  check('每条映射各自保留协议、网卡与用途',
        byHost[PORT_A]?.purpose === 'MQTT broker' && byHost[PORT_B]?.purpose === 'Modbus TCP'
          && byHost[PORT_A]?.protocol === 'tcp' && byHost[PORT_B]?.hostIp === '127.0.0.1',
        JSON.stringify(item?.ports));

  // 端口冲突
  const conflict = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID2, name: '二号', imageTag: TAG,
                           ports: [{ hostPort: PORT_A, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: '' }] }),
  });
  const conflictMsg = (await conflict.json()).error ?? '';
  check('端口冲突被拒且指出占用方', conflict.status === 400 && conflictMsg.includes(ID), conflictMsg.slice(0, 46));
  check('冲突后未残留半条记录', (await containerState(raw, ID2)) === 'missing');

  // 停止 / 启动
  const stopRes = await fetch(`${B}/api/instances/${ID}/stop`, { method: 'POST', headers: H });
  if (stopRes.status >= 400) console.log('    [debug] stop ->', stopRes.status, await stopRes.text());
  let stopped = 'x';
  for (let i = 0; i < 20 && stopped !== 'exited'; i++) { await sleep(500); stopped = await containerState(raw, ID); }
  check('停止后容器进入 exited', stopped === 'exited', `state=${stopped}`);

  await fetch(`${B}/api/instances/${ID}/start`, { method: 'POST', headers: H });
  let restarted = 'x';
  for (let i = 0; i < 20 && restarted !== 'running'; i++) { await sleep(500); restarted = await containerState(raw, ID); }
  check('启动后容器回到 running', restarted === 'running', `state=${restarted}`);

  // 日志
  // 容器刚重启，Node-RED 需要几秒才打印就绪行 —— 轮询而非一次性断言
  let logs = '';
  for (let i = 0; i < 30 && !logs.includes('Server now running at'); i++) {
    await sleep(1000);
    logs = await (await fetch(`${B}/api/instances/${ID}/logs?tail=80`, { headers: { cookie } })).text();
  }
  check('可读取实例日志', logs.includes('Server now running at'),
        logs.split('\n').find((l) => l.includes('running at'))?.trim().slice(-40));

  // 日志解帧 —— 容器以 Tty:false 运行，Docker 回的是多路复用流（8 字节帧头）。
  // 只断言「日志里有某个子串」是抓不住的：帧头在行首，子串照样匹配得到。
  const ctl = [...logs].filter((c) => c.codePointAt(0) < 0x09).map((c) => c.codePointAt(0));
  check('日志正文不含帧头控制字节', ctl.length === 0,
        ctl.length ? `残留 ${ctl.length} 个：0x${ctl[0].toString(16).padStart(2, '0')}…` : '');

  // 帧头正落在每个写入块的行首，因此「行首是否干净」是最贴近失败点的断言。
  // 注意不能断言「每行都以时间戳开头」—— Node-RED 启动横幅本来就有非时间戳行。
  const bodyLines = logs.split('\n').filter((l) => l.length > 0);
  const badHead = bodyLines.filter((l) => l.codePointAt(0) < 0x20);
  check('日志每行行首无控制字符', bodyLines.length > 0 && badHead.length === 0,
        badHead.length ? `${badHead.length}/${bodyLines.length} 行被顶掉行首` : `${bodyLines.length} 行`);

  const stamped = bodyLines.filter((l) => /^\d{1,2} \w{3} \d{2}:\d{2}:\d{2} - \[/.test(l));
  check('时间戳行数量正常（帧头会把行首推走）', stamped.length >= 5, `${stamped.length} 行带时间戳`);

  // ── 实时日志（SSE）──
  // 光断言「收到了历史行」证明不了 follow 在跟随 —— 那和快照接口没区别。
  // 必须在连接**保持打开**期间制造一条新日志，看它有没有被推过来。
  const anonSse = await fetch(`${B}/api/instances/${ID}/logs/stream`);
  await anonSse.body?.cancel();
  check('未登录访问实时日志被拒', anonSse.status === 401, `HTTP ${anonSse.status}`);

  const ac = new AbortController();
  const sse = await fetch(`${B}/api/instances/${ID}/logs/stream?tail=30`,
                          { headers: { cookie }, signal: ac.signal });
  const sseType = sse.headers.get('content-type') ?? '';
  check('实时日志返回 event-stream', sse.status === 200 && sseType.includes('text/event-stream'),
        `HTTP ${sse.status} ${sseType.split(';')[0]}`);

  /*
   * SSE 事件块是多行的（`id:` + `data:`，还可能有 `retry:` / 注释行），
   * 只看块首是不是 `data: ` 会整块漏掉 —— 必须逐行扫。
   */
  const readEvents = async (res, sink) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const evt = {};
          for (const raw of block.split('\n')) {
            if (raw.startsWith('id: ')) evt.id = raw.slice(4);
            else if (raw.startsWith('data: ')) evt.data = JSON.parse(raw.slice(6));
          }
          if (evt.data) sink({ ...evt.data, id: evt.id });
        }
      }
    } catch { /* abort 属正常结束 */ }
  };

  const events = [];
  const pump = readEvents(sse, (e) => events.push(e));

  // tail 历史是流式送达的。只等“第一条”会把余下历史误算成 follow 新事件；
  // 连续三个观察窗不再增长后，才冻结基线。
  let previousCount = -1;
  let stableWindows = 0;
  for (let i = 0; i < 25 && stableWindows < 3; i++) {
    await sleep(200);
    if (events.length > 0 && events.length === previousCount) stableWindows += 1;
    else stableWindows = 0;
    previousCount = events.length;
  }
  const history = events.length;
  check('连上先补发历史行', history > 0, `${history} 行`);
  check('推送的行已解帧',
        events.every((e) => ![...e.text].some((c) => c.codePointAt(0) < 0x09)));
  check('每行标出流别', events.every((e) => e.stream === 'stdout' || e.stream === 'stderr'),
        [...new Set(events.map((e) => e.stream))].join('+'));

  // 连接保持打开，此时停实例。follow 只绑定 Docker 日志时间戳，不绑定某版
  // Node-RED 的英文退出措辞（不同版本/空 flow 的文本并不稳定）。
  const followActionAt = Date.now();
  const followStop = await fetch(`${B}/api/instances/${ID}/stop`, { method: 'POST', headers: H });
  check('实时日志验证的停止请求被接受', followStop.status === 204, `HTTP ${followStop.status}`);
  let fresh = [];
  let followStopped = 'running';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    fresh = events.slice(history).filter((e) => isFreshLogEvent(e, followActionAt));
    followStopped = await containerState(raw, ID);
    if (fresh.length > 0 && followStopped === 'exited') break;
  }
  check('实时日志验证期间容器确实退出', followStopped === 'exited', `state=${followStopped}`);
  const freshSummary = fresh.slice(0, 6).map((event) => {
    const text = redact(String(event.text ?? ''), {
      secrets: [
        activeFixture.adminPassword,
        activeFixture.adminNextPassword,
        repo.ingestToken(ID),
      ],
    }).replace(/\s+/g, ' ').trim();
    return `${event.stream ?? '?'}:${preview(text.slice(-60), 60)}`;
  }).join(' | ');
  check('follow 生效：连接期间产生的新行被实时推送',
        fresh.length > 0,
        freshSummary || '没有晚于停止请求的事件');

  const lastId = [...events].reverse().find((e) => e.id)?.id;
  check('每个事件都带时间戳 id（续传要靠它）', Boolean(lastId), lastId ?? '没有 id');

  ac.abort();
  await pump;

  /*
   * 重连续传。浏览器重连时自带 Last-Event-ID，这里手工带上模拟。
   * 不做这件事的话，每次重连都会把 tail 那批历史再放一遍 ——
   * 实测断一次连，界面上 19 行变成 105 行。
   */
  const ac2 = new AbortController();
  const sse2 = await fetch(`${B}/api/instances/${ID}/logs/stream?tail=500`,
                           { headers: { cookie, 'last-event-id': lastId ?? '' }, signal: ac2.signal });
  const replayed = [];
  const pump2 = readEvents(sse2, (e) => replayed.push(e));
  await sleep(3000);
  ac2.abort();
  await pump2;
  check('带 Last-Event-ID 重连不重放历史', replayed.length === 0,
        replayed.length ? `重放了 ${replayed.length} 行：${replayed[0]?.text?.slice(0, 40)}` : '0 行');

  // 客户端断开后服务端要能继续正常服务，不能被一条挂死的流卡住
  const afterAbort = await fetch(`${B}/api/instances`, { headers: { cookie } });
  check('客户端断开后 API 仍正常', afterAbort.status === 200, `HTTP ${afterAbort.status}`);

  await fetch(`${B}/api/instances/${ID}/start`, { method: 'POST', headers: H });
  for (let i = 0; i < 30 && (await containerState(raw, ID)) !== 'running'; i++) await sleep(500);

  // ── 现场台账接入（@thinglinks 节点走的通道）──
  /*
   * 鉴权用每实例独立令牌，实例 id **只从令牌反查**。
   * 若实例 id 取自请求体，实例 A 就能往实例 B 的台账里写东西 —— 那是越权。
   */
  const token = repo.ingestToken(ID);
  check('实例创建时生成了接入令牌', typeof token === 'string' && token.length >= 24,
        token ? `${token.slice(0, 6)}…（${token.length} 位）` : '没有');

  const ingest = (path, body, tok = token) => fetch(`${B}/api/edge/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });

  const noTok = await ingest('devices', { nodeId: 'x', name: 'x' }, null);
  check('无令牌上报被拒', noTok.status === 401, `HTTP ${noTok.status}`);
  const badTok = await ingest('devices', { nodeId: 'x', name: 'x' }, 'not-a-real-token');
  check('伪造令牌上报被拒', badTok.status === 401, `HTTP ${badTok.status}`);

  const regDev = await ingest('devices', {
    devices: [
      { nodeId: 'plc-1', name: '1#注塑机', protocol: 'modbus-tcp', address: '192.168.1.10:502' },
      { nodeId: 'plc-2', name: '2#注塑机', protocol: 'modbus-tcp' },
    ],
  });
  check('设备注册被接受', regDev.status === 200 && (await regDev.json()).accepted === 2);

  const regTag = await ingest('tags', {
    tags: [{ nodeId: 'plc-1', tagId: 'temp', name: '料筒温度', unit: '°C', dataType: 'float' }],
  });
  check('点位定义被接受', regTag.status === 200);

  const vals = await ingest('values', {
    values: [
      { nodeId: 'plc-1', tagId: 'temp', value: 218.5 },
      { nodeId: 'plc-1', tagId: 'pressure', value: 12, quality: 'uncertain' },
      { nodeId: 'plc-2', tagId: 'state', value: 'running' },
    ],
  });
  check('点位值被接受（未定义的点位自动补定义）',
        vals.status === 200 && (await vals.json()).accepted === 3);

  const fieldDev = await (await fetch(`${B}/api/field/devices?instanceId=${ID}`, { headers: { cookie } })).json();
  check('控制台能读到设备台账', fieldDev.devices?.length === 2,
        (fieldDev.devices ?? []).map((d) => `${d.nodeId}${d.online ? '在线' : '离线'}`).join(' '));
  check('有值上来的设备被标记为在线',
        fieldDev.devices?.every((d) => d.online === true));

  const fieldTags = await (await fetch(`${B}/api/field/tags?instanceId=${ID}`, { headers: { cookie } })).json();
  const byTag = Object.fromEntries((fieldTags.tags ?? []).map((t) => [t.tagId, t]));
  check('点位值按原始类型返回，不是字符串化的',
        byTag['temp']?.lastValue === 218.5 && byTag['state']?.lastValue === 'running',
        `temp=${JSON.stringify(byTag['temp']?.lastValue)} state=${JSON.stringify(byTag['state']?.lastValue)}`);
  check('点位元数据与质量码正确',
        byTag['temp']?.unit === '°C' && byTag['pressure']?.quality === 'uncertain',
        `${byTag['temp']?.unit} / ${byTag['pressure']?.quality}`);

  /*
   * ── 点位历史：这里盯的是**接线**，不是模块本身 ──
   *
   * history.test.ts 已经把写入策略测透了。这几条要证的是另一件事：
   * 上报走 ingest 之后，历史真的被顺手落盘、并且能从控制台读回来。
   * 「模块验过」不等于「链路是通的」—— 云链路就栽过这一次（交接文档 B7）。
   */
  const hist = (q) => fetch(`${B}/api/field/history?instanceId=${ID}&${q}`, { headers: { cookie } })
    .then((r) => r.json());

  const h1 = await hist('nodeId=plc-1&tagId=temp');
  check('上报之后趋势接口就有数据（写入链路是通的）',
        h1.enabled === true && h1.points?.length === 1 && h1.points[0].value === 218.5,
        `enabled=${h1.enabled} points=${h1.points?.length} v=${JSON.stringify(h1.points?.[0]?.value)}`);

  await ingest('values', { values: [{ nodeId: 'plc-1', tagId: 'temp', value: 219.5 }] });
  await ingest('values', { values: [{ nodeId: 'plc-1', tagId: 'temp', value: 219.5 }] });
  const h2 = await hist('nodeId=plc-1&tagId=temp');
  check('值变了记一条、没变不重复记（省 SD 卡写入）',
        h2.points?.length === 2 && h2.points.map((p) => p.value).join(',') === '218.5,219.5',
        `${h2.points?.length} 条：${(h2.points ?? []).map((p) => p.value).join(',')}`);

  check('趋势回报最早时刻与容量，界面才能说清「只有最近这些」',
        typeof h2.oldest === 'string' && h2.maxRows === 1000, `oldest=${h2.oldest} max=${h2.maxRows}`);

  const histNoTag = await fetch(`${B}/api/field/history?instanceId=${ID}`, { headers: { cookie } });
  check('趋势必须指名点位，缺参数回 400', histNoTag.status === 400, `HTTP ${histNoTag.status}`);

  const histAnon = await fetch(`${B}/api/field/history?instanceId=${ID}&nodeId=plc-1&tagId=temp`);
  check('未登录读不到历史（里面是现场真实读数）', histAnon.status === 401, `HTTP ${histAnon.status}`);

  // 越权：拿 ID 的令牌不能写到别的实例名下 —— 请求体里根本没有实例字段
  const crossWrite = await ingest('devices', { nodeId: 'intruder', name: '越权', instanceId: ID2 });
  check('请求体里的 instanceId 被忽略（不能冒充别的实例）', crossWrite.status === 200);
  const victim = await (await fetch(`${B}/api/field/devices?instanceId=${ID2}`, { headers: { cookie } })).json();
  check('另一实例的台账未被写入', (victim.devices ?? []).length === 0,
        `${(victim.devices ?? []).length} 条`);

  // ── 微批聚合（B4）──
  /*
   * 三个触发条件任一满足即发（08 号文第 2 节）。这里验时间窗那条：
   * 攒几个点后等过窗口，应聚成**一条**消息，而不是每点一条。
   */
  cloudBatches.length = 0;
  const up = await ingest('uplink', {
    serviceId: 'env',
    nodeId: 'plc-1',
    data: { temperature: 21.5, humidity: 63, pressure: 101 },
  });
  const upBody = await up.json();
  check('上行入口收下并入批', up.status === 202 && upBody.cloud === 'queued',
        `HTTP ${up.status} cloud=${upBody.cloud}`);

  await sleep(600);   // 大于 200ms 时间窗
  check('过了时间窗后攒批送出，多点聚成一条消息',
        cloudBatches.length === 1, `${cloudBatches.length} 条`);

  const payload = cloudBatches[0];
  check('载荷结构对齐云侧 TopoDeviceDataReportParam',
        Array.isArray(payload?.devices) && payload.devices[0]?.deviceId === 'plc-1' &&
        Array.isArray(payload.devices[0]?.services),
        preview(payload));
  const svc = payload?.devices?.[0]?.services?.[0];
  check('同一时刻的多个点合并进同一条服务记录',
        svc && Object.keys(svc.data).sort().join(',') === 'humidity,pressure,temperature',
        svc ? Object.keys(svc.data).join(',') : '无');
  check('serviceCode 与 eventTime 齐备',
        svc?.serviceCode === 'env' && typeof svc?.eventTime === 'number' && svc.eventTime > 0,
        `${svc?.serviceCode} @ ${svc?.eventTime}`);

  const metrics = await (await fetch(`${B}/api/edge/metrics`, { headers: { cookie } })).json();
  check('指标接口暴露批量阈值与已发数量',
        metrics.batch?.limits?.windowMs === 200 && metrics.batch?.limits?.maxPoints === 2000 &&
        metrics.batch?.batches === 1 && metrics.batch?.points === 3,
        JSON.stringify(metrics.batch?.limits) + ` 已发 ${metrics.batch?.batches} 批 ${metrics.batch?.points} 点`);
  check('云端已配置时如实报告', metrics.cloud === 'configured', metrics.cloud);

  /*
   * 契约断言：控制台「微批与积压」卡片逐个读这些字段。
   * 少一个字段不会让接口报错，只会让卡片上那一格空着 —— 这种缺失很难被发现，
   * 所以在这里把整个形状钉住，而不是只挑几个抽查。
   */
  const BATCH_KEYS = ['limits', 'pending', 'pendingBytes', 'batches', 'points',
                      'failures', 'spooled', 'lastError'];
  const missingBatch = BATCH_KEYS.filter((k) => metrics.batch?.[k] === undefined);
  check('指标接口的 batch 字段与控制台契约一致',
        missingBatch.length === 0 &&
        typeof metrics.batch.limits.maxBytes === 'number',
        missingBatch.length ? `缺 ${missingBatch.join('、')}` : BATCH_KEYS.join(' '));

    // ── 断网缓存与补传（B5）──
  /*
   * 断网时批次必须落缓存而**不是丢掉**；链路恢复后自动补回去。
   * 这是「断网 1 小时不丢数并补传完毕」那条验收的核心机制。
   */
  cloudBatches.length = 0;
  cloudUp = false;
  for (let i = 0; i < 3; i++) {
    await ingest('uplink', { serviceId: 'env', nodeId: 'plc-1', data: { seq: i } });
    await sleep(260);            // 每轮都过一次时间窗，攒成 3 个批次
  }
  check('断网期间云端一条都没收到', cloudBatches.length === 0, `${cloudBatches.length} 条`);

  const m1 = await (await fetch(`${B}/api/edge/metrics`, { headers: { cookie } })).json();
  check('断网的批次落进了缓存，不是丢掉',
        m1.spool?.pending === 3 && m1.batch?.spooled === 3,
        `缓存 ${m1.spool?.pending} 条 · 已缓存 ${m1.batch?.spooled} 次`);
  check('缓存指标暴露占用与写满策略',
        typeof m1.spool?.bytes === 'number' && m1.spool?.bytes > 0 &&
        m1.spool?.policy === 'drop-oldest' && m1.spool?.full === false,
        `${m1.spool?.bytes} 字节 · ${m1.spool?.policy}`);

  // 链路恢复：下一次成功发送会自动带动补传
  cloudUp = true;
  await ingest('uplink', { serviceId: 'env', nodeId: 'plc-1', data: { seq: 99 } });
  await sleep(1200);
  check('链路恢复后自动补传，缓存清空',
        cloudBatches.length >= 4, `云端共收到 ${cloudBatches.length} 条`);

  const m2 = await (await fetch(`${B}/api/edge/metrics`, { headers: { cookie } })).json();
  check('补传后待补条数归零', m2.spool?.pending === 0, `剩 ${m2.spool?.pending} 条`);
  check('补传计数被记录', m2.spool?.replayed === 3, `已补传 ${m2.spool?.replayed} 条`);

  const SPOOL_KEYS = ['pending', 'bytes', 'maxBytes', 'usagePercent', 'full', 'policy',
                      'segments', 'droppedOldest', 'droppedNewest', 'rejected', 'replayed'];
  const missingSpool = SPOOL_KEYS.filter((k) => m2.spool?.[k] === undefined);
  check('指标接口的 spool 字段与控制台契约一致',
        missingSpool.length === 0 && typeof m2.spool.policy === 'string',
        missingSpool.length ? `缺 ${missingSpool.join('、')}` : `${SPOOL_KEYS.length} 项齐备`);

  const seqSeen = cloudBatches.map((b) => b.devices?.[0]?.services?.[0]?.data?.seq);
  check('补传内容一条不少（0,1,2 都回来了）',
        [0, 1, 2].every((n) => seqSeen.includes(n)), JSON.stringify(seqSeen));

  /*
   * 手动补传：控制台「立即补传」按钮走的就是这条。
   *
   * 上面那轮是**自动**补传（由一次成功发送带动），跑完缓存已空，
   * 这时候调手动接口只会拿到 {sent:0,failed:0} —— 那验不出它到底会不会排空。
   * 所以这里重新造一批积压，且**不再 ingest 新数据**（避免又触发自动补传），
   * 让手动接口成为唯一的排空途径。
   */
  cloudBatches.length = 0;
  cloudUp = false;
  for (const seq of [201, 202]) {
    await ingest('uplink', { serviceId: 'env', nodeId: 'plc-1', data: { seq } });
    await sleep(260);
  }
  const mBefore = await (await fetch(`${B}/api/edge/metrics`, { headers: { cookie } })).json();
  // 控制台的「立即补传」按钮正是靠 pending > 0 才从灰变亮
  check('断网后重新攒出积压，pending 如实大于 0',
        mBefore.spool?.pending === 2, `积压 ${mBefore.spool?.pending} 条`);

  cloudUp = true;
  const manual = await fetch(`${B}/api/edge/replay`, { method: 'POST', headers: H });
  const manualBody = await manual.json();
  check('手动补传把积压真的发出去了（不是只返回 200）',
        manual.status === 200 && manualBody.sent === 2 && manualBody.failed === 0,
        `HTTP ${manual.status} ${JSON.stringify(manualBody)}`);
  check('手动补传后云端确实收到了那两条',
        [201, 202].every((n) =>
          cloudBatches.some((b) => b.devices?.[0]?.services?.[0]?.data?.seq === n)),
        JSON.stringify(cloudBatches.map((b) => b.devices?.[0]?.services?.[0]?.data?.seq)));

  const mAfter = await (await fetch(`${B}/api/edge/metrics`, { headers: { cookie } })).json();
  check('手动补传后积压归零', mAfter.spool?.pending === 0, `剩 ${mAfter.spool?.pending} 条`);

    // ── 南向探测（T5.3，06 号文方案 A）──
  /*
   * 往真实实例的数据目录里写一份带原生 modbus 节点的 flows.json，
   * 验证平台能把这些「平台本来看不见」的设备尽力认出来 ——
   * 并且**明确标为未纳管**。
   */
  await writeFile(`${instanceDataRoot}/${ID}/flows.json`, JSON.stringify([
    { id: 'tab1', type: 'tab', label: '产线采集' },
    { id: 'cli1', type: 'modbus-client', name: '注塑机 PLC', clienttype: 'tcp',
      tcpHost: '192.168.10.31', tcpPort: '502' },
    { id: 'rd1', type: 'modbus-read', name: '料筒温度', server: 'cli1',
      dataType: 'HoldingRegister', adr: '40001', quantity: '4', unitid: '1' },
    { id: 'vendor1', type: 'some-vendor-plc', z: 'tab1' },
    { id: 'dbg', type: 'debug', z: 'tab1' },
  ]), 'utf8');

  const sb = await (await fetch(`${B}/api/field/southbound?instanceId=${ID}`, { headers: { cookie } })).json();
  check('从 flows.json 认出原生节点接的设备',
        sb.devices?.length === 1 && sb.devices[0].address === '192.168.10.31:502',
        sb.devices?.[0]?.address ?? '没认出');
  check('点位能对回所属设备', sb.tags?.[0]?.nodeId === 'cli1' &&
        sb.tags[0].address === 'HoldingRegister adr=40001 qty=4 unit=1', sb.tags?.[0]?.address ?? '');
  check('结果标为未纳管 —— 不能让用户以为是可信台账', sb.managed === false, String(sb.managed));
  check('认不出的第三方节点如实上报',
        sb.unrecognized?.some((u) => u.type === 'some-vendor-plc'),
        JSON.stringify(sb.unrecognized));

  const sum = await (await fetch(`${B}/api/field/summary?instanceId=${ID}`, { headers: { cookie } })).json();
  check('汇总把「已纳管」与「探测到」分开，不相加',
        typeof sum.managed?.devices === 'number' && /未纳管/.test(sum.note ?? ''),
        `已纳管 ${sum.managed?.devices} 台`);

  const sbNone = await (await fetch(`${B}/api/field/southbound?instanceId=${ID2}`, { headers: { cookie } })).json();
  check('实例没有 flows.json 时不报错，说明原因',
        sbNone.devices?.length === 0 && /尚无 flows.json/.test(sbNone.reason ?? ''),
        sbNone.reason ?? '');

    const anonRead = await fetch(`${B}/api/field/devices`);
  check('未登录读取台账被拒', anonRead.status === 401, `HTTP ${anonRead.status}`);

  // 重置口令
  const reset = await fetch(`${B}/api/instances/${ID}/credentials/admin/reset`, { method: 'POST', headers: H });
  const resetBody = await reset.text();
  if (reset.status >= 400) console.log('    [debug] reset ->', reset.status, resetBody);
  const newPw = (() => { try { return JSON.parse(resetBody).password; } catch { return undefined; } })();
  check('重置口令返回新口令且仅此一次', reset.status === 200 && typeof newPw === 'string' && newPw.length >= 20);

  let back = 'x';
  for (let i = 0; i < 40 && back !== 'running'; i++) { await sleep(1000); back = await containerState(raw, ID); }
  check('重置后实例重启并恢复运行', back === 'running', `state=${back}`);
  if (back === 'running') await activeFixture.captureCurrentInstance('primary');

  // 未登录访问 API
  const anon = await fetch(`${B}/api/instances`);
  check('未登录访问 API 被拒绝', anon.status === 401);

  // 删除：默认保留数据卷
  // 先移除验证专用的 Admin/registry bridge；否则它们会人为占住实例网络，
  // 把生产 service.remove 的网络回收语义测成假失败。
  const removal = await activeFixture.prepareInstanceRemoval('primary');
  const delRes = await fetch(`${B}/api/instances/${ID}`, { method: 'DELETE', headers: H });
  const delError = delRes.status === 204 ? '' : await responseError(delRes);
  check('删除请求被接受', delRes.status === 204,
    `HTTP ${delRes.status}${delError ? ` · ${delError}` : ''}`);
  check('删除后容器已移除', (await containerState(raw, ID)) === 'missing');
  let exactRemovalError = '';
  try {
    await activeFixture.assertPreparedInstanceRemoved(removal);
  } catch (error) {
    exactRemovalError = preview(error?.message ?? error, 160);
  }
  check('删除后按捕获的不可变 ID 与名称确认容器、网络均不存在',
    exactRemovalError === '', exactRemovalError);
  check('默认保留数据目录（不默认删数据）', await dataDirExists(instanceDataRoot, ID));

  // ── 控制台依赖的三个信息接口 ──
  /*
   * 这三条是控制台外壳与「新建实例」弹窗的数据来源。它们出问题不会让 API 报错，
   * 只会让界面显示成「版本 —」「版本下拉是空的」，很容易被当成前端小毛病。
   */
  const ver = await (await fetch(`${B}/api/version`, { headers: { cookie } })).json();
  check('版本接口返回版本号与使用者说明',
        /^\d+\.\d+\.\d+$/.test(String(ver.version)) && typeof ver.notes === 'string',
        `v${ver.version} · 说明 ${String(ver.notes).length} 字`);
  check('未配置 UPDATE_CHECK_URL 时不联网检查更新',
        ver.update?.enabled === false, JSON.stringify(ver.update));

  const perm = await (await fetch(`${B}/api/me/permissions`, { headers: { cookie } })).json();
  check('权限接口返回角色与动作清单',
        perm.role === 'admin' && Array.isArray(perm.actions) && perm.actions.includes('backup:run'),
        `${perm.role} · ${perm.actions?.length} 项动作`);

  // ── 镜像预检：本机没有的版本必须在选之前就标出来 ──
  /*
   * Docker API **不会自动拉取**（命令行的 docker create 会，容易让人误判）。
   * 镜像缺失时 containers/create 回 `No such image`，那句话对现场人员没有指导意义。
   */
  const imgs = await (await fetch(`${B}/api/images`, { headers: { cookie } })).json();
  const imgPresent = Object.fromEntries((imgs.images ?? []).map((i) => [i.tag, i.present]));
  check('镜像接口如实报告本机有没有该版本',
        imgPresent[TAG] === true && imgPresent[MISSING_TAG] === false, JSON.stringify(imgPresent));

  const missRes = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: MISSING_ID, name: '缺镜像', imageTag: MISSING_TAG, ports: [] }),
  });
  const missErr = String((await missRes.json()).error ?? '');
  check('用本机没有的镜像建实例被拒，且给的是能照做的说明',
        missRes.status === 400 && missErr.includes('本机没有镜像') && missErr.includes('docker load'),
        missErr.slice(0, 60).replace(/\n/g, ' '));
  // 失败路径不该留下半个实例
  check('预检失败后没有残留容器', (await containerState(raw, MISSING_ID)) === 'missing');

  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch(async (e) => {
    console.error('\n验证失败：', e.message, e.stack);
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error('\n清理失败：', cleanupError.message);
    }
    process.exit(1);
  });
}
