/**
 * 首次设置 —— 端到端验证。
 *
 * 这一支要证明的是三件只有对着真 HTTP 才看得出来的事：
 *
 *   1. 全新部署上 `/api/setup` 匿名可读、可写，设置完**直接带着会话进去**；
 *   2. 已认领的实例上这条路彻底堵死（否则就是一个「谁先访问谁是管理员」的洞）；
 *   3. **默认不限时**（装完机被叫走、回来还能接着设置）；只有显式配了
 *      `SETUP_WINDOW_MIN` 的部署才关窗，且关的是**写**、不是读 ——
 *      界面还得能读出「已过期」才好告诉用户去重启。
 *
 * 过期分支用一个极短的窗口（0.01 分钟）验，不靠改系统时间 ——
 * 这也是 SETUP_WINDOW_MIN 收小数的唯一理由。
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const jarOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

/** 起一台 Manager。`windowMin` 直接写进 env，注册路由时就读它 */
async function start(port, windowMin) {
  if (windowMin === undefined) delete process.env['SETUP_WINDOW_MIN'];
  else process.env['SETUP_WINDOW_MIN'] = String(windowMin);
  const dataDir = mkdtempSync(join(tmpdir(), 'tle-setup-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const key = deriveKey('verify-master', 'thinglinks-edge:instance-cred');
  const auth = new AuthService(db, key);
  const repo = new InstanceRepo(db, key);
  const docker = new DockerClient({
    network: 'n', imageRepo: 'nodered/node-red', portRange: { min: 30000, max: 30999 },
    instanceDataRoot: '/tmp', timezone: 'UTC',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'],
  });
  const app = buildServer({
    config: {
      externalUrl: `http://127.0.0.1:${port}`, basePath: '', cookieSecure: false,
      allowedOrigins: [`http://127.0.0.1:${port}`], listenAddr: '127.0.0.1', listenPort: port,
      dataDir, portRange: { min: 30000, max: 30999 }, dataRoot: '/tmp', instanceDataRoot: '/tmp',
    },
    db, auth, repo, service,
  });
  await app.listen({ host: '127.0.0.1', port });
  return { app, db, auth, B: `http://127.0.0.1:${port}` };
}

const post = (B, path, body) => fetch(`${B}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

async function main() {
  console.log('\n──── 首次设置 · 端到端验证 ────\n');

  // ── A. 正常认领 ───────────────────────────────────────
  // 不传 SETUP_WINDOW_MIN，走默认
  delete process.env['SETUP_WINDOW_MIN'];
  const a = await start(13281, undefined);

  const state0 = await (await fetch(`${a.B}/api/setup`)).json();
  check('全新部署上，未登录也读得到「需要首次设置」',
        state0.needed === true && state0.expired === false);
  check('默认不限时 —— 装完机被叫走，回来还能接着设置',
        state0.expiresInSec === 0, `expiresInSec=${state0.expiresInSec}`);

  const meBefore = await fetch(`${a.B}/api/me`);
  check('这时业务接口仍然是未登录', meBefore.status === 401, `HTTP ${meBefore.status}`);

  const short = await post(a.B, '/api/setup', { username: 'admin', password: 'short' });
  check('口令太短被拒，且与改密是同一条规则',
        short.status === 400 && /至少 12 位/.test((await short.json()).error), `HTTP ${short.status}`);

  const badName = await post(a.B, '/api/setup', { username: '1bad', password: 'my-own-password-1' });
  check('用户名不合规被拒', badName.status === 400, `HTTP ${badName.status}`);

  const stillNeeded = await (await fetch(`${a.B}/api/setup`)).json();
  check('被拒的尝试没有留下账号', stillNeeded.needed === true);

  const ok = await post(a.B, '/api/setup', { username: 'edgeadmin', password: 'my-own-password-1' });
  const okBody = await ok.json();
  const cookie = jarOf(ok);
  check('设置成功', ok.status === 200 && okBody.user.username === 'edgeadmin', `HTTP ${ok.status}`);
  check('设置完直接带上会话，不用再输一遍刚定的口令', cookie.includes('tle_sid'));
  check('口令是自己定的，就不再强制改密', okBody.user.mustChangePassword === false);

  const me = await fetch(`${a.B}/api/me`, { headers: { cookie } });
  check('这个会话是真能用的', me.status === 200, `HTTP ${me.status}`);

  const settings = await fetch(`${a.B}/api/settings`, { headers: { cookie } });
  check('而且是管理员，业务接口直接可用', settings.status === 200, `HTTP ${settings.status}`);

  // ── B. 已认领的实例：这条路必须彻底堵死 ────────────────
  const after = await (await fetch(`${a.B}/api/setup`)).json();
  check('设置完之后 needed 变回 false', after.needed === false);

  const second = await post(a.B, '/api/setup', { username: 'hacker', password: 'another-pass-123' });
  check('第二次设置一律 409，谁都别想重新认领', second.status === 409, `HTTP ${second.status}`);

  const users = a.db.prepare('SELECT COUNT(*) AS n FROM app_user').get();
  check('库里仍然只有一个账号', users.n === 1, `${users.n} 个`);

  // 口令不该出现在启动日志里 —— 这正是这次改造的出发点
  check('设置的口令不落审计', !JSON.stringify(
    a.db.prepare('SELECT * FROM audit').all()).includes('my-own-password-1'));

  await a.app.close();

  // ── C. 显式开了限时的部署（暴露到厂区网/公网时才需要）─────
  const c = await start(13282, 0.01);          // 0.6 秒，够跑完下面这几步
  const beforeExpiry = await (await fetch(`${c.B}/api/setup`)).json();
  check('配了 SETUP_WINDOW_MIN 时窗口内可以设置',
        beforeExpiry.needed === true && beforeExpiry.expired === false
        && beforeExpiry.expiresInSec >= 0);

  await new Promise((r) => setTimeout(r, 900));

  const afterState = await (await fetch(`${c.B}/api/setup`)).json();
  check('过期后**读**得到「已过期」—— 界面要靠它提示去重启',
        afterState.needed === true && afterState.expired === true);

  const tooLate = await post(c.B, '/api/setup', { username: 'hacker', password: 'another-pass-123' });
  const tooLateBody = await tooLate.json();
  check('过期后**写**被拒，并给出可执行的下一步',
        tooLate.status === 403 && tooLateBody.code === 'SETUP_WINDOW_EXPIRED'
        && /重启/.test(tooLateBody.error), `HTTP ${tooLate.status}`);

  const none = c.db.prepare('SELECT COUNT(*) AS n FROM app_user').get();
  check('过期后没有留下任何账号', none.n === 0, `${none.n} 个`);
  check('被拒的认领尝试进了审计，事后查得到有人来敲过门',
        JSON.stringify(c.db.prepare("SELECT * FROM audit WHERE action = 'setup'").all())
          .includes('认领窗口已过'));
  await c.app.close();

  // ── D. 显式写 0 与默认等价 ─────────────────────────────
  const d = await start(13283, 0);
  const unlimited = await (await fetch(`${d.B}/api/setup`)).json();
  check('显式 SETUP_WINDOW_MIN=0 与默认一样是不限时',
        unlimited.needed === true && unlimited.expired === false && unlimited.expiresInSec === 0);
  const okUnlimited = await post(d.B, '/api/setup', { username: 'admin', password: 'my-own-password-1' });
  check('不限时的实例照样能正常设置', okUnlimited.status === 200, `HTTP ${okUnlimited.status}`);
  await d.app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('  失败：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('\n[fatal]', e); process.exitCode = 1; });
