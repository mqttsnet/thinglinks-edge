import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, codeAt, verifyTotp, generateSecret, otpauthUrl,
  generateRecoveryCodes, hashRecoveryCode, normalizeRecovery, stepAt,
  STEP_SECONDS, TotpError,
} from './totp.ts';

// RFC 4648 §10 的测试向量。Base32 自己实现就必须对着规范验，
// 错一位不会报错，只会让所有验证码都对不上
test('Base32 编解码符合 RFC 4648 向量', () => {
  const vectors: [string, string][] = [
    ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded, `编码 ${plain}`);
    assert.equal(base32Decode(encoded).toString(), plain, `解码 ${encoded}`);
  }
});

test('解码时容忍空格、连字符、小写与补位 —— 用户粘过来的形态五花八门', () => {
  assert.equal(base32Decode('mzxw 6ytb-oi==').toString(), 'foobar');
});

test('非 Base32 字符当场报错，而不是解出一段错的密钥', () => {
  assert.throws(() => base32Decode('MZXW6YTB01'), TotpError);   // 0 和 1 不在字母表里
});

// 空密钥的拦截放在 codeAt 而不是编解码里：HMAC 接受空密钥并照常算出六位数字，
// 没绑定的账号就会有一个「看起来合法」的码。编解码本身对空串就该回空
test('空密钥算不出验证码', () => {
  assert.equal(base32Decode('').length, 0);
  assert.throws(() => codeAt('', 1), TotpError);
  assert.equal(verifyTotp('', '000000').ok, false);
});

/*
 * RFC 6238 附录 B 的官方向量。密钥是 ASCII "12345678901234567890"，
 * 对应 Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ。
 * 这一条是整个模块的地基：它过了，说明计数器字节序、动态截断、取模全对。
 */
test('验证码与 RFC 6238 官方向量逐条一致', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const cases: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [unix, expected] of cases) {
    assert.equal(codeAt(secret, Math.floor(unix / STEP_SECONDS)), expected, `T=${unix}`);
  }
});

test('前导零必须保留 —— 截成五位会让那百分之十的码永远验不过', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(codeAt(secret, Math.floor(1234567890 / STEP_SECONDS)), '005924');
});

test('当前时间的码能验过，明显偏离的验不过', () => {
  const secret = generateSecret();
  const at = Date.now();
  const code = codeAt(secret, stepAt(at));
  assert.equal(verifyTotp(secret, code, { at }).ok, true);
  // 差 10 步 = 5 分钟，远超容忍窗口
  assert.equal(verifyTotp(secret, codeAt(secret, stepAt(at) + 10), { at }).ok, false);
});

test('容忍 ±1 步的时钟偏差，但不放宽到 ±2', () => {
  const secret = generateSecret();
  const at = Date.now();
  const now = stepAt(at);
  assert.equal(verifyTotp(secret, codeAt(secret, now - 1), { at }).ok, true, '慢 30 秒要能过');
  assert.equal(verifyTotp(secret, codeAt(secret, now + 1), { at }).ok, true, '快 30 秒要能过');
  assert.equal(verifyTotp(secret, codeAt(secret, now - 2), { at }).ok, false, '慢 60 秒不该过');
});

test('同一个码不能用第二次 —— 截到就重放的口子必须堵上', () => {
  const secret = generateSecret();
  const at = Date.now();
  const first = verifyTotp(secret, codeAt(secret, stepAt(at)), { at });
  assert.equal(first.ok, true);
  // 把命中的步数当作 lastStep 传回去，模拟调用方已落库
  const replay = verifyTotp(secret, codeAt(secret, stepAt(at)), { at, lastStep: first.step });
  assert.equal(replay.ok, false, '同一步的码第二次必须被拒');
});

test('重放保护不会误伤下一个时间步的新码', () => {
  const secret = generateSecret();
  const at = Date.now();
  const used = stepAt(at);
  const next = at + STEP_SECONDS * 1000;
  assert.equal(verifyTotp(secret, codeAt(secret, used + 1), { at: next, lastStep: used }).ok, true);
});

test('格式不对的输入直接判否，不进 HMAC', () => {
  const secret = generateSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
    assert.equal(verifyTotp(secret, bad).ok, false, `应当拒绝：${bad}`);
  }
});

test('otpauth 地址里 issuer 出现两次 —— 不同客户端各认一处', () => {
  const url = otpauthUrl({ issuer: 'ThingLinks Edge', account: 'admin', secret: 'MZXW6YTBOI' });
  assert.ok(url.startsWith('otpauth://totp/ThingLinks%20Edge:admin?'));
  const q = new URL(url).searchParams;
  assert.equal(q.get('secret'), 'MZXW6YTBOI');
  assert.equal(q.get('issuer'), 'ThingLinks Edge');
  assert.equal(q.get('digits'), '6');
  assert.equal(q.get('period'), '30');
});

test('恢复码：十条、互不相同、抄写形态归一化后能对上', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, '出现重复说明随机源有问题');
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

  // 用户可能抄成小写、漏掉连字符、带空格 —— 都得能对上
  const one = codes[0]!;
  const messy = one.toLowerCase().replace(/-/g, ' ');
  assert.equal(hashRecoveryCode(messy), hashRecoveryCode(one));
  assert.equal(normalizeRecovery(messy), normalizeRecovery(one));
});

test('恢复码哈希不可逆且不含明文', () => {
  const [code] = generateRecoveryCodes(1);
  const h = hashRecoveryCode(code!);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(normalizeRecovery(code!)));
});
