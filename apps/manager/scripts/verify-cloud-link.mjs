/**
 * 云对接**整条链路**验证 —— 配置接口 → 运行期 → 真实 broker → 断网续传。
 *
 * 与 verify-cloud-gateway.mjs 的分工：
 *   · 那一支验的是**协议这一层**（信封、签名、topic、重连重订阅）
 *   · 这一支验的是**接线这一层**：界面存进去的参数真的被用上了吗、
 *     上行真的从 ingest 走到了 broker 吗、断网时真的落了缓存吗、
 *     凭据真的没从任何一个响应里漏出去吗
 *
 * 后者是「选项 A」新加的部分，光靠单测证明不了 —— 单测里的 broker 是假的，
 * 而「参数存了却没被 apply」这种错，假 broker 一样收得到消息。
 */
import mqtt from 'mqtt';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { buildServer } from '../dist/http/app.js';
import { Spool } from '../dist/core/spool/spool.js';
import { CloudConfigRepo } from '../dist/core/cloud/config-repo.js';
import { CloudRuntime } from '../dist/core/cloud/runtime.js';
import { dataSignOf, parseEnvelopeFull } from '../dist/core/cloud/envelope.js';
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { TEST_DATA_ROOT, TEST_EDGE_ROOT, ensureRoot } from './_data-root.mjs';
import { adminSession, sessionFor } from './_session.mjs';

const IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
const NAME = 'tle-cloudlink-mqtt';
const MQTT_PORT = 13241;
const HTTP_PORT = 13242;
const BROKER = `mqtt://127.0.0.1:${MQTT_PORT}`;

const ADMIN_PW = 'initial-password-123';
const INSTANCE = 'cloudlink-a';

const DEVICE = 'edge-gw-verify';
const CLIENT_ID = '2130020836696064@1';
const MQTT_USER = 'edge-user';
const MQTT_PASS = 'edge-pass-123';
const SIGN_KEY = 'sign-key-for-verify';
const ENC_KEY = '0123456789abcdef';
const ENC_IV = 'abcdef0123456789';
/** 全部明文秘密，用于「任何响应里都不该出现」这条断言 */
const SECRETS = [MQTT_PASS, SIGN_KEY, ENC_KEY, ENC_IV];

const DATAS_TOPIC = `/v1/devices/${DEVICE}/datas`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', ...opts });
const waitFor = async (fn, ms = 20000, step = 200) => {
  for (let i = 0; i < ms / step; i++) { if (await fn()) return true; await sleep(step); }
  return false;
};

function startBroker() {
  const dir = mkdtempSync(join(tmpdir(), 'tle-mosq-link-'));
  const hashed = sh(['run', '--rm', IMAGE, 'sh', '-c',
    `mosquitto_passwd -c -b /tmp/pw ${MQTT_USER} ${MQTT_PASS} >/dev/null 2>&1 && cat /tmp/pw`]);
  writeFileSync(join(dir, 'passwd'), hashed);
  // allow_anonymous false：凭据没真的发出去就连不上，后面那些断言才有意义
  // log_type all：下面要从连接日志里读出协议版本与心跳（`(p5, c1, k60)`），
  // 那是唯一能证明这两项真的上了线的地方 —— 客户端侧怎么打印都只是自说自话
  writeFileSync(join(dir, 'mosquitto.conf'),
    'listener 1883\nallow_anonymous false\npassword_file /mosquitto/config/passwd\n'
    + 'log_type all\n');
  sh(['run', '-d', '--name', NAME, '-p', `127.0.0.1:${MQTT_PORT}:1883`,
      '-v', `${dir}/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro`,
      '-v', `${dir}/passwd:/mosquitto/config/passwd:ro`, IMAGE]);
}
const cleanup = () => { try { sh(['rm', '-f', NAME], { stdio: 'pipe' }); } catch { /* 没起过 */ } };

