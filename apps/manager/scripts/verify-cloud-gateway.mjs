/**
 * 虚拟网关端到端验证 —— 对着**真实 MQTT broker**（eclipse-mosquitto）跑。
 *
 * 这里验的是「我们这一端做对了没有」：凭据真的发出去了、topic 拼对了、
 * 信封能被独立的第三方客户端拆开、下行验签会拦住伪造报文、断线能自愈。
 * 云侧鉴权与业务处理不在此列 —— 那要真云环境，另说。
 *
 * 用 mosquitto 而不是自己写个假 broker：假 broker 只能证明我们自说自话，
 * 证明不了协议层面（CONNECT 报文、QoS1 PUBACK、重连重订阅）真的对。
 */
import mqtt from 'mqtt';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CloudGateway, topicsFor } from '../dist/core/cloud/gateway.js';
import { dataSignOf, buildEnvelope, validateEnvelope, parseEnvelopeFull } from '../dist/core/cloud/envelope.js';
import { TOPO_SUCCESS, TOPO_FAILURE } from '../dist/core/cloud/topo.js';

const IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
const NAME = 'tle-mqtt-verify';
const PORT = 13240;
const URL = `mqtt://127.0.0.1:${PORT}`;

const DEVICE = 'edge-01-plant-a';
const CREDS = {
  clientId: '2130020836696064@1',       // 平台分配格式：<雪花ID>@<租户ID>
  deviceIdentification: DEVICE,
  username: 'edge-user',
  password: 'edge-pass-123',
};
const CIPHER = {
  cipherFlag: 2, signKey: 'sign-key-abc',
  encryptKey: '0123456789abcdef', encryptVector: 'abcdef0123456789',
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', ...opts });
const waitFor = async (fn, ms = 15000, step = 200) => {
  for (let i = 0; i < ms / step; i++) { if (await fn()) return true; await sleep(step); }
  return false;
};

function startBroker() {
  const dir = mkdtempSync(join(tmpdir(), 'tle-mosq-'));
  // 口令文件用镜像自带的 mosquitto_passwd 生成，避免手写哈希
  const hashed = sh(['run', '--rm', IMAGE, 'sh', '-c',
    `mosquitto_passwd -c -b /tmp/pw ${CREDS.username} ${CREDS.password} >/dev/null 2>&1 && cat /tmp/pw`]);
  writeFileSync(join(dir, 'passwd'), hashed);
  // allow_anonymous false —— 凭据没真发出去就连不上，这条断言才有意义
  writeFileSync(join(dir, 'mosquitto.conf'),
    'listener 1883\nallow_anonymous false\npassword_file /mosquitto/config/passwd\n');
  sh(['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:1883`,
      '-v', `${dir}/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro`,
      '-v', `${dir}/passwd:/mosquitto/config/passwd:ro`, IMAGE]);
}

const cleanup = () => { try { sh(['rm', '-f', NAME], { stdio: 'pipe' }); } catch { /* 没起过 */ } };

async function main() {
  console.log('\n──── 虚拟网关 · 真实 MQTT broker 验证 ────\n');
  cleanup();
  console.log('  · 启动 mosquitto…');
  startBroker();

  const reachable = await waitFor(async () => {
    try {
      const c = await mqtt.connectAsync(URL, { username: CREDS.username, password: CREDS.password });
      await c.endAsync(true); return true;
    } catch { return false; }
  });
  check('broker 就绪', reachable);
  if (!reachable) throw new Error('mosquitto 未就绪');

  // ── 凭据必须真的发出去 ──
  let anonRejected = false;
  try {
    const c = await mqtt.connectAsync(URL, { reconnectPeriod: 0, connectTimeout: 4000 });
    await c.endAsync(true);
  } catch { anonRejected = true; }
  check('匿名连接被 broker 拒绝（口令校验确实开着）', anonRejected);

  let badRejected = false;
  try {
    const bad = new CloudGateway({ brokerUrl: URL, cipher: CIPHER,
      credentials: { ...CREDS, password: 'wrong' }, reconnectPeriodMs: 0, connectTimeoutMs: 4000 });
    await bad.connect(); await bad.close();
  } catch { badRejected = true; }
  check('口令错误时网关连接失败', badRejected);

  // ── 正常接入 ──
  const gw = new CloudGateway({ brokerUrl: URL, credentials: CREDS, cipher: CIPHER, reconnectPeriodMs: 1000 });
  const states = [];
  gw.onStateChange((s) => states.push(s));
  const commands = [];
  gw.onCommand((c) => commands.push(c));
  await gw.connect();
  check('网关以平台分配的 clientId 接入', gw.connected, CREDS.clientId);

  check('topic 按协议版本与网关标识拼装',
        gw.topics.datas === `/v1/devices/${DEVICE}/datas` &&
        gw.topics.topoAdd === `/v1/devices/${DEVICE}/topo/add`,
        gw.topics.datas);

  // ── 上行：由独立客户端接收并拆包 ──
  const spy = await mqtt.connectAsync(URL, { username: CREDS.username, password: CREDS.password });
  const seen = [];
  spy.on('message', (t, p) => seen.push({ topic: t, raw: p.toString('utf8') }));
  await spy.subscribeAsync(`/v1/devices/${DEVICE}/#`, { qos: 1 });

  const payload = { services: [{ serviceId: 'env', data: { temperature: 21.5, humidity: 63 } }] };
  await gw.publishData(payload);
  check('上行 QoS1 发布返回（broker 已回 PUBACK）', true);

  const got = await waitFor(async () => seen.length > 0, 8000);
  check('第三方客户端确实收到了上行报文', got, seen[0]?.topic ?? '');

  const env = got ? JSON.parse(seen[0].raw) : null;
  check('报文是合法信封结构', Boolean(env) && validateEnvelope(env));
  check('dataSign 与 sha256(timeStamp:signKey) 一致',
        Boolean(env) && env.dataSign === dataSignOf(env.head.timeStamp, CIPHER.signKey));
  check('加密时 dataBody 是 HEX 字符串而非对象',
        typeof env?.dataBody === 'string', typeof env?.dataBody);
  check('mid 为正且在 JS 安全整数内',
        Number.isSafeInteger(env?.head?.mid) && env.head.mid > 0, String(env?.head?.mid));

  // 用独立路径解密（不复用网关实例），确认对端真能还原
  const { parseEnvelope } = await import('../dist/core/cloud/envelope.js');
  let restored = null;
  try { restored = parseEnvelope(seen[0].raw, CIPHER); } catch { /* 下面断言 */ }
  check('密文可被还原为原始业务报文', JSON.stringify(restored) === JSON.stringify(payload));

  // ── 下行：命令与伪造报文 ──
  const cmd = { serviceId: 'reboot', cmd: 'restart', paras: { delay: 5 } };
  await spy.publishAsync(gw.topics.command, JSON.stringify(buildEnvelope(cmd, CIPHER)), { qos: 1 });
  const gotCmd = await waitFor(async () => commands.length > 0, 8000);
  check('下行命令被验签解密后交付', gotCmd && JSON.stringify(commands[0]?.body) === JSON.stringify(cmd),
        JSON.stringify(commands[0]?.body ?? null).slice(0, 50));

  const forged = { ...buildEnvelope(cmd, CIPHER), dataSign: 'f'.repeat(64) };
  await spy.publishAsync(gw.topics.command, JSON.stringify(forged), { qos: 1 });
  await sleep(1500);
  check('dataSign 不对的下行被丢弃，不交付给业务', commands.length === 1, `已交付 ${commands.length} 条`);

  // ── 子设备拓扑 ──
  /*
   * 这里用一个「假云」应答端，只验**我们这一侧**：报文结构、mid 关联、分批、
   * 逐条结果判读、超时。响应结构照云侧 TopoAddDeviceResultVO 写。
   *
   * 它证明不了云端真的这么回 —— 那要真云联调。交接文档 5.1 那条教训就是
   * 「模拟上游能验证管线，不能推断失败机制」，这里刻意不越界。
   */
  const cloudSeen = [];
  let cloudReply = null;               // (payload) => 响应 dataBody；返回 null 表示不回（测超时）
  spy.on('message', (t, p) => {
    if (!t.includes('/topo/') && !t.endsWith('/model/query')) return;
    if (t.endsWith('Response')) return;
    const { head, body } = parseEnvelopeFull(p, CIPHER);
    cloudSeen.push({ topic: t, body, mid: head.mid });
    const reply = cloudReply?.(body, t);
    if (reply === null || reply === undefined) return;
    // 关键：响应必须沿用源 mid，云侧 buildResponse(src, ...) 就是这么做的
    const respTopic = t.endsWith('/model/query')
      ? t + 'Response'
      : t.replace(/\/topo\/(\w+)$/, (_, op) => `/topo/${op}Response`);
    spy.publish(respTopic, JSON.stringify(buildEnvelope(reply, CIPHER, { mid: head.mid })), { qos: 1 });
  });

  const okItems = (n) => Array.from({ length: n }, () => ({ statusCode: TOPO_SUCCESS, statusDesc: 'success' }));

  cloudReply = (body) => ({ statusCode: TOPO_SUCCESS, statusDesc: 'success',
                            data: okItems(body.deviceInfos.length) });
  cloudSeen.length = 0;
  const reg = await gw.registerSubDevices([
    { nodeId: 'plc-1', name: '1#注塑机', model: 'S7-1200' },
    { nodeId: 'plc-2', name: '2#注塑机' },
  ]);
  check('注册子设备走通请求-响应（靠 mid 关联）', reg.ok && reg.succeeded === 2,
        JSON.stringify(reg));
  check('发到 topo/add 且带网关标识',
        cloudSeen[0]?.topic === `/v1/devices/${DEVICE}/topo/add` &&
        cloudSeen[0]?.body?.gatewayIdentification === DEVICE,
        cloudSeen[0]?.topic ?? '');
  check('子设备字段按云侧 DeviceInfos 结构',
        JSON.stringify(cloudSeen[0]?.body?.deviceInfos?.[0]) ===
        JSON.stringify({ nodeId: 'plc-1', name: '1#注塑机', model: 'S7-1200' }),
        JSON.stringify(cloudSeen[0]?.body?.deviceInfos?.[0]));

  // 分批：250 台应拆成 100 + 100 + 50 三次请求
  cloudSeen.length = 0;
  const many = Array.from({ length: 250 }, (_, i) => ({ nodeId: `n-${i}`, name: `节点 ${i}` }));
  const bulk = await gw.registerSubDevices(many);
  check('超过单批上限时自动分批且逐批串行',
        cloudSeen.length === 3 &&
        cloudSeen.map((c) => c.body.deviceInfos.length).join(',') === '100,100,50',
        cloudSeen.map((c) => c.body.deviceInfos.length).join('+'));
  check('分批后总数对得上', bulk.succeeded === 250 && bulk.ok, `${bulk.succeeded}/250`);
  check('每批 mid 各不相同', new Set(cloudSeen.map((c) => c.mid)).size === 3);

  // 部分失败：顶层 success，但 data[] 里有一条失败
  cloudSeen.length = 0;
  cloudReply = (body) => ({
    statusCode: TOPO_SUCCESS, statusDesc: 'success',
    data: body.deviceInfos.map((d, i) =>
      i === 1 ? { statusCode: TOPO_FAILURE, statusDesc: '设备已存在' }
              : { statusCode: TOPO_SUCCESS, statusDesc: 'success' }),
  });
  const partial = await gw.registerSubDevices([
    { nodeId: 'a', name: 'A' }, { nodeId: 'b', name: 'B' }, { nodeId: 'c', name: 'C' }]);
  check('顶层成功但逐条失败时不报告成功',
        partial.ok === false && partial.succeeded === 2, JSON.stringify(partial));
  check('失败条目能对回具体的 nodeId',
        partial.failed[0]?.nodeId === 'b' && partial.failed[0]?.statusDesc === '设备已存在',
        JSON.stringify(partial.failed));

  // 整批被拒（网关不存在 / nodeType 不是 GATEWAY）
  cloudReply = () => ({ statusCode: TOPO_FAILURE, statusDesc: 'failure', data: [] });
  let rejected = false;
  try { await gw.registerSubDevices([{ nodeId: 'x', name: 'X' }]); } catch { rejected = true; }
  check('整批被拒时抛错而不是静默当成功', rejected);

  // 状态更新与删除
  cloudSeen.length = 0;
  cloudReply = () => ({ statusCode: TOPO_SUCCESS, statusDesc: 'success' });
  const upd = await gw.updateSubDeviceStatus([{ deviceId: 'plc-1', status: 'ONLINE' }]);
  check('子设备状态更新走 topo/update 并收到响应',
        upd.statusCode === TOPO_SUCCESS &&
        cloudSeen.at(-1)?.topic === `/v1/devices/${DEVICE}/topo/update`,
        cloudSeen.at(-1)?.topic ?? '');
  check('状态字段是枚举名而非数字',
        cloudSeen.at(-1)?.body?.deviceStatuses?.[0]?.status === 'ONLINE',
        String(cloudSeen.at(-1)?.body?.deviceStatuses?.[0]?.status));

  const del = await gw.deleteSubDevices(['plc-2']);
  check('子设备删除走 topo/delete 并收到响应',
        del.statusCode === TOPO_SUCCESS &&
        cloudSeen.at(-1)?.topic === `/v1/devices/${DEVICE}/topo/delete`,
        cloudSeen.at(-1)?.topic ?? '');

  // 云端不回时必须超时报错，不能永远挂着
  cloudReply = () => null;
  const impatient = new CloudGateway({ brokerUrl: URL, credentials: { ...CREDS, clientId: '2130020836696064@1' },
    cipher: CIPHER, reconnectPeriodMs: 1000, requestTimeoutMs: 2000 });
  await impatient.connect();
  let timedOut = false;
  const t0 = Date.now();
  try { await impatient.registerSubDevices([{ nodeId: 'z', name: 'Z' }]); } catch (e) { timedOut = /超时/.test(e.message); }
  check('云端不响应时请求超时报错', timedOut && Date.now() - t0 < 6000, `${Date.now() - t0}ms`);
  await impatient.close();
  cloudReply = null;

  // ── 物模型同步（B6）──
  /*
   * 分片按服务切（11 号文 3.3）：每片都是结构完整的 JSON，收一片合一片。
   * 这里让假云端按 2 个服务一片返回 5 个服务，验证续拉与合并。
   */
  const ALL_SVC = ['env', 'power', 'motor', 'alarm', 'meta'].map((c) => ({
    serviceCode: c, serviceName: c,
    properties: [{ propertyCode: c + '_p', propertyName: c, datatype: 'float', unit: '°C' }],
  }));
  cloudSeen.length = 0;
  cloudReply = (body, topic) => {
    if (!topic.endsWith('/model/query')) return { statusCode: 0, statusDesc: 'success' };
    const off = body.serviceOffset ?? 0;
    const slice = ALL_SVC.slice(off, off + 2);
    return {
      statusCode: 0, statusDesc: 'success',
      productIdentification: 'TL_EDGE_GATEWAY', versionNo: '1699001299999999',
      serviceTotal: ALL_SVC.length, serviceOffset: off,
      hasMore: off + slice.length < ALL_SVC.length,
      model: { productIdentification: 'TL_EDGE_GATEWAY', productName: '边缘网关', services: slice },
    };
  };

  const fetched = await gw.fetchModel();
  check('物模型分片续拉后服务完整', fetched.model.services?.length === 5,
        `${fetched.model.services?.length} 个服务 / ${fetched.pages} 片`);
  check('分片游标按已收服务数前进',
        cloudSeen.filter((c) => c.topic.endsWith('/model/query'))
                 .map((c) => c.body.serviceOffset ?? 0).join(',') === '0,2,4',
        cloudSeen.filter((c) => c.topic.endsWith('/model/query'))
                 .map((c) => c.body.serviceOffset ?? 0).join(','));
  check('产品级字段保留，版本号带回', fetched.model.productName === '边缘网关' &&
        fetched.versionNo === '1699001299999999', fetched.versionNo ?? '');
  check('两个标识都缺省 —— 即「给我我自己的物模型」',
        cloudSeen[0]?.body?.productIdentification === undefined &&
        cloudSeen[0]?.body?.versionNo === undefined);

  // 失败状态必须抛错，不能返回半个模型
  cloudReply = () => ({ statusCode: 4, statusDesc: 'version not published' });
  let modelRejected = '';
  try { await gw.fetchModel(); } catch (e) { modelRejected = e.message; }
  check('草稿版本被挡下时抛错而不是给半个模型',
        /version not published/.test(modelRejected), modelRejected.slice(0, 40));
  cloudReply = null;

  // ── 断线自愈 ──
  states.length = 0;
  sh(['restart', NAME]);
  const back = await waitFor(async () => gw.connected, 30000, 500);
  check('broker 重启后网关自动重连', back, states.join(' → '));

  /*
   * 这里要验的是「重连之后上行恢复可用」，不是「重连后第一条必达」。
   *
   * 两端都是 clean 会话：broker 重启期间订阅者短暂掉线时发出的消息，
   * **按 MQTT 语义本就允许丢**（没有会话保持，没人订阅就没人收）。
   * 断言单条必达等于断言协议没承诺的事，只会随机翻红。
   * 补传保证由我们自己的 spool 提供（B5），不靠 broker 会话。
   */
  await waitFor(async () => spy.connected, 20000, 300);
  await spy.subscribeAsync(`/v1/devices/${DEVICE}/#`, { qos: 1 });
  const seenAfter = seen.length;
  let attempts = 0;
  const recovered = await waitFor(async () => {
    if (seen.length > seenAfter) return true;
    attempts += 1;
    await gw.publishData({ services: [{ serviceId: 'env', data: { temperature: 22, n: attempts } }] });
    return false;
  }, 20000, 1000);
  check('重连后上行恢复可用', recovered, `第 ${attempts} 次发出后收到`);

  // ── 离线时必须报错，好让上层进 spool ──
  sh(['stop', NAME]);
  await waitFor(async () => !gw.connected, 15000, 300);
  let threw = false;
  try { await gw.publishData({ x: 1 }); } catch { threw = true; }
  check('离线时发布抛错（上层据此入缓存而不是静默丢弃）', threw, `state=${gw.state}`);

  await spy.endAsync(true).catch(() => {});
  await gw.close();
  cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  if (pass !== results.length) process.exit(1);
}

main().catch(async (e) => {
  console.error('\n  验证异常：', e.message);
  cleanup();
  process.exit(1);
});
