/**
 * 云对接 **TLS 这一层**的验证 —— 证书真的被用上了吗。
 *
 * 与另外两支的分工：
 *   · verify-cloud-gateway.mjs 验协议层（信封、签名、topic、重连重订阅）
 *   · verify-cloud-link.mjs    验接线层（界面存的参数有没有被 apply、断网有没有落缓存）
 *   · 这一支验**传输层**：CA 传上去之后握手到底认不认、关掉校验是不是真的放行、
 *     双向认证缺了客户端证书是不是真的连不上
 *
 * 为什么单测证不了：单测里的 broker 是假的，`ca`/`cert`/`key` 这几个字段
 * 塞没塞进 mqtt.js 都不影响结果。**只有真的 TLS 握手会拒绝**。
 * 而「证书配了但没生效」恰恰是最危险的一种错 —— 界面显示加密、实际没验身份。
 */
import mqtt from 'mqtt';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { buildServer } from '../dist/http/app.js';
import { CloudConfigRepo } from '../dist/core/cloud/config-repo.js';
import { CloudRuntime } from '../dist/core/cloud/runtime.js';
import { TEST_DATA_ROOT, TEST_EDGE_ROOT, ensureRoot } from './_data-root.mjs';
import { adminSession } from './_session.mjs';

const IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
const NAME = 'tle-cloudtls-mqtt';
/** 只验服务端身份的监听口 */
const PORT_SRV = 13251;
/** require_certificate true，逼着客户端也出示证书 */
const PORT_MUTUAL = 13252;
const HTTP_PORT = 13253;

const ADMIN_PW = 'initial-password-123';
const DEVICE = 'edge-gw-tls';
const CLIENT_ID = '2130020836696064@1';
const MQTT_USER = 'edge-user';
const MQTT_PASS = 'edge-pass-123';
const SIGN_KEY = 'sign-key-for-tls-verify';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', ...opts });
const ssl = (args, cwd) => execFileSync('openssl', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const waitFor = async (fn, ms = 20000, step = 200) => {
  for (let i = 0; i < ms / step; i++) { if (await fn()) return true; await sleep(step); }
  return false;
};

/**
 * 现造一套证书。
 *
 * 服务端证书签给 **localhost**，而后面有一条用例是拿 `127.0.0.1` 去连 ——
 * 主机名对不上正是 SNI 那个字段存在的理由，不造出这个差异就验不了它。
 */
function makeCerts(dir) {
  const ec = (out) => ssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', out], dir);
  ec('ca.key');
  ssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '2', '-subj',
       '/CN=ThingLinks Edge Verify CA', '-out', 'ca.crt'], dir);

  // 服务端：CN + SAN 都是 localhost
  ec('server.key');
  ssl(['req', '-new', '-key', 'server.key', '-subj', '/CN=localhost', '-out', 'server.csr'], dir);
  writeFileSync(join(dir, 'san.cnf'), 'subjectAltName=DNS:localhost\n');
  ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
       '-CAcreateserial', '-days', '2', '-sha256', '-extfile', 'san.cnf', '-out', 'server.crt'], dir);

  // 客户端：双向认证用
  ec('client.key');
  ssl(['req', '-new', '-key', 'client.key', '-subj', `/CN=${DEVICE}`, '-out', 'client.csr'], dir);
  ssl(['x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
       '-CAcreateserial', '-days', '2', '-sha256', '-out', 'client.crt'], dir);
  ssl(['pkcs8', '-topk8', '-nocrypt', '-in', 'client.key', '-out', 'client.p8'], dir);

  // 另一套完全无关的 CA 与私钥，用来验「CA 不对」和「证书与私钥不配对」
  ec('rogue.key');
  ssl(['req', '-x509', '-new', '-key', 'rogue.key', '-sha256', '-days', '2', '-subj',
       '/CN=Rogue CA', '-out', 'rogue.crt'], dir);
  ssl(['pkcs8', '-topk8', '-nocrypt', '-in', 'rogue.key', '-out', 'rogue.p8'], dir);

  // mosquitto 以非 root 跑，读不到 0600 的私钥就会静默不监听
  for (const f of ['server.key', 'ca.crt', 'server.crt']) chmodSync(join(dir, f), 0o644);

  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return {
    ca: read('ca.crt'), clientCert: read('client.crt'), clientKey: read('client.p8'),
    rogueCa: read('rogue.crt'), rogueKey: read('rogue.p8'),
  };
}

