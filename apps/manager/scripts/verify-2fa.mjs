/**
 * 系统设置与两步验证 —— 端到端验证。
 *
 * 单测证不了的那部分：**Cookie 到底发没发**。
 * 两步验证成立与否，全在「口令这一步不下发会话」这一件事上 ——
 * 只要那时 Set-Cookie 出去了，第二步验不验都无所谓，拿着 Cookie 直接调接口就行。
 * 这只有对着真 HTTP 才看得出来，assert 一个函数返回值是看不出来的。
 *
 * 同样只有在这一层才验得了的：强制开启后没绑的人**具体被卡在哪些接口**、
 * 绑定那几条路由有没有被同一道闸误伤（那会变成死循环）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { buildServer } from '../dist/http/app.js';
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { codeAt, stepAt } from '../dist/core/auth/totp.js';

const PORT = 13271;
const ADMIN_PW = 'initial-password-123';
const NEW_PW = 'verify-admin-pass-01';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const jarOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const csrfOf = (cookie) => /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';

async function main() {
  console.log('\n──── 系统设置与两步验证 · 端到端验证 ────\n');

  const dataDir = mkdtempSync(join(tmpdir(), 'tle-2fa-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const key = deriveKey('verify-master', 'thinglinks-edge:instance-cred');
  const auth = new AuthService(db, key);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const users = new UserRepo(db);
  const repo = new InstanceRepo(db, key);
  const docker = new DockerClient({
    network: 'tle-2fa-net', imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: '/tmp', timezone: 'UTC',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'],
  });
  const app = buildServer({
    config: {
      externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
      allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT,
      dataDir, portRange: { min: 30000, max: 30999 }, dataRoot: '/tmp', instanceDataRoot: '/tmp',
    },
    db, auth, repo, service,
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  const B = `http://127.0.0.1:${PORT}`;

  const post = (path, body, cookie = '', csrf = '') => fetch(`${B}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  // ── 准备：管理员登录并完成首次改密 ────────────────────
  let res = await post('/api/login', { username: 'admin', password: ADMIN_PW });
  let cookie = jarOf(res);
  await post('/api/change-password', { oldPassword: ADMIN_PW, newPassword: NEW_PW },
             cookie, csrfOf(cookie));
  res = await post('/api/login', { username: 'admin', password: NEW_PW });
  cookie = jarOf(res);
  let csrf = csrfOf(cookie);
  const H = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
  check('管理员登录并完成首次改密', res.status === 200 && Boolean(csrf));

  // ── 1. 设置：读得到、越界被拒、改完立刻生效 ────────────
  const s0 = await (await fetch(`${B}/api/settings`, { headers: { cookie } })).json();
  check('设置读得到，默认值即原先写死的那组',
        s0.settings.sessionIdleMin === 480 && s0.settings.loginMaxFailures === 5
        && s0.settings.require2fa === false,
        `会话${s0.settings.sessionIdleMin}分 锁定${s0.settings.loginMaxFailures}次`);
  check('响应带服务端时间，界面据此算时钟偏差', typeof s0.serverTime === 'string'
        && Math.abs(Date.now() - new Date(s0.serverTime).getTime()) < 60_000);

  const putSettings = (body, h = H) =>
    fetch(`${B}/api/settings`, { method: 'PUT', headers: h, body: JSON.stringify(body) });

  const badSetting = await putSettings({ sessionIdleMin: 1 });
  check('越界的会话上限被拒（1 分钟会让人点两下就被踢出去）',
        badSetting.status === 400, `HTTP ${badSetting.status}`);

  await putSettings({ loginMaxFailures: 3 });
  const s1 = await (await fetch(`${B}/api/settings`, { headers: { cookie } })).json();
  check('改完立刻生效，不需要重启', s1.settings.loginMaxFailures === 3);
  check('只传一个字段时其余不动', s1.settings.sessionIdleMin === 480);
  await putSettings({ loginMaxFailures: 5 });

  // ── 2. 运维只读设置，改不了 ───────────────────────────
  const opsPw = users.create('ops', 'operator', 'admin');
  let opsRes = await post('/api/login', { username: 'ops', password: opsPw });
  let opsCookie = jarOf(opsRes);
  await post('/api/change-password', { oldPassword: opsPw, newPassword: 'ops-verify-pass-01' },
             opsCookie, csrfOf(opsCookie));
  opsRes = await post('/api/login', { username: 'ops', password: 'ops-verify-pass-01' });
  opsCookie = jarOf(opsRes);
  const opsH = { cookie: opsCookie, 'content-type': 'application/json', 'x-csrf-token': csrfOf(opsCookie) };

  const opsGet = await fetch(`${B}/api/settings`, { headers: { cookie: opsCookie } });
  const opsBody = await opsGet.json();
  check('运维看得到设置（不然「怎么被退出登录了」没处查）',
        opsGet.status === 200 && opsBody.canManage === false, `HTTP ${opsGet.status}`);
  const opsPut = await putSettings({ sessionIdleMin: 30 }, opsH);
  check('运维改不了安全策略', opsPut.status === 403, `HTTP ${opsPut.status}`);

  // ── 3. 绑定两步验证 ───────────────────────────────────
  const setup = await (await post('/api/me/totp/setup', {}, cookie, csrf)).json();
  check('取密钥这一步不启用 —— 扫码失败的人不该被关在门外',
        typeof setup.secret === 'string' && setup.otpauth.startsWith('otpauth://totp/'),
        setup.grouped?.slice(0, 14));

  const stillOneStep = await post('/api/login', { username: 'admin', password: NEW_PW });
  const stillBody = await stillOneStep.json();
  check('未确认前登录仍是一步到位', stillBody.mfa === undefined && Boolean(stillBody.user));

  const badConfirm = await post('/api/me/totp/confirm', { code: '000000' }, cookie, csrf);
  check('确认时验证码不对就不启用', badConfirm.status === 400, `HTTP ${badConfirm.status}`);

  const confirm = await (await post(
    '/api/me/totp/confirm', { code: codeAt(setup.secret, stepAt()) }, cookie, csrf)).json();
  check('确认绑定后一次性返回 10 条恢复码',
        Array.isArray(confirm.codes) && confirm.codes.length === 10);

  // ── 4. 核心：口令这一步**不发 Cookie** ────────────────
  const step1 = await post('/api/login', { username: 'admin', password: NEW_PW });
  const step1Body = await step1.json();
  const step1Cookies = step1.headers.getSetCookie?.() ?? [];
  check('开了两步验证后，口令这一步只回票据', step1Body.mfa === true && Boolean(step1Body.ticket));
  check('口令这一步一个 Cookie 都不下发（两步验证成立的前提）',
        step1Cookies.length === 0, `实际下发 ${step1Cookies.length} 个`);

  const ticketProbe = await fetch(`${B}/api/settings`, { headers: { cookie: `tle_sid=${step1Body.ticket}` } });
  check('票据当 sid 用也进不去', ticketProbe.status === 401, `HTTP ${ticketProbe.status}`);

  // 绑定那一步用掉了当前时间步，重放保护会挡住同一个码 —— 取下一步的
  const nextCode = codeAt(setup.secret, stepAt() + 1);
  const step2 = await post('/api/login/2fa', { ticket: step1Body.ticket, code: nextCode });
  const step2Cookie = jarOf(step2);
  check('验过第二因子才拿到会话', step2.status === 200 && step2Cookie.includes('tle_sid'));

  const replay = await post('/api/login/2fa', { ticket: step1Body.ticket, code: nextCode });
  check('票据一次性，换过会话就作废', replay.status === 401, `HTTP ${replay.status}`);

  const wrongCode = await post('/api/login', { username: 'admin', password: NEW_PW });
  const wrongBody = await wrongCode.json();
  const bad2fa = await post('/api/login/2fa', { ticket: wrongBody.ticket, code: '000000' });
  check('验证码不对拿不到会话', bad2fa.status === 401
        && (bad2fa.headers.getSetCookie?.() ?? []).length === 0);

  // ── 5. 恢复码能顶替验证码 ─────────────────────────────
  const recov = await post('/api/login', { username: 'admin', password: NEW_PW });
  const recovBody = await recov.json();
  const byCode = await post('/api/login/2fa', { ticket: recovBody.ticket, code: confirm.codes[0] });
  const recovCookie = jarOf(byCode);
  check('恢复码能顶替验证码登录', byCode.status === 200 && recovCookie.includes('tle_sid'));

  const status = await (await fetch(`${B}/api/me/totp`, { headers: { cookie: recovCookie } })).json();
  check('用掉一条就少一条', status.recoveryLeft === 9, `剩 ${status.recoveryLeft} 条`);

  // 之后统一用这个新会话
  cookie = recovCookie;
  csrf = csrfOf(cookie);
  const H2 = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };

  // ── 6. 强制全员开启：没绑的人被卡在哪里 ───────────────
  await fetch(`${B}/api/settings`, {
    method: 'PUT', headers: H2, body: JSON.stringify({ require2fa: true }),
  });

  const opsAfter = await post('/api/login', { username: 'ops', password: 'ops-verify-pass-01' });
  const opsAfterBody = await opsAfter.json();
  const opsAfterCookie = jarOf(opsAfter);
  check('没绑的人照样发会话（绑定本身需要一个已登录身份）',
        opsAfter.status === 200 && opsAfterBody.user.mustEnroll2fa === true);

  const blocked = await fetch(`${B}/api/instances`, { headers: { cookie: opsAfterCookie } });
  const blockedBody = await blocked.json();
  check('但业务接口一律 403，并说清原因',
        blocked.status === 403 && blockedBody.code === 'TOTP_ENROLL_REQUIRED',
        `HTTP ${blocked.status} ${blockedBody.code ?? ''}`);

  const allowed = await post('/api/me/totp/setup', {}, opsAfterCookie, csrfOf(opsAfterCookie));
  const opsSetup = await allowed.json();
  check('绑定那几条路由必须放行，否则就是死循环', allowed.status === 200, `HTTP ${allowed.status}`);

  const settingsOpen = await fetch(`${B}/api/settings`, { headers: { cookie: opsAfterCookie } });
  check('设置页也要放行（绑定入口就在那儿）', settingsOpen.status === 200);

  // ── 7. 强制开启时不许自行解绑；管理员能强制解绑 ────────
  const selfOff = await fetch(`${B}/api/me/totp`, {
    method: 'DELETE', headers: H2, body: JSON.stringify({ password: NEW_PW }),
  });
  check('全站强制时不许自行关闭', selfOff.status === 400, `HTTP ${selfOff.status}`);

  const forceReset = await post('/api/users/admin/totp/reset', {}, cookie, csrf);
  check('管理员能强制解绑（手机丢了、恢复码也没了时的唯一出路）',
        forceReset.status === 204, `HTTP ${forceReset.status}`);

  const afterReset = await fetch(`${B}/api/settings`, { headers: { cookie } });
  check('强制解绑会踢掉那个人的全部会话', afterReset.status === 401, `HTTP ${afterReset.status}`);

  // ── 8. 密钥与恢复码不落明文 ───────────────────────────
  const row = db.prepare('SELECT totp_secret_enc FROM app_user WHERE username = ?').get('ops');
  check('TOTP 密钥密文入库，直接读表看不到刚才那串密钥',
        row.totp_secret_enc.length > 0 && !row.totp_secret_enc.includes(opsSetup.secret),
        `${row.totp_secret_enc.slice(0, 24)}…`);
  const codesDump = JSON.stringify(db.prepare('SELECT * FROM recovery_code').all());
  check('恢复码只存哈希，表里搜不到明文',
        confirm.codes.every((c) => !codesDump.includes(c.replace(/-/g, ''))));

  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('  失败：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('\n[fatal]', e); process.exitCode = 1; });
