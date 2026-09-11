import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { AuthService, AuthError, type LoginResult } from './service.ts';
import { UserRepo } from './user-repo.ts';

const fresh = () => {
  const svc = new AuthService(openDb(':memory:'));
  svc.ensureInitialUser('admin', 'initial-password');
  return svc;
};

function expectSessionLogin(result: LoginResult) {
  assert.ok('sid' in result, '这个测试场景不应要求第二因子');
  return result;
}

test('初始账号只创建一次', () => {
  const svc = new AuthService(openDb(':memory:'));
  assert.equal(svc.ensureInitialUser('admin', 'pw'), true);
  assert.equal(svc.ensureInitialUser('admin2', 'pw'), false);
});

test('初始账号被标记为必须改密', () => {
  const { user } = expectSessionLogin(fresh().login('admin', 'initial-password'));
  assert.equal(user.mustChangePassword, true);
});

test('错误口令被拒绝，且不泄漏用户是否存在', () => {
  const svc = fresh();
  assert.throws(() => svc.login('admin', 'wrong'), (e: unknown) => {
    assert.match((e as Error).message, /用户名或口令错误/);
    return true;
  });
  assert.throws(() => svc.login('nobody', 'x'), /用户名或口令错误/);
});

test('连续失败触发锁定', () => {
  const svc = fresh();
  for (let i = 0; i < 5; i++) {
    assert.throws(() => svc.login('admin', 'wrong'));
  }
  assert.throws(() => svc.login('admin', 'initial-password'), /已锁定/, '锁定期内正确口令也应被拒');
});

test('会话可解析，登出后立即失效', () => {
  const svc = fresh();
  const { sid } = expectSessionLogin(svc.login('admin', 'initial-password'));
  assert.equal(svc.resolve(sid)?.username, 'admin');
  svc.logout(sid);
  assert.equal(svc.resolve(sid), undefined);
});

test('未知或空会话不通过', () => {
  const svc = fresh();
  assert.equal(svc.resolve(undefined), undefined);
  assert.equal(svc.resolve('deadbeef'), undefined);
});

test('改密后清除必须改密标记，且旧会话被踢下线', () => {
  const svc = fresh();
  const { sid } = expectSessionLogin(svc.login('admin', 'initial-password'));
  svc.changePassword('admin', 'initial-password', 'a-much-longer-password');
  assert.equal(svc.resolve(sid), undefined, '改密后旧会话应失效');
  assert.equal(expectSessionLogin(svc.login('admin', 'a-much-longer-password')).user.mustChangePassword, false);
});

test('改密需要原口令，且新口令有长度下限', () => {
  const svc = fresh();
  assert.throws(() => svc.changePassword('admin', 'wrong', 'a-much-longer-password'), AuthError);
  assert.throws(() => svc.changePassword('admin', 'initial-password', 'short'), /至少 12 位/);
});

test('Origin 校验防跨站 WebSocket 劫持', () => {
  const allowed = ['https://edge.example.com'];
  assert.equal(AuthService.originAllowed('https://edge.example.com', allowed), true);
  assert.equal(AuthService.originAllowed('https://evil.example.com', allowed), false);
  assert.equal(AuthService.originAllowed(undefined, allowed), true, '非浏览器发起不带 Origin');
});

test('CSRF 双提交令牌比对', () => {
  assert.equal(AuthService.csrfOk('tok', 'tok'), true);
  assert.equal(AuthService.csrfOk('tok', 'other'), false);
  assert.equal(AuthService.csrfOk(undefined, 'tok'), false);
  assert.equal(AuthService.csrfOk('tok', undefined), false);
});

// ── 凭据一变，旧会话立刻作废 ─────────────────────────────

test('管理员重置口令后，那个人手上的旧会话立刻失效', () => {
  const db = openDb(':memory:');
  const svc = new AuthService(db);
  svc.ensureInitialUser('admin', 'initial-password');
  const users = new UserRepo(db);
  users.create('lineop', 'operator', 'admin');
  // 直接用仓储改口令，模拟「管理员点了重置」这条路径
  const first = users.resetPassword('lineop');
  const { sid } = expectSessionLogin(svc.login('lineop', first));
  assert.ok(svc.resolve(sid), '刚登录当然有效');

  users.resetPassword('lineop');
  assert.equal(svc.resolve(sid), undefined,
    '口令已经换了，旧会话还能用的话，重置这个动作等于没做');
});

test('revokeUser 踢掉该账号全部会话，不动别人的', () => {
  const db = openDb(':memory:');
  const svc = new AuthService(db);
  svc.ensureInitialUser('admin', 'initial-password');
  const users = new UserRepo(db);
  const pw = users.create('lineop', 'operator', 'admin');

  const a = expectSessionLogin(svc.login('lineop', pw)).sid;
  const b = expectSessionLogin(svc.login('lineop', pw)).sid;
  const other = expectSessionLogin(svc.login('admin', 'initial-password')).sid;

  assert.equal(svc.revokeUser('lineop'), 2);
  assert.equal(svc.resolve(a), undefined);
  assert.equal(svc.resolve(b), undefined);
  assert.ok(svc.resolve(other), '别人的会话不受影响');
});

// ── 登录失败计数：既不能锁死管理员，也不能无限吃内存 ──────────

test('失败计数按来源分摊 —— 别人输错不影响管理员自己登录', () => {
  const svc = fresh();
  for (let i = 0; i < 6; i += 1) {
    assert.throws(() => svc.login('admin', 'wrong', '10.0.0.9'));
  }
  // 攻击者那条路已经锁了
  assert.throws(() => svc.login('admin', 'initial-password', '10.0.0.9'),
    (e: unknown) => e instanceof AuthError && /锁定/.test((e as Error).message));
  // 管理员从自己的机器上照常登录
  assert.ok(expectSessionLogin(svc.login('admin', 'initial-password', '10.0.0.2')).sid);
});

test('锁定期内继续失败不顺延，到点即可重试', () => {
  const svc = fresh();
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    for (let i = 0; i < 5; i += 1) assert.throws(() => svc.login('admin', 'wrong', '10.0.0.9'));
    now += 4 * 60_000;
    // 锁定期内又试了一次（这正是「每隔几分钟试一次就永远锁着」的攻击方式）
    assert.throws(() => svc.login('admin', 'wrong', '10.0.0.9'));
    now += 61_000; // 距首次锁定已过 5 分钟
    assert.ok(expectSessionLogin(svc.login('admin', 'initial-password', '10.0.0.9')).sid, '锁定不该被顺延');
  } finally {
    Date.now = real;
  }
});

test('失败记录有条数上限 —— 乱填用户名不能把内存吃穿', () => {
  const svc = fresh();
  const size = () => (svc as unknown as { failures: Map<string, unknown> }).failures.size;
  for (let i = 0; i < 5000; i += 1) {
    assert.throws(() => svc.login(`ghost-${i}`, 'wrong', '10.0.0.9'));
  }
  assert.ok(size() <= 4096, `失败表应有上限，实际 ${size()}`);
});

test('过期的失败记录会被清掉，不是只靠上限兜底', () => {
  const svc = fresh();
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    assert.throws(() => svc.login('admin', 'wrong', '10.0.0.9'));
    const size = () => (svc as unknown as { failures: Map<string, unknown> }).failures.size;
    assert.equal(size(), 1);
    now += 16 * 60_000; // 超过计数窗口
    assert.throws(() => svc.login('someone-else', 'wrong', '10.0.0.8'));
    assert.equal(size(), 1, '过期那条应当已被清掉');
  } finally {
    Date.now = real;
  }
});
