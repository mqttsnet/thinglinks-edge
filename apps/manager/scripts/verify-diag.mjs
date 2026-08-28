/**
 * 远程诊断端到端验证（T4.5）。
 *
 * 验收标准原文是「导出后 `grep` 检索包内无凭据」——所以这里**真的导出一个包、
 * 真的 grep**，而不是断言某个函数返回了什么。单测里那套是白盒，
 * 这一支要证明的是「从 HTTP 口子拿到手的那个字节流」干净。
 *
 * 秘密来源覆盖三类，每一类都是现实中真会漏的地方：
 *   · MASTER_KEY —— 进程环境变量里，最致命
 *   · 实例接入令牌与 Node-RED 口令 —— 加密入库，但日志与接口回显里可能有明文
 *   · 云侧 signKey / encryptKey / 口令 —— 同上
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { untar } from '../dist/core/archive/tar.js';
import { TEST_DATA_ROOT, TEST_EDGE_ROOT, ensureRoot } from './_data-root.mjs';
import { adminSession, sessionFor } from './_session.mjs';

const PORT = 13262;
const ADMIN_PW = 'initial-password-123';
const INSTANCE = 'diag-a';

// ── 全部明文秘密。包里出现任意一个即判失败 ──────────────
const MASTER_KEY = 'master-key-for-diag-verify-0123456789';
const INGEST_TOKEN = 'ingest-token-for-diag-verify-abcdef';
const NR_PASSWORD = 'nodered-password-diag-verify';
const CLOUD_PASSWORD = 'cloud-password-diag-verify';
const SIGN_KEY = 'sign-key-diag-verify-must-not-leak';
const ENC_KEY = '0123456789abcdef';
const ENC_IV = 'fedcba9876543210';
const SECRETS = {
  MASTER_KEY, INGEST_TOKEN, NR_PASSWORD, CLOUD_PASSWORD, SIGN_KEY, ENC_KEY, ENC_IV,
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

async function main() {
  console.log('\n──── 远程诊断 · 导出后真 grep 验证 ────\n');

  process.env['MASTER_KEY'] = MASTER_KEY;
  const dataDir = mkdtempSync(join(tmpdir(), 'tle-diag-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const key = deriveKey(MASTER_KEY, 'thinglinks-edge:instance-cred');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, key);
  await ensureRoot();

  // 一条实例记录，带真实的接入令牌与 Node-RED 口令
  repo.create(
    { id: INSTANCE, name: '诊断验证实例', imageTag: '5.0.4-24-minimal',
      memLimit: 512, cpuLimit: 0.5, adminRoot: `/red/${INSTANCE}/`, credSecret: 'cs', notes: '' },
    [], [{ username: 'admin', password: NR_PASSWORD, permissions: '*' }],
  );
  repo.setIngestToken(INSTANCE, INGEST_TOKEN);

  const users = new UserRepo(db);
  const opsPassword = users.create('ops', 'operator', 'admin');
  const viewerPassword = users.create('watcher', 'viewer', 'admin');

  const docker = new DockerClient({
    network: 'tle-diag-net', imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'],
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT,
    dataDir, dataRoot: TEST_EDGE_ROOT, instanceDataRoot: TEST_DATA_ROOT,
    portRange: { min: 30000, max: 30999 }, timezone: 'Asia/Shanghai', updateCheckUrl: '',
  };

  const spool = await Spool.open({ dir: join(dataDir, 'spool'), flushIntervalMs: 5, fullPolicy: 'drop-oldest' });
  const cloudConfig = new CloudConfigRepo(db, key);
  // 存一份真实的云配置，让 signKey / encryptKey / 口令确实在库里
  cloudConfig.save({
    enabled: false,                       // 不真连，这一支验的是诊断不是链路
    brokerUrl: 'mqtts://broker.example.com:8883',
    clientId: '2130020836696064@1',
    deviceIdentification: 'diag-gw-01',
    username: 'diag-user',
    password: CLOUD_PASSWORD,
    cipherFlag: 2,
    signKey: SIGN_KEY, encryptKey: ENC_KEY, encryptVector: ENC_IV,
  }, 'admin');

  const cloud = new CloudRuntime();
  await cloud.apply(cloudConfig.get());

  const app = buildServer({
    config, db, auth, repo, service, spool, cloud, cloudConfig,
    cloudSink: (p) => cloud.publish(p),
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  const B = `http://127.0.0.1:${PORT}`;

  const loginAs = async (username, password) => {
    const r = await fetch(`${B}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { cookie, csrf: /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '' };
  };
  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  // 先改掉初始口令：强制改密是后端闸门，不改的话后面每条业务接口都会 403
  const admin = await adminSession(B, ADMIN_PW);
  check('管理员登录成功', Boolean(admin.csrf));

  // ── 1. 导出诊断包 ─────────────────────────────────
  const res = await fetch(`${B}/api/diag/bundle`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({}),
  });
  check('诊断包导出成功', res.status === 200, `HTTP ${res.status}`);
  const archive = Buffer.from(await res.arrayBuffer());
  check('返回的是 tar 且非空', archive.length > 1024, `${archive.length} 字节`);

  const file = join(dataDir, 'diag.tar');
  writeFileSync(file, archive);

  // ── 2. 验收标准：真 grep ──────────────────────────
  const raw = readFileSync(file);
  const asText = raw.toString('utf8');
  const leaked = Object.entries(SECRETS).filter(([, v]) => asText.includes(v));
  check('包内 grep 不到任何明文凭据', leaked.length === 0,
        leaked.length ? `泄漏 ${leaked.map(([k]) => k).join('、')}` : `${Object.keys(SECRETS).length} 项全部未出现`);

  // 用二进制方式再扫一遍：文本转换可能吃掉某些字节序列
  const binLeak = Object.entries(SECRETS).filter(([, v]) => raw.includes(Buffer.from(v, 'utf8')));
  check('按字节扫描同样干净（不依赖文本解码）', binLeak.length === 0,
        binLeak.length ? `泄漏 ${binLeak.map(([k]) => k).join('、')}` : '');

  // ── 3. 包结构 ─────────────────────────────────────
  const files = untar(archive);
  const names = files.map((f) => f.name);
  check('清单排在包首位', names[0] === 'manifest.json', names[0]);

  const manifest = JSON.parse(String(files[0].content));
  check('清单列出的文件与包内实际一致',
        manifest.files.every((f) => names.includes(f)) && manifest.files.length === names.length,
        `${manifest.files.length} 个`);
  check('清单记录了导出人', manifest.generatedBy === 'admin', manifest.generatedBy);

  for (const want of ['config.json', 'runtime.json', 'instances.json', 'cloud.json',
                      'network.json', 'clock.json', 'audit.json']) {
    check(`包含 ${want}`, names.includes(want));
  }
  /*
   * 日志要么收上来了，要么在清单里如实记了失败 —— 两者必居其一。
   * 这一支不起真容器，所以正常路径就是「记了失败」。
   * 断言成「必须有日志」是错的：那会把「诚实地报告收不到」判成 bug。
   */
  const logNames = names.filter((n) => n.startsWith('logs/'));
  const logFailures = manifest.failures.filter((f) => f.item.startsWith('logs:'));
  check('实例日志要么收上来、要么在清单里记了失败',
        logNames.length > 0 || logFailures.length > 0,
        logNames.length ? logNames.join(' ') : `记录了 ${logFailures.length} 项收集失败`);
  check('收集失败必须带原因，不能只说失败',
        logFailures.every((f) => typeof f.error === 'string' && f.error.length > 0),
        logFailures[0]?.error ?? '无失败项');

  // ── 4. 脱敏没有把有用信息一起抹掉 ──────────────────
  const cfg = String(files.find((f) => f.name === 'config.json').content);
  check('配置里非敏感字段保留', cfg.includes('externalUrl') && cfg.includes('19100') === false
        && cfg.includes(`${PORT}`), '端口与外部地址仍可读');

  const runtime = String(files.find((f) => f.name === 'runtime.json').content);
  check('环境变量只报名字不报值', runtime.includes('MASTER_KEY') && !runtime.includes(MASTER_KEY),
        '键名在、值不在');

  const inst = String(files.find((f) => f.name === 'instances.json').content);
  check('实例台账保留 id 与名称', inst.includes(INSTANCE) && inst.includes('诊断验证实例'));

  const cloudFile = String(files.find((f) => f.name === 'cloud.json').content);
  check('云配置只留非敏感项', cloudFile.includes('broker.example.com') || cloudFile.includes('state'),
        '链路状态可读');

  // ── 5. 权限 ───────────────────────────────────────
  // 一次性口令同样带 must_change_pwd，不改密的话这里会因为「没改密」被 403，
  // 而断言想验的是「运维角色够不够」—— 两种 403 混在一起，断言就白写了
  const ops = await sessionFor(B, 'ops', opsPassword);
  const opsRes = await fetch(`${B}/api/diag/bundle`, { method: 'POST', headers: H(ops), body: '{}' });
  check('运维可以导诊断包（现场第一响应人）', opsRes.status === 200, `HTTP ${opsRes.status}`);

  const viewer = await sessionFor(B, 'watcher', viewerPassword);
  const viewerRes = await fetch(`${B}/api/diag/bundle`, { method: 'POST', headers: H(viewer), body: '{}' });
  check('只读用户导不了诊断包', viewerRes.status === 403, `HTTP ${viewerRes.status}`);

  const noCsrf = await fetch(`${B}/api/diag/bundle`, {
    method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: '{}',
  });
  check('缺 CSRF 令牌被拒', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

  const anon = await fetch(`${B}/api/diag/bundle`, { method: 'POST' });
  check('未登录被拒', anon.status === 401, `HTTP ${anon.status}`);

  // ── 6. 单次探测 ───────────────────────────────────
  const probe = await fetch(`${B}/api/diag/probe`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ targets: [`127.0.0.1:${PORT}`], timeoutMs: 3000 }),
  });
  const probeBody = await probe.json();
  check('探测自身端口可达', probe.status === 200 && probeBody.probes[0]?.tcp?.ok === true,
        probeBody.probes?.[0]?.summary ?? `HTTP ${probe.status}`);
  check('探测结果带时钟信息', Boolean(probeBody.clock?.timezone), probeBody.clock?.timezone);
  check('探测结果注明「可达」的局限', /误报/.test(probeBody.note ?? ''));

  /*
   * 契约断言：控制台「远程诊断」页逐个读这些字段。
   * 少一个不会让接口报错，只会让页面上那一格空着 —— 这种缺失很难被发现，
   * 所以把整个形状钉住，而不是只挑几个抽查。
   */
  const P0 = probeBody.probes[0] ?? {};
  const missP = ['target', 'dns', 'tcp', 'summary'].filter((k) => P0[k] === undefined);
  const missDns = ['host', 'ok', 'addresses', 'elapsedMs'].filter((k) => P0.dns?.[k] === undefined);
  const missTcp = ['host', 'port', 'ok', 'elapsedMs'].filter((k) => P0.tcp?.[k] === undefined);
  check('探测结果的字段与控制台契约一致',
        missP.length === 0 && missDns.length === 0 && missTcp.length === 0,
        [...missP, ...missDns.map((k) => `dns.${k}`), ...missTcp.map((k) => `tcp.${k}`)]
          .join('、') || 'target dns{host,ok,addresses,elapsedMs} tcp{host,port,ok,elapsedMs} summary');

  const missClock = ['localTime', 'timezone', 'uptimeSec', 'ok', 'note']
    .filter((k) => probeBody.clock?.[k] === undefined);
  check('时钟结果的字段与控制台契约一致', missClock.length === 0,
        missClock.join('、') || 'localTime timezone uptimeSec ok note');

  /*
   * 「解析失败时 tcp 为 null」这条**不在这里验**，在 core/diag/probe.test.ts。
   *
   * 试过在这里用一个不存在的域名触发，结果它在本机解析成了 198.18.1.149 并连通 ——
   * fake-IP 模式的代理会把任意域名映射到保留段。也就是说**没有哪个域名能保证
   * 在任意机器上解析失败**，这条断言放在真实 DNS 上必然飘。
   * 单测里 stub 掉解析器才是确定的。
   *
   * 顺带一提：这次意外正好实证了上面 note 里那句「透明代理会让可达误报成功」。
   */

  const closed = await fetch(`${B}/api/diag/probe`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ targets: ['127.0.0.1:1'], timeoutMs: 2000 }),
  });
  const closedBody = await closed.json();
  check('探测关闭端口如实报不可达', closedBody.probes[0]?.tcp?.ok === false,
        closedBody.probes?.[0]?.summary);

  // ── 7. 审计 ───────────────────────────────────────
  const audits = db.prepare("SELECT actor, action, result FROM audit WHERE action LIKE 'diag-%' ORDER BY id").all();
  check('导包动作进审计', audits.some((a) => a.action === 'diag-bundle' && a.actor === 'admin'));
  check('运维导包也进审计', audits.some((a) => a.action === 'diag-bundle' && a.actor === 'ops'));
  check('探测动作进审计', audits.some((a) => a.action === 'diag-probe'),
        `共 ${audits.length} 条诊断审计`);
  check('被拒的探测记为 fail', audits.some((a) => a.action === 'diag-probe' && a.result === 'fail'));

  // ── 8. 审计本身也在包里，且脱敏过 ──────────────────
  const res2 = await fetch(`${B}/api/diag/bundle`, { method: 'POST', headers: H(admin), body: '{}' });
  const archive2 = Buffer.from(await res2.arrayBuffer());
  const audit2 = String(untar(archive2).find((f) => f.name === 'audit.json').content);
  check('包里的审计含刚才的诊断动作', audit2.includes('diag-bundle'));
  check('第二次导出同样不含凭据',
        !Object.values(SECRETS).some((v) => archive2.toString('utf8').includes(v)));

  await cloud.close();
  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('  失败：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('\n[fatal]', e); process.exitCode = 1; });
