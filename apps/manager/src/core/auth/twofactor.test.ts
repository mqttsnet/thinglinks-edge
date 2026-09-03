/**
 * 两步验证的状态机测试。
 *
 * TOTP 算法本身在 totp.test.ts 里对着 RFC 向量验过；这里只钉「流程」：
 * 什么时候不发会话、票据能不能重放、恢复码用掉之后还能不能再用、
 * 强制开启之后没绑的人被卡在哪一步。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { deriveKey } from './crypto.ts';
import { AuthService, AuthError } from './service.ts';
import { SettingsRepo } from './settings.ts';
import { UserRepo } from './user-repo.ts';
import { codeAt, stepAt } from './totp.ts';

const KEY = deriveKey('test-master', 'salt');
const PW = 'initial-password-123';

function fresh() {
  const db = openDb(':memory:');
  const auth = new AuthService(db, KEY);
  auth.ensureInitialUser('admin', PW);
  return { db, auth, settings: new SettingsRepo(db), users: new UserRepo(db) };
}

/** 走完一遍绑定，返回密钥与恢复码 */
function enroll(auth: AuthService, username = 'admin') {
  const { secret } = auth.beginTotpEnroll(username);
  const codes = auth.confirmTotpEnroll(username, codeAt(secret, stepAt()));
  return { secret, codes };
}

/**
 * 下一个时间步的码。
 *
 * 绑定那一次已经用掉了**当前**这一步，重放保护会挡住它 —— 这是有意的行为
 * （同一个码不能用两次），代价是刚绑完就退出重登的人得等 30 秒。
 * 测试里直接取下一步的码，等价于「30 秒后再登录」。
 */
const nextCode = (secret: string) => codeAt(secret, stepAt() + 1);

function hasEncryptedTotpSecret(row: unknown): row is { totp_secret_enc: string } {
  return typeof row === 'object'
    && row !== null
    && 'totp_secret_enc' in row
    && typeof row.totp_secret_enc === 'string';
}

test('没绑两步验证时，登录一步到位', () => {
  const { auth } = fresh();
  const r = auth.login('admin', PW);
  assert.ok('sid' in r, '不该要求第二因子');
  assert.equal(r.user.totpEnabled, false);
});

test('绑定分两步：取密钥那一刻还没启用，验过码才启用', () => {
  const { auth } = fresh();
  const { secret } = auth.beginTotpEnroll('admin');

  // 关键：还没确认之前，登录仍然一步到位 ——
  // 否则扫码失败的人当场把自己关在门外
  const before = auth.login('admin', PW);
  assert.ok('sid' in before, '未确认的绑定不该拦住登录');

  auth.confirmTotpEnroll('admin', codeAt(secret, stepAt()));
  const after = auth.login('admin', PW);
  assert.ok('mfa' in after, '确认之后就该要第二因子了');
});

test('确认绑定要验码，码不对不启用', () => {
  const { auth } = fresh();
  auth.beginTotpEnroll('admin');
  assert.throws(() => auth.confirmTotpEnroll('admin', '000000'), AuthError);
  assert.ok('sid' in auth.login('admin', PW), '失败的确认不该启用');
});

test('开了两步验证后，口令这一步**不发会话**，只发票据', () => {
  const { auth } = fresh();
  const { secret } = enroll(auth);
  const r = auth.login('admin', PW);
  assert.ok('mfa' in r);
  // 票据不是会话：拿它当 sid 解析不出任何人
  assert.equal(auth.resolve((r as { ticket: string }).ticket), undefined);

  const done = auth.verifySecondFactor(r.ticket, nextCode(secret));
  assert.ok(auth.resolve(done.sid), '验过第二因子才拿得到会话');
  assert.equal(done.user.totpEnabled, true);
});

test('票据一次性：换过会话就不能再换', () => {
  const { auth } = fresh();
  const { secret } = enroll(auth);
  const r = auth.login('admin', PW);
  assert.ok('mfa' in r);
  auth.verifySecondFactor(r.ticket, nextCode(secret));
  assert.throws(
    () => auth.verifySecondFactor(r.ticket, nextCode(secret)),
    /超时|重新登录/,
  );
});

test('同一个验证码不能用两次 —— 截到就重放的口子要堵上', () => {
  const { auth } = fresh();
  const { secret } = enroll(auth);
  const code = nextCode(secret);

  const first = auth.login('admin', PW);
  assert.ok('mfa' in first);
  auth.verifySecondFactor(first.ticket, code);

  const second = auth.login('admin', PW);
  assert.ok('mfa' in second);
  assert.throws(() => auth.verifySecondFactor(second.ticket, code), /验证码不正确/);
});

test('恢复码能顶替验证码，且用一条少一条', () => {
  const { auth } = fresh();
  const { codes } = enroll(auth);
  assert.equal(codes.length, 10);
  assert.equal(auth.recoveryCodesLeft('admin'), 10);

  const r = auth.login('admin', PW);
  assert.ok('mfa' in r);
  const done = auth.verifySecondFactor(r.ticket, codes[0]!);
  assert.ok(auth.resolve(done.sid));
  assert.equal(auth.recoveryCodesLeft('admin'), 9);
});

