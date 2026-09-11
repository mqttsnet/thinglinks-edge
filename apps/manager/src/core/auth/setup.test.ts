/**
 * 首次设置的规则测试。
 *
 * 「窗口过期」那条在 HTTP 层（scripts/verify-2fa.mjs 之外另有端到端），
 * 这里只钉仓储侧那几条：什么时候算未认领、口令与用户名的规则、
 * 以及设置完之后**不**再强制改密。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { AuthService, AuthError } from './service.ts';
import { UserRepo } from './user-repo.ts';

const fresh = () => {
  const db = openDb(':memory:');
  return { db, auth: new AuthService(db), users: new UserRepo(db) };
};

test('全新库需要首次设置', () => {
  assert.equal(fresh().auth.needsSetup(), true);
});

test('设置完就不再需要，且能直接用自己定的口令登录', () => {
  const { auth } = fresh();
  auth.createFirstAdmin('admin', 'my-own-password-1');
  assert.equal(auth.needsSetup(), false);

  const r = auth.login('admin', 'my-own-password-1');
  assert.ok('sid' in r);
  assert.equal(r.user.role, 'admin');
});

test('口令是自己定的，就不该再逼一次改密', () => {
  const { auth } = fresh();
  auth.createFirstAdmin('admin', 'my-own-password-1');
  const r = auth.login('admin', 'my-own-password-1');
  assert.ok('sid' in r);
  assert.equal(r.user.mustChangePassword, false);
});

test('已经有账号时一律拒绝 —— 这条路不是用来「重新认领」的', () => {
  const { auth } = fresh();
  auth.createFirstAdmin('admin', 'my-own-password-1');
  assert.throws(() => auth.createFirstAdmin('admin2', 'another-password-1'), AuthError);
});

test('库里只剩一个非 admin 账号时，也不算未认领', () => {
  const { db, auth } = fresh();
  /*
   * 直接插一条 operator 来构造这个状态 —— 产品里删不掉用户（只停用，
   * 见 v3 迁移的说明），但恢复了一份残缺备份、或有人手改过库时会出现。
   *
   * 判据必须是「一个用户都没有」而不是「没有 admin」：否则这种库会被
   * 当成全新设备，谁都能重新认领成管理员。那种情况该走 reset-admin。
   */
  db.prepare(
    `INSERT INTO app_user (username, pwd_hash, pwd_salt, role, must_change_pwd)
     VALUES ('lineop', 'x', 'y', 'operator', 0)`,
  ).run();
  assert.equal(auth.needsSetup(), false, '还有账号在，就不能被重新认领');
  assert.throws(() => auth.createFirstAdmin('admin', 'my-own-password-1'), AuthError);
});

test('口令长度与改密那条是同一个下限', () => {
  const { auth } = fresh();
  assert.throws(() => auth.createFirstAdmin('admin', 'short'), /至少 12 位/);
  // 恰好 12 位要能过
  auth.createFirstAdmin('admin', 'exactly12chr');
  assert.equal(auth.needsSetup(), false);
});

test('用户名沿用与新建用户相同的规则', () => {
  for (const bad of ['ab', '1admin', 'admin!', 'a'.repeat(33)]) {
    const { auth } = fresh();
    assert.throws(() => auth.createFirstAdmin(bad, 'my-own-password-1'),
      /用户名/, `应当拒绝：${bad}`);
  }
  const { auth } = fresh();
  auth.createFirstAdmin('edge.admin-1', 'my-own-password-1');
  assert.equal(auth.needsSetup(), false);
});

test('设置出来的就是管理员，不是别的角色', () => {
  const { auth, users } = fresh();
  auth.createFirstAdmin('boss', 'my-own-password-1');
  assert.equal(users.get('boss')?.role, 'admin');
});