async function main() {
  console.log('\n──── 云对接整条链路 · 真实 broker 验证 ────\n');
  cleanup();
  console.log('  · 启动 mosquitto…');
  startBroker();

  const reachable = await waitFor(async () => {
    try {
      const c = await mqtt.connectAsync(BROKER, { username: MQTT_USER, password: MQTT_PASS });
      await c.endAsync(true); return true;
    } catch { return false; }
  });
  check('broker 就绪', reachable);
  if (!reachable) throw new Error('mosquitto 未就绪');

  // ── 起 Manager，接线方式与 index.ts 完全一致 ──────────────
  const dataDir = mkdtempSync(join(tmpdir(), 'tle-cloudlink-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const key = deriveKey('verify-master', 'thinglinks-edge:instance-cred');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, key);
  await ensureRoot();

  // 只要一条实例记录来换接入令牌，不需要真容器 —— 这一支验的是云那一侧
  repo.create(
    { id: INSTANCE, name: '链路验证实例', imageTag: '5.0.4-24-minimal',
      memLimit: 512, cpuLimit: 0.5, adminRoot: `/red/${INSTANCE}/`, credSecret: 'cs', notes: '' },
    [], [{ username: 'admin', password: 'p@ss-1', permissions: '*' }],
  );
  // 接入令牌由 InstanceService.create 生成；这里没走 service（不建真容器），
  // 所以自己补一个，否则 /api/edge/* 一律 401
  repo.setIngestToken(INSTANCE, 'verify-ingest-token-0123456789abcd');

  // 口令由 UserRepo 生成，不是我们指定的 —— 直接用它返回的那个登录
  const users = new UserRepo(db);
  const opsPassword = users.create('ops', 'operator', 'admin');

  const docker = new DockerClient({
    network: 'tle-cloudlink-net', imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'],
  });
  const config = {
    externalUrl: `http://127.0.0.1:${HTTP_PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${HTTP_PORT}`], listenAddr: '127.0.0.1',
    listenPort: HTTP_PORT, dataDir, portRange: { min: 30000, max: 30999 },
    dataRoot: TEST_EDGE_ROOT, instanceDataRoot: TEST_DATA_ROOT,
  };

  const spool = await Spool.open({
    dir: join(dataDir, 'spool'), flushIntervalMs: 5, fullPolicy: 'drop-oldest',
  });
  const cloudConfig = new CloudConfigRepo(db, key);
  const cloud = new CloudRuntime();
  await cloud.apply(cloudConfig.get());

  const app = buildServer({
    config, db, auth, repo, service, spool, cloud, cloudConfig,
    cloudSink: (payload) => cloud.publish(payload),
  });
  await app.listen({ host: '127.0.0.1', port: HTTP_PORT });
  const B = `http://127.0.0.1:${HTTP_PORT}`;

  // 先改掉初始口令：强制改密是后端闸门，不改的话后面每条业务接口都会 403
  const admin = await adminSession(B, ADMIN_PW);
  const H = { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf };
  check('管理员登录成功', Boolean(admin.csrf));

  // ── 1. 未配置状态如实呈现 ─────────────────────────────
  const before = await (await fetch(`${B}/api/cloud`, { headers: { cookie: admin.cookie } })).json();
  check('未配置时 config 为 null、状态为 unconfigured',
        before.config === null && before.status.state === 'unconfigured',
        `state=${before.status.state}`);

  const token = repo.ingestToken(INSTANCE);
  const ingest = (path, body) => fetch(`${B}/api/edge/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  await ingest('devices', { devices: [{ nodeId: 'plc-1', name: '1#注塑机', protocol: 'modbus-tcp' }] });

  const upBeforeRes = await ingest('uplink', { serviceId: 'env', nodeId: 'plc-1', data: { t: 1 } });
  const upBefore = await upBeforeRes.json();
  check('未配置云时上行如实回 not-configured，不假装已送出',
        upBefore.cloud === 'not-configured', `cloud=${upBefore.cloud}`);

  // ── 2. 非法参数当场拒绝，且不落库 ──────────────────────
  const base = {
    enabled: true, brokerUrl: BROKER, clientId: CLIENT_ID, deviceIdentification: DEVICE,
    username: MQTT_USER, password: MQTT_PASS, cipherFlag: 2,
    signKey: SIGN_KEY, encryptKey: ENC_KEY, encryptVector: ENC_IV,
  };
  const put = (body, h = H) => fetch(`${B}/api/cloud`, { method: 'PUT', headers: h, body: JSON.stringify(body) });

  const badClient = await put({ ...base, clientId: DEVICE });
  check('把设备标识误填成 clientId 会被当场拒绝',
        badClient.status === 400 && /雪花ID@租户ID/.test((await badClient.json()).error),
        `HTTP ${badClient.status}`);

  const badKey = await put({ ...base, encryptKey: 'too-short' });
  check('密钥长度不对在写库前就被拒', badKey.status === 400, `HTTP ${badKey.status}`);

  const stillEmpty = await (await fetch(`${B}/api/cloud`, { headers: { cookie: admin.cookie } })).json();
  check('被拒的保存没有留下半份配置', stillEmpty.config === null);

  // ── 3. 保存合法配置，立刻连上 ─────────────────────────
  const saved = await put(base);
  const savedBody = await saved.json();
  check('保存合法配置后立刻连上 broker',
        saved.status === 200 && savedBody.status.state === 'online',
        `HTTP ${saved.status} state=${savedBody.status.state}`);

  // ── 4. 凭据不从任何响应漏出 ───────────────────────────
  const getBody = await (await fetch(`${B}/api/cloud`, { headers: { cookie: admin.cookie } })).text();
  const putText = JSON.stringify(savedBody);
  const leaked = SECRETS.filter((s) => getBody.includes(s) || putText.includes(s));
  check('读写接口的响应里没有任何明文凭据', leaked.length === 0,
        leaked.length ? `泄漏 ${leaked.length} 项` : '4 项密文字段全部只回「是否已设置」');

  const parsed = JSON.parse(getBody);
  check('掩码版本如实标出四个密文字段都已设置',
        parsed.config.secretsSet.password && parsed.config.secretsSet.signKey
        && parsed.config.secretsSet.encryptKey && parsed.config.secretsSet.encryptVector);

  // ── 5. 上行真的到了 broker，且签名用的就是配置里那把 key ──
  const sub = await mqtt.connectAsync(BROKER, { username: MQTT_USER, password: MQTT_PASS });
  const received = [];
  sub.on('message', (topic, payload) => received.push({ topic, payload }));
  await sub.subscribeAsync(DATAS_TOPIC, { qos: 1 });

  const up = await (await ingest('uplink',
    { serviceId: 'env', nodeId: 'plc-1', data: { temperature: 21.5, humidity: 63 } })).json();
  check('上行入口收下并入批', up.cloud === 'queued', `cloud=${up.cloud}`);

  const arrived = await waitFor(() => received.length > 0, 8000);
  check('攒批后的报文真的发到了 broker', arrived, `${received.length} 条`);

  if (arrived) {
    const raw = JSON.parse(received[0].payload.toString('utf8'));
    const expectSign = dataSignOf(raw.head.timeStamp, SIGN_KEY);
    // dataSign 在信封**顶层**，不在 head 里（head 只有 cipherFlag/mid/timeStamp）
    check('dataSign 由配置里的 signKey 算出（改配置真的生效了）',
          raw.dataSign === expectSign,
          raw.dataSign === expectSign ? `${expectSign.slice(0, 16)}…` : `实际 ${raw.dataSign}`);
    check('cipherFlag=2 时 dataBody 是密文，不是明文 JSON',
          typeof raw.dataBody === 'string' && !raw.dataBody.includes('temperature'),
          typeof raw.dataBody === 'string' ? `${raw.dataBody.slice(0, 24)}…` : typeof raw.dataBody);

    const { body } = parseEnvelopeFull(received[0].payload,
      { cipherFlag: 2, signKey: SIGN_KEY, encryptKey: ENC_KEY, encryptVector: ENC_IV });
    const flat = JSON.stringify(body);
    check('第三方用同一套密钥能解出原始点位', flat.includes('21.5') && flat.includes('63'));
  }

  // ── 5.5 连接参数真的上了线（版本 / 心跳）─────────────
  /*
   * 从 mosquitto 的连接日志里读，而不是信我们自己打印的配置：
   * `New client connected from … as <id> (p5, c1, k60, u'edge-user')`
   *   p = MQTT 协议级别，直接就是 3/4/5（实测 mosquitto 2.1.2 打的是级别本身，
   *   不是老版本那个 p1/p2 的编号）· c1 = clean session · k60 = 心跳 60 秒
   * 「参数存了却没被 apply」这种错，只有对面记下来的东西能戳穿。
   */
  const connLine = (clientId) => {
    // mosquitto 把日志写到 **stderr**，而 execFileSync 只带回 stdout ——
    // 用 sh() 拿到的会是空字符串，且不报错。两个流都收才看得到东西
    const r = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' });
    const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const lines = log.split('\n').filter((l) => l.includes('New client connected')
      && l.includes(`as ${clientId}`));
    return lines[lines.length - 1] ?? '';
  };

  const defaultLine = connLine(CLIENT_ID);
  check('默认以 MQTT 5.0 连上，心跳 60 秒（与可配之前写死的值一致）',
        /\(p5, c1, k60/.test(defaultLine), defaultLine.slice(-46) || '(日志里没找到连接行)');

  // 换成 3.1.1 + 心跳 30：只传 connection，其余字段一个都不带
  const switched = await put({ ...base, connection: { mqttVersion: 4, keepaliveSec: 30 } });
  const switchedBody = await switched.json();
  check('切到 MQTT 3.1.1 + 心跳 30 后仍能连上',
        switchedBody.status.state === 'online', `state=${switchedBody.status.state}`);
  await waitFor(() => /\(p4, c1, k30/.test(connLine(CLIENT_ID)), 8000);
  check('broker 记下的就是 3.1.1 与 30 秒 —— 参数真的到了线上',
        /\(p4, c1, k30/.test(connLine(CLIENT_ID)), connLine(CLIENT_ID).slice(-46));

  check('掩码版本回传的连接参数与提交的一致',
        switchedBody.config.connection.mqttVersion === 4
        && switchedBody.config.connection.keepaliveSec === 30,
        JSON.stringify(switchedBody.config.connection));

  // 只改 QoS，不带 connection：上面换过的版本与心跳都不该被退回默认
  const qosOnly = await put({ ...base, qos: 2 });
  const qosOnlyBody = await qosOnly.json();
  check('不带 connection 的保存不会把版本与心跳退回默认',
        qosOnlyBody.config.connection.mqttVersion === 4
        && qosOnlyBody.config.connection.keepaliveSec === 30,
        JSON.stringify(qosOnlyBody.config.connection));

  const badKeepalive = await put({ ...base, connection: { keepaliveSec: 99999 } });
  check('越界的心跳在保存阶段就被拒（不是等 broker 拒连）',
        badKeepalive.status === 400, `HTTP ${badKeepalive.status}`);

  // 后面几节按默认参数继续，别让 3.1.1 带进断网续传那一段
  await put(base);
  await waitFor(async () => cloud.state === 'online', 10000);

  // ── 6. 断网落缓存，恢复后补传 ─────────────────────────
  received.length = 0;
  sh(['stop', NAME], { stdio: 'pipe' });
  const wentOffline = await waitFor(async () => cloud.state !== 'online', 15000);
  check('broker 停掉后运行期状态变为非 online', wentOffline, `state=${cloud.state}`);

  await ingest('uplink', { serviceId: 'env', nodeId: 'plc-1', data: { temperature: 99.9 } });
  const spooled = await waitFor(async () => (await spool.metrics()).pending > 0, 8000);
  const m = await spool.metrics();
  check('断网期间的数据落进断网缓存，没有丢', spooled, `缓存 ${m.pending} 条`);

  sh(['start', NAME], { stdio: 'pipe' });
  const backOnline = await waitFor(async () => cloud.state === 'online', 40000);
  check('broker 恢复后自动重连', backOnline, `state=${cloud.state}`);

  if (backOnline) {
    // 补传搭在「成功发送之后」，所以再打一条实时数据把它带出来
    await ingest('uplink', { serviceId: 'env', nodeId: 'plc-1', data: { temperature: 22.1 } });
    const drained = await waitFor(async () => (await spool.metrics()).pending === 0, 20000);
    check('积压在缓存里的数据被补传完毕', drained,
          `剩余 ${(await spool.metrics()).pending} 条`);
    check('补传的数据也真的到了 broker', received.length >= 2, `${received.length} 条`);
  }

  // ── 7. 权限：运维能看不能改 ───────────────────────────
  // 运维同样要先完成强制改密：不走这一步，「角色不够」和「没改密」会混成同一个 403
  const ops = await sessionFor(B, 'ops', opsPassword);
  const opsGet = await fetch(`${B}/api/cloud`, { headers: { cookie: ops.cookie } });
  check('运维可以查看云连接状态', opsGet.status === 200, `HTTP ${opsGet.status}`);
  const opsPut = await put(base,
    { cookie: ops.cookie, 'content-type': 'application/json', 'x-csrf-token': ops.csrf });
  check('运维改不了接入凭据（signKey 一改全站上行失效）',
        opsPut.status === 403, `HTTP ${opsPut.status}`);

  // ── 8. 解除对接后凭据从库里消失 ───────────────────────
  const del = await fetch(`${B}/api/cloud`, { method: 'DELETE', headers: H });
  check('解除对接接口返回成功', del.status === 200, `HTTP ${del.status}`);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM cloud_config').get();
  check('解除后配置行已删除，凭据不再留在库里', rows.n === 0, `剩 ${rows.n} 行`);
  check('解除后运行期回到未配置', cloud.state === 'unconfigured', `state=${cloud.state}`);

  await sub.endAsync(true);
  await cloud.close();
  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('  失败：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('\n[fatal]', e); process.exitCode = 1; })
  .finally(cleanup);