function startBroker(dir) {
  const hashed = sh(['run', '--rm', IMAGE, 'sh', '-c',
    `mosquitto_passwd -c -b /tmp/pw ${MQTT_USER} ${MQTT_PASS} >/dev/null 2>&1 && cat /tmp/pw`]);
  writeFileSync(join(dir, 'passwd'), hashed);
  chmodSync(join(dir, 'passwd'), 0o644);

  const common = [
    'allow_anonymous false',
    'password_file /mosquitto/config/passwd',
    'cafile /mosquitto/config/ca.crt',
    'certfile /mosquitto/config/server.crt',
    'keyfile /mosquitto/config/server.key',
  ];
  writeFileSync(join(dir, 'mosquitto.conf'), [
    'listener 8883', ...common, 'require_certificate false', '',
    // 这个口要求客户端也出示由同一 CA 签发的证书
    'listener 8884', ...common, 'require_certificate true', '',
  ].join('\n'));
  chmodSync(join(dir, 'mosquitto.conf'), 0o644);

  sh(['run', '-d', '--name', NAME,
      '-p', `127.0.0.1:${PORT_SRV}:8883`, '-p', `127.0.0.1:${PORT_MUTUAL}:8884`,
      '-v', `${dir}/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro`,
      '-v', `${dir}/passwd:/mosquitto/config/passwd:ro`,
      '-v', `${dir}/ca.crt:/mosquitto/config/ca.crt:ro`,
      '-v', `${dir}/server.crt:/mosquitto/config/server.crt:ro`,
      '-v', `${dir}/server.key:/mosquitto/config/server.key:ro`,
      IMAGE]);
}
const cleanup = () => { try { sh(['rm', '-f', NAME], { stdio: 'pipe' }); } catch { /* 没起过 */ } };

