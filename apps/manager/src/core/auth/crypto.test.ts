import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKey, requireMasterKey, hashPassword, verifyPassword,
  encryptSecret, decryptSecret, generatePassword, CryptoError,
} from './crypto.ts';

const KEY = deriveKey('master-abc', 'salt-1');

test('生产环境缺 MASTER_KEY 拒绝启动，且说明原因', () => {
  assert.throws(() => requireMasterKey({ NODE_ENV: 'production' }), (e: unknown) => {
    assert.ok(e instanceof CryptoError);
    assert.match((e as Error).message, /拒绝启动/);
    assert.match((e as Error).message, /不得与数据库同备份/);
    return true;
  });
});

test('提供 MASTER_KEY 时正常取用；开发环境才允许回落', () => {
  assert.equal(requireMasterKey({ NODE_ENV: 'production', MASTER_KEY: 'k' }), 'k');
  assert.equal(requireMasterKey({}), 'dev-only-insecure-key');
});

test('管理面口令：同一口令每次哈希不同（含随机 salt），但都能校验通过', () => {
  const a = hashPassword('p@ss');
  const b = hashPassword('p@ss');
  assert.notEqual(a.hash, b.hash);
  assert.ok(verifyPassword('p@ss', a));
  assert.ok(verifyPassword('p@ss', b));
});

test('错误口令与被篡改的哈希都不通过', () => {
  const h = hashPassword('right');
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('right', { hash: 'zz', salt: h.salt }), false);
  assert.equal(verifyPassword('right', { ...h, salt: 'other' }), false);
});

test('实例凭据可逆：加密后能解回原文', () => {
  const plain = '一号产线-口令-!@#$';
  assert.equal(decryptSecret(encryptSecret(plain, KEY), KEY), plain);
});

test('相同明文两次加密的密文不同（随机 IV）', () => {
  assert.notEqual(encryptSecret('same', KEY), encryptSecret('same', KEY));
});

test('换密钥解密失败，而不是静默返回错误明文', () => {
  const packed = encryptSecret('secret', KEY);
  assert.throws(() => decryptSecret(packed, deriveKey('other', 'salt-1')), CryptoError);
});

test('密文被篡改时 GCM 校验失败', () => {
  const packed = encryptSecret('secret', KEY);
  const [iv, tag, data] = packed.split('.');
  const flipped = Buffer.from(data!, 'base64');
  flipped[0] = flipped[0]! ^ 0xff;
  assert.throws(() => decryptSecret(`${iv}.${tag}.${flipped.toString('base64')}`, KEY), CryptoError);
});

test('密文格式非法时报错', () => {
  assert.throws(() => decryptSecret('abc', KEY), CryptoError);
  assert.throws(() => decryptSecret('a.b', KEY), CryptoError);
});

test('生成的口令足够长且 URL 安全', () => {
  const p = generatePassword();
  assert.ok(p.length >= 20);
  assert.match(p, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(p, generatePassword());
});
