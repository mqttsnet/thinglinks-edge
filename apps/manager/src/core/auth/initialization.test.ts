import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../db.ts';
import { AuthService } from './service.ts';
import { initializeAdministrator } from './initialization.ts';

test('服务器密码模式在没有密码或密码过短时拒绝匿名初始化', () => {
  for (const password of ['', 'short']) {
    const db = openDb(':memory:');
    try {
      const auth = new AuthService(db);
      assert.throws(() => initializeAdministrator(auth, {
        ADMIN_SETUP_MODE: 'password', INITIAL_PASSWORD: password,
      }), /密码|口令/);
      assert.equal(auth.needsSetup(), true);
    } finally { db.close(); }
  }
});

test('配置自选密码后首次启动就有管理员，登录不再要求重复改密', () => {
  const db = openDb(':memory:');
  try {
    const auth = new AuthService(db);
    initializeAdministrator(auth, { ADMIN_SETUP_MODE: 'password', INITIAL_PASSWORD: 'chosen-fixture-password' });
    assert.equal(auth.needsSetup(), false);
    const result = auth.login('admin', 'chosen-fixture-password');
    assert.ok('sid' in result);
    assert.equal(result.user.mustChangePassword, false);
  } finally { db.close(); }
});

test('升级有用户的部署不需要初始密码，也不会覆盖管理员口令', () => {
  const db = openDb(':memory:');
  try {
    const auth = new AuthService(db);
    auth.createFirstAdmin('owner', 'existing-fixture-password');
    assert.equal(initializeAdministrator(auth, { ADMIN_SETUP_MODE: 'password' }), 'existing');
    assert.equal(initializeAdministrator(auth, { ADMIN_SETUP_MODE: 'password', INITIAL_PASSWORD: 'different-fixture-password' }), 'existing');
    assert.ok('sid' in auth.login('owner', 'existing-fixture-password'));
    assert.throws(() => auth.login('admin', 'different-fixture-password'));
  } finally { db.close(); }
});

test('Compose 的直接密码值保留特殊字符，旧 INITIAL_PASSWORD 仍优先', () => {
  const db = openDb(':memory:');
  try {
    const auth = new AuthService(db);
    const password = 'fixture}-$-#-:-password';
    initializeAdministrator(auth, { ADMIN_SETUP_MODE: 'password', COMPOSE_INITIAL_PASSWORD: password });
    assert.ok('sid' in auth.login('admin', password));
  } finally { db.close(); }
  const legacyDb = openDb(':memory:');
  try {
    const auth = new AuthService(legacyDb);
    initializeAdministrator(auth, {
      ADMIN_SETUP_MODE: 'password', INITIAL_PASSWORD: 'environment-fixture-password',
      COMPOSE_INITIAL_PASSWORD: 'compose-fixture-password',
    });
    assert.ok('sid' in auth.login('admin', 'environment-fixture-password'));
  } finally { legacyDb.close(); }
});

test('旧的浏览器设置与初始口令强制改密契约继续可用，非法模式拒绝', () => {
  const db = openDb(':memory:');
  try {
    const auth = new AuthService(db);
    assert.equal(initializeAdministrator(auth, {}), 'browser');
    assert.throws(() => initializeAdministrator(auth, { ADMIN_SETUP_MODE: 'typo' }), /ADMIN_SETUP_MODE/);
    initializeAdministrator(auth, { INITIAL_PASSWORD: 'legacy-fixture-password' });
    const result = auth.login('admin', 'legacy-fixture-password');
    assert.ok('sid' in result);
    assert.equal(result.user.mustChangePassword, true);
  } finally { db.close(); }
});