async function main() {
  console.log('\n──── 云对接 TLS · 真实证书握手验证 ────\n');
  cleanup();
  const certDir = mkdtempSync(join(tmpdir(), 'tle-tls-certs-'));
  console.log('  · 生成证书…');
  const C = makeCerts(certDir);
  console.log('  · 启动 mosquitto（TLS）…');
  startBroker(certDir);

  const reachable = await waitFor(async () => {
    try {
      const c = await mqtt.connectAsync(`mqtts://localhost:${PORT_SRV}`,
        { username: MQTT_USER, password: MQTT_PASS, ca: C.ca });
      await c.endAsync(true); return true;
    } catch { return false; }
  });
  check('TLS broker 就绪', reachable);
  if (!reachable) throw new Error('mosquitto TLS 未就绪');

  // ── 起 Manager，接线方式与 index.ts 一致 ──────────────
  const dataDir = mkdtempSync(join(tmpdir(), 'tle-cloudtls-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const key = deriveKey('verify-master', 'thinglinks-edge:instance-cred');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, key);
  await ensureRoot();

  const docker = new DockerClient({
    network: 'tle-cloudtls-net', imageRepo: 'nodered/node-red',
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

  const cloudConfig = new CloudConfigRepo(db, key);
  const cloud = new CloudRuntime();
  const app = buildServer({ config, db, auth, repo, service, cloud, cloudConfig });
  await app.listen({ host: '127.0.0.1', port: HTTP_PORT });
  const B = `http://127.0.0.1:${HTTP_PORT}`;

  const sess = await adminSession(B, ADMIN_PW);
  const { cookie, csrf } = sess;
  const H = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
  check('管理员登录并完成首次改密', sess.ok, `HTTP ${sess.status}`);

  const base = {
    enabled: true, clientId: CLIENT_ID, deviceIdentification: DEVICE,
    username: MQTT_USER, password: MQTT_PASS, cipherFlag: 0, signKey: SIGN_KEY,
  };
  /**
   * 存一份配置，回「保存后稳定下来的状态」。连不上不是错误，是这支脚本要断言的结果。
   *
   * `rejectUnauthorized` 默认补成 true：TLS 字段是「没传就不改」的语义，
   * 不补的话上一条用例关掉的校验会一路带到下一条，后面几条就全都白测了
   * —— 写这支脚本时正是先踩了这个坑，才把默认值补在这里。
   */
  const save = async (over) => {
    const tls = over.tls ? { rejectUnauthorized: true, ...over.tls } : undefined;
    const r = await fetch(`${B}/api/cloud`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ ...base, ...over, ...(tls ? { tls } : {}) }),
    });
    const body = await r.json();
    return { http: r.status, state: body.status?.state, error: body.error, body };
  };
  const URL_SRV = `mqtts://localhost:${PORT_SRV}`;
  const URL_MUTUAL = `mqtts://localhost:${PORT_MUTUAL}`;

  // ── 1. 自签证书在系统根证书下必须连不上 ────────────────
  const sys = await save({ brokerUrl: URL_SRV, tls: { mode: 'system' } });
  check('自签平台证书 + 系统根证书 → 连不上（校验真的在做）',
        sys.http === 200 && sys.state !== 'online', `state=${sys.state}`);
  const sysStatus = await (await fetch(`${B}/api/cloud`, { headers: { cookie } })).json();
  check('连不上的原因如实落到 lastError，而不是只说 offline',
        /certificate|self.signed|unable to verify/i.test(sysStatus.status.lastError || ''),
        sysStatus.status.lastError?.slice(0, 60) || '(空)');

  // ── 2. 传入正确的 CA 就能连上 ─────────────────────────
  const withCa = await save({ brokerUrl: URL_SRV, tls: { mode: 'ca', ca: C.ca } });
  check('传入正确的 CA 后握手通过', withCa.state === 'online', `state=${withCa.state}`);

  // ── 3. CA 不对必须连不上 ──────────────────────────────
  const wrongCa = await save({ brokerUrl: URL_SRV, tls: { mode: 'ca', ca: C.rogueCa } });
  check('换成无关的 CA 立刻连不上（不是谁的 CA 都认）',
        wrongCa.state !== 'online', `state=${wrongCa.state}`);

  // ── 4. 关掉校验：加密照旧，身份不认 ───────────────────
  const noVerify = await save({
    brokerUrl: URL_SRV, tls: { mode: 'system', rejectUnauthorized: false } });
  check('关掉证书校验后连得上 —— 这正是它危险的地方',
        noVerify.state === 'online', `state=${noVerify.state}`);
  check('状态里如实标着「没在校验证书」',
        noVerify.body.status.secure === true && noVerify.body.status.rejectUnauthorized === false);

  const audit = db.prepare(
    "SELECT detail FROM audit WHERE action = 'cloud-config' ORDER BY id DESC LIMIT 1").get();
  check('关闭校验这件事进了审计，事后查得到', /已关闭证书校验/.test(audit?.detail ?? ''),
        (audit?.detail ?? '').slice(0, 70));

  // tls 里只传一部分字段时，没传的沿用旧值 —— 上面那条关掉的校验必须还关着
  const partial = await fetch(`${B}/api/cloud`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ ...base, brokerUrl: URL_SRV, tls: { servername: '' } }),
  });
  const partialBody = await partial.json();
  check('tls 里只传一部分字段时，没传的沿用旧值（校验仍是关着的）',
        partialBody.config?.tls.rejectUnauthorized === false,
        `rejectUnauthorized=${partialBody.config?.tls.rejectUnauthorized}`);

  // ── 5. 主机名对不上 → SNI 才是解法 ────────────────────
  const byIp = await save({
    brokerUrl: `mqtts://127.0.0.1:${PORT_SRV}`, tls: { mode: 'ca', ca: C.ca } });
  check('证书签给 localhost、却用 IP 连 → 主机名不匹配，连不上',
        byIp.state !== 'online', `state=${byIp.state}`);
  const withSni = await save({
    brokerUrl: `mqtts://127.0.0.1:${PORT_SRV}`,
    tls: { mode: 'ca', ca: C.ca, servername: 'localhost' } });
  check('补上 SNI 主机名后连上（SNI 字段真的透传到了 node:tls）',
        withSni.state === 'online', `state=${withSni.state}`);

  // ── 6. 双向认证 ───────────────────────────────────────
  const noClientCert = await save({ brokerUrl: URL_MUTUAL, tls: { mode: 'ca', ca: C.ca } });
  check('要求双向认证的端口上，不出示客户端证书连不上',
        noClientCert.state !== 'online', `state=${noClientCert.state}`);
  const mutual = await save({
    brokerUrl: URL_MUTUAL,
    tls: { mode: 'mutual', ca: C.ca, cert: C.clientCert, key: C.clientKey } });
  check('出示客户端证书与私钥后连上（双向认证成立）',
        mutual.state === 'online', `state=${mutual.state}`);

  // ── 7. 保存阶段就该拦下来的错 ─────────────────────────
  const mismatch = await save({
    brokerUrl: URL_MUTUAL,
    tls: { mode: 'mutual', ca: C.ca, cert: C.clientCert, key: C.rogueKey } });
  check('客户端证书与私钥不配对，在保存阶段就被拒（不是等握手失败）',
        mismatch.http === 400 && /不是一对/.test(mismatch.error ?? ''),
        `HTTP ${mismatch.http}`);

  const plainWithCert = await save({
    brokerUrl: `mqtt://localhost:${PORT_SRV}`, tls: { mode: 'ca', ca: C.ca } });
  check('明文地址配证书被拒，免得界面显示加密而链路是明文',
        plainWithCert.http === 400 && /明文协议/.test(plainWithCert.error ?? ''),
        `HTTP ${plainWithCert.http}`);

  const junk = await save({ brokerUrl: URL_SRV, tls: { mode: 'ca', ca: '随手粘的一段' } });
  check('不是 PEM 的内容被拒，并指出该是什么形态',
        junk.http === 400 && /BEGIN CERTIFICATE/.test(junk.error ?? ''), `HTTP ${junk.http}`);

  // ── 8. 私钥不从任何响应漏出 ───────────────────────────
  await save({ brokerUrl: URL_MUTUAL,
    tls: { mode: 'mutual', ca: C.ca, cert: C.clientCert, key: C.clientKey } });
  const getText = await (await fetch(`${B}/api/cloud`, { headers: { cookie } })).text();
  const keyBody = C.clientKey.split('\n').filter((l) => !l.includes('-----')).join('');
  check('读接口的响应里没有客户端私钥',
        !getText.includes(keyBody) && !getText.includes('PRIVATE KEY'));
  check('证书只回摘要，不回整份 PEM',
        !getText.includes('BEGIN CERTIFICATE') && getText.includes('fingerprint'));
  const red = JSON.parse(getText).config;
  check('摘要里能看出这张证书是不是本机要的那张',
        red.tls.cert?.subject?.includes(DEVICE) === true && red.secretsSet.tlsKey === true,
        red.tls.cert?.subject ?? '(无)');

  // ── 9. 只改别的字段不该动证书 ─────────────────────────
  const onlyQos = await fetch(`${B}/api/cloud`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ ...base, brokerUrl: URL_MUTUAL, qos: 2 }),   // 整块不带 tls
  });
  const onlyQosBody = await onlyQos.json();
  check('不带 tls 字段的保存不会把证书悄悄清空，连接照旧',
        onlyQosBody.config?.tls.mode === 'mutual' && onlyQosBody.status.state === 'online',
        `mode=${onlyQosBody.config?.tls.mode} state=${onlyQosBody.status.state}`);

  // ── 10. 解除对接后私钥从库里消失 ──────────────────────
  await fetch(`${B}/api/cloud`, { method: 'DELETE', headers: H });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM cloud_config').get();
  check('解除对接后配置行已删除，客户端私钥不再留在库里', rows.n === 0, `剩 ${rows.n} 行`);

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
