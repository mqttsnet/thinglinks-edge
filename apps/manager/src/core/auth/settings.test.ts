import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { SettingsRepo, SettingsError, DEFAULT_SETTINGS } from './settings.ts';

const fresh = () => new SettingsRepo(openDb(':memory:'));

test('默认值等于这几项写死在代码里时的常量 —— 升上来行为不变', () => {
  const s = fresh().get();
  assert.equal(s.sessionIdleMin, 480, '原来是 SESSION_IDLE_MS = 8 小时');
  assert.equal(s.loginMaxFailures, 5, '原来是 MAX_FAILURES = 5');
  assert.equal(s.loginLockMin, 5, '原来是 LOCK_MS = 5 分钟');
  assert.equal(s.require2fa, false);
  assert.equal(s.updateCheckEnabled, true);
});

test('逐字段「没传就不改」', () => {
  const repo = fresh();
  repo.save({ sessionIdleMin: 30, require2fa: true }, 'admin');
  repo.save({ loginLockMin: 15 }, 'ops');

  const s = repo.get();
  assert.equal(s.loginLockMin, 15);
  assert.equal(s.sessionIdleMin, 30, '没传的会话上限该保持原值');
  assert.equal(s.require2fa, true, '没传的开关该保持原值');
  assert.equal(s.updatedBy, 'ops');
});

test('越界一律拒绝 —— 这几项配歪了全站都登不进来', () => {
  const repo = fresh();
  // 会话 5 分钟以下：现场人员点两下就被踢出去
  assert.throws(() => repo.save({ sessionIdleMin: 4 }, 'a'), SettingsError);
  // 30 天以上：一台没锁屏的工控机等于长期敞着
  assert.throws(() => repo.save({ sessionIdleMin: 43_201 }, 'a'), SettingsError);
  // 锁定阈值低于 3 次，手滑两下就进不去
  assert.throws(() => repo.save({ loginMaxFailures: 2 }, 'a'), SettingsError);
  // 高于 20 次，限速名存实亡
  assert.throws(() => repo.save({ loginMaxFailures: 21 }, 'a'), SettingsError);
  assert.throws(() => repo.save({ loginLockMin: 0 }, 'a'), SettingsError);
  assert.throws(() => repo.save({ sessionIdleMin: 30.5 }, 'a'), /整数/);
});

test('校验失败时不留下半份设置', () => {
  const repo = fresh();
  repo.save({ sessionIdleMin: 60 }, 'admin');
  const before = repo.get();
  assert.throws(() => repo.save({ sessionIdleMin: 1 }, 'attacker'), SettingsError);
  assert.deepEqual(repo.get(), before);
});

test('DEFAULT_SETTINGS 与库里的默认行一致 —— 两处漂了会让「恢复默认」变成改设置', () => {
  const s = fresh().get();
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    assert.equal(s[k as keyof typeof DEFAULT_SETTINGS], v, `字段 ${k} 对不上`);
  }
});
