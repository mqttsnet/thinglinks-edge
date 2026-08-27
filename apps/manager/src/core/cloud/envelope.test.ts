import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import {
  buildEnvelope, parseEnvelope, validateEnvelope, dataSignOf, nextMid, EnvelopeError,
  type CipherParams,
} from './envelope.ts';

/*
 * 下面这些期望值不是我算的，是用 JDK 的 javax.crypto 现跑出来的 ——
 * 云侧 Hutool 的 AES 底层就是 AES/CBC/PKCS5Padding + SecretKeySpec，
 * 所以 JDK 是忠实对照物。互通对不上就是这里先红。
 */
const SIGN_KEY = 'sign-key-abc';
const TS = 1756276800000;
const AES128: CipherParams = {
  cipherFlag: 2, signKey: SIGN_KEY,
  encryptKey: '0123456789abcdef', encryptVector: 'abcdef0123456789',
};
const BODY = { services: [{ serviceId: 'env', data: { t: 21.5 } }] };

test('dataSign 与 JDK SHA-256 逐字节一致', () => {
  assert.equal(dataSignOf(TS, SIGN_KEY),
               'ed77c46a829e6f450d9a2921bf42ddd57e83f12345ec21599b86a2d09f706478');
});

test('AES-128 密文与 JDK 逐字节一致', () => {
  const env = buildEnvelope(BODY, AES128, { mid: 1, timeStamp: TS });
  assert.equal(env.dataBody,
    '91b265b2bfc5979bbe6372c6549ff72e4840e94cd07a8a17a30cd74d620954654b701ebd16d678c87814bf70a08462393720d26afdb4fad62afbc6c9ec169a81');
});

test('AES-256 按密钥字节数自动选位宽，且与 JDK 一致', () => {
  const env = buildEnvelope(BODY,
    { ...AES128, encryptKey: '0123456789abcdef0123456789abcdef' }, { mid: 1, timeStamp: TS });
  assert.equal(env.dataBody,
    'fb12d2bfa9baed3a8b45c122cd970dc0323dda2e29903b730ab854871ed087383f14720152afc767d61b2f1b77116cf54dfe2dda47fe91e6fa4e4b2245778449');
});

test('中文报文体与 JDK 一致（UTF-8 编码没有分歧）', () => {
  const env = buildEnvelope({ 名称: '一号产线' }, AES128, { mid: 1, timeStamp: TS });
  assert.equal(env.dataBody, '845bf7bad72d1fffe56d424dc99f71e9f0d18aece26555fb06325b5866e02810');
});

test('SM4 通过国标 GB/T 32907 已知答案验证', () => {
  // 标准 KAT：key = plaintext = 0123456789abcdeffedcba9876543210，密文 681edf34d206965e86b3e94f536e4246
  const kat = Buffer.from('0123456789abcdeffedcba9876543210', 'hex');
  const c = createCipheriv('sm4-ecb', kat, null);
  c.setAutoPadding(false);
  assert.equal(Buffer.concat([c.update(kat), c.final()]).toString('hex'),
               '681edf34d206965e86b3e94f536e4246');
});

test('SM4 信封可往返', () => {
  const p: CipherParams = { cipherFlag: 1, signKey: SIGN_KEY,
                            encryptKey: '0123456789abcdef', encryptVector: 'abcdef0123456789' };
  const env = buildEnvelope(BODY, p, { mid: 7, timeStamp: TS });
  assert.equal(typeof env.dataBody, 'string', '加密时 dataBody 必须是 HEX 字符串');
  assert.deepEqual(parseEnvelope(JSON.stringify(env), p), BODY);
});

test('明文时 dataBody 是对象，不是字符串', () => {
  const env = buildEnvelope(BODY, { cipherFlag: 0, signKey: SIGN_KEY }, { mid: 3, timeStamp: TS });
  assert.deepEqual(env.dataBody, BODY);
  assert.equal(env.head.cipherFlag, 0);
  assert.deepEqual(parseEnvelope(JSON.stringify(env), { cipherFlag: 0, signKey: SIGN_KEY }), BODY);
});

test('dataSign 不对时拒收', () => {
  const env = buildEnvelope(BODY, AES128, { mid: 4, timeStamp: TS });
  const tampered = JSON.stringify({ ...env, dataSign: 'deadbeef' });
  assert.throws(() => parseEnvelope(tampered, AES128), EnvelopeError);
});

test('结构校验与云侧同规则', () => {
  const ok = buildEnvelope(BODY, AES128, { mid: 1, timeStamp: TS });
  assert.ok(validateEnvelope(ok));
  assert.ok(!validateEnvelope({ ...ok, head: { ...ok.head, mid: 0 } }), 'mid 必须 > 0');
  assert.ok(!validateEnvelope({ ...ok, head: { ...ok.head, timeStamp: 0 } }), 'timeStamp 必须 > 0');
  assert.ok(!validateEnvelope({ ...ok, head: { ...ok.head, cipherFlag: 3 } }), 'cipherFlag 只能 0..2');
  assert.ok(!validateEnvelope({ ...ok, dataSign: 123 }), 'dataSign 必须是字符串');
  assert.ok(!validateEnvelope({ dataSign: 'x' }), '缺 head');
});

test('密钥长度不合规立刻报错，不静默产出对端解不开的密文', () => {
  assert.throws(() => buildEnvelope(BODY, { ...AES128, encryptKey: 'short' }, { mid: 1, timeStamp: TS }),
                /密钥必须是 16\/24\/32 字节/);
  assert.throws(() => buildEnvelope(BODY, { ...AES128, encryptVector: 'short' }, { mid: 1, timeStamp: TS }),
                /初始向量必须是 16 字节/);
  assert.throws(() => buildEnvelope(BODY, { cipherFlag: 2, signKey: SIGN_KEY }, { mid: 1, timeStamp: TS }),
                /需要 encryptKey 与 encryptVector/);
});

test('mid 单调递增且不超出 JS 安全整数', () => {
  const ids = Array.from({ length: 3000 }, () => nextMid());
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i]! > ids[i - 1]!, `第 ${i} 个 mid 没有递增`);
  assert.ok(ids.every((v) => Number.isSafeInteger(v) && v > 0));
  assert.equal(new Set(ids).size, ids.length, 'mid 不得重复');
});