test('用过的恢复码作废', () => {
  const { auth } = fresh();
  const { codes } = enroll(auth);
  const r1 = auth.login('admin', PW);
  assert.ok('mfa' in r1);
  auth.verifySecondFactor(r1.ticket, codes[0]!);

  const r2 = auth.login('admin', PW);
  assert.ok('mfa' in r2);
  assert.throws(() => auth.verifySecondFactor(r2.ticket, codes[0]!), /验证码不正确/);
});

test('第二因子失败计入登录限速 —— 六位数字不能给人无限次试', () => {
  const { auth, settings } = fresh();
  enroll(auth);
  settings.save({ loginMaxFailures: 3 }, 'admin');

  for (let i = 0; i < 3; i += 1) {
    const r = auth.login('admin', PW);
    assert.ok('mfa' in r);
    assert.throws(() => auth.verifySecondFactor(r.ticket, '000000', '1.2.3.4'), AuthError);
  }
  assert.throws(() => auth.login('admin', PW, '1.2.3.4'), /已锁定/);
});

test('解绑要口令，光有会话不够', () => {
  const { auth } = fresh();
  enroll(auth);
  assert.throws(() => auth.disableTotp('admin', 'wrong-password'), /口令不正确/);
  auth.disableTotp('admin', PW);
  assert.ok('sid' in auth.login('admin', PW), '解绑后应恢复一步登录');
  assert.equal(auth.recoveryCodesLeft('admin'), 0, '恢复码要一并清掉');
});

test('全站强制开启时不许自行解绑', () => {
  const { auth, settings } = fresh();
  enroll(auth);
  settings.save({ require2fa: true }, 'admin');
  assert.throws(() => auth.disableTotp('admin', PW), /不能自行解绑/);
});

test('管理员强制解绑：手机丢了、恢复码也没了的唯一出路', () => {
  const { auth } = fresh();
  enroll(auth);
  auth.clearTotp('admin');
  assert.ok('sid' in auth.login('admin', PW));
});

test('强制两步验证：没绑的人照样发会话，但被标记为待绑定', () => {
  const { auth, settings } = fresh();
  settings.save({ require2fa: true }, 'admin');

  // 不发会话是做不到的 —— 绑定本身就需要一个已登录的身份
  const r = auth.login('admin', PW);
  assert.ok('sid' in r);
  assert.equal(r.user.mustEnroll2fa, true);
  assert.equal(auth.resolve(r.sid)?.mustEnroll2fa, true);
});

test('绑定完成后待绑定标记自动消失，无需重新登录', () => {
  const { auth, settings } = fresh();
  settings.save({ require2fa: true }, 'admin');
  const r = auth.login('admin', PW);
  assert.ok('sid' in r);

  enroll(auth);
  assert.equal(auth.resolve(r.sid)?.mustEnroll2fa, false);
});

test('管理员打开强制开关后，在线且没绑的人下一个请求就被标记', () => {
  const { auth, settings } = fresh();
  const r = auth.login('admin', PW);
  assert.ok('sid' in r);
  assert.equal(auth.resolve(r.sid)?.mustEnroll2fa, false);

  settings.save({ require2fa: true }, 'admin');
  assert.equal(auth.resolve(r.sid)?.mustEnroll2fa, true, '设置要立刻生效，不能等重新登录');
});

test('密钥密文入库，直接读表看不到明文', () => {
  const { db, auth } = fresh();
  const { secret } = enroll(auth);
  const row = db.prepare('SELECT totp_secret_enc FROM app_user WHERE username = ?').get('admin');
  assert.ok(hasEncryptedTotpSecret(row), '管理员的两步验证密钥应已加密入库');
  assert.ok(row.totp_secret_enc.length > 0);
  assert.ok(!row.totp_secret_enc.includes(secret), '表里出现了明文密钥');
});

test('恢复码只存哈希，表里搜不到明文', () => {
  const { db, auth } = fresh();
  const { codes } = enroll(auth);
  const dump = JSON.stringify(db.prepare('SELECT * FROM recovery_code').all());
  for (const c of codes) {
    assert.ok(!dump.includes(c.replace(/-/g, '')), `表里出现了明文恢复码 ${c}`);
  }
});

test('没有主密钥的装配一律拒绝启用两步验证，而不是明文存密钥', () => {
  const db = openDb(':memory:');
  const auth = new AuthService(db);      // 不给 key
  auth.ensureInitialUser('admin', PW);
  assert.throws(() => auth.beginTotpEnroll('admin'), /主密钥/);
});

test('停用的账号在第二步也进不来', () => {
  const { auth, users } = fresh();
  // 拿一个 operator 来试：admin 是最后一个管理员，仓储那边不许停用它（那条护栏是对的）
  const pw = users.create('lineop', 'operator', 'admin');
  const { secret } = enroll(auth, 'lineop');

  const r = auth.login('lineop', pw);
  assert.ok('mfa' in r);
  users.setDisabled('lineop', true);
  assert.throws(() => auth.verifySecondFactor(r.ticket, nextCode(secret)), AuthError);
});
