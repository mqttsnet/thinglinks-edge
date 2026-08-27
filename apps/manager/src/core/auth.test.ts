import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { AuthService, AuthError } from './auth.ts';

const fresh = () => {
  const svc = new AuthService(openDb(':memory:'));
  svc.ensureInitialUser('admin', 'initial-password');
  return svc;
};

test('初始账号只创建一次', () => {
  const svc = new AuthService(openDb(':memory:'));
  assert.equal(svc.ensureInitialUser('admin', 'pw'), true);
  assert.equal(svc.ensureInitialUser('admin2', 'pw'), false);
});

test('初始账号被标记为必须改密', () => {
  const { user } = fresh().login('admin', 'initial-password');
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
  const { sid } = svc.login('admin', 'initial-password');
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
  const { sid } = svc.login('admin', 'initial-password');
  svc.changePassword('admin', 'initial-password', 'a-much-longer-password');
  assert.equal(svc.resolve(sid), undefined, '改密后旧会话应失效');
  assert.equal(svc.login('admin', 'a-much-longer-password').user.mustChangePassword, false);
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
