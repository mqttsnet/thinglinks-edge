import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactValue, assertNoSecrets, MASK } from './redact.ts';

test('按已知值脱敏 —— 运行时持有的秘密逐个抹掉', () => {
  const key = 'a1b2c3d4e5f6a7b8c9d0';
  const out = redact(`MASTER_KEY 是 ${key}，实例口令也是 ${key}`, { secrets: [key] });
  assert.ok(!out.includes(key));
  assert.equal(out.split(MASK).length - 1, 2, '两处都要抹');
});

test('太短的值不按已知值替换 —— 否则正文会被打成筛子', () => {
  const out = redact('状态 ok，端口 1883', { secrets: ['ok', '1883'] });
  assert.equal(out, '状态 ok，端口 1883');
});

test('日志里印过的初始口令必须被模式兜住', () => {
  // 这是真实泄漏面：首次启动会把口令打进日志，而那时的值我们**已经不持有了**
  const line = '[init] 已创建初始账号 admin，初始口令：s2BWaiqamDKiWhu8b4_hZHaF';
  const out = redact(line, { secrets: [] });
  assert.ok(!out.includes('s2BWaiqamDKiWhu8b4_hZHaF'), '按模式也要抹掉');
  assert.ok(out.includes('初始口令：'), '键名要保留 —— 「这里有个口令」本身是有用信息');
});

test('key=value 形态各种写法都认', () => {
  const cases = [
    ['password=hunter2xyz', 'hunter2xyz'],
    ['MASTER_KEY=abcdef0123456789', 'abcdef0123456789'],
    ['"token": "eyJhbGciOiJIUzI1NiJ9"', 'eyJhbGciOiJIUzI1NiJ9'],
    ['api_key = sk-livekey-000111', 'sk-livekey-000111'],
    ['Authorization: Bearer abc.def.ghi', 'abc.def.ghi'],
  ];
  for (const [input, secret] of cases) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `没抹掉：${input} → ${out}`);
  }
});

test('URL 里的内联凭据被抹掉，主机名保留', () => {
  const out = redact('连接 mqtts://edge01:s3cr3tpass@iot.thinglinks.cn:8883');
  assert.ok(!out.includes('s3cr3tpass'));
  assert.ok(out.includes('iot.thinglinks.cn:8883'), '主机端口要留着，排障要看');
  assert.ok(out.includes('edge01'), '用户名不是秘密，留着');
});

test('对象按键名整值替换，不看内容', () => {
  const out = redactValue({
    externalUrl: 'http://127.0.0.1:8080',
    masterKey: 'whatever',
    nested: { credSecret: 'x', pwdHash: 'y', port: 1883 },
    list: ['password=abcdefghijk'],
  }) as Record<string, any>;
  assert.equal(out['externalUrl'], 'http://127.0.0.1:8080', '非敏感键原样');
  assert.equal(out['masterKey'], MASK);
  assert.equal(out['nested'].credSecret, MASK);
  assert.equal(out['nested'].pwdHash, MASK);
  assert.equal(out['nested'].port, 1883);
  assert.ok(!String(out['list'][0]).includes('abcdefghijk'), '数组里的字符串也要过一遍');
});

test('长秘密先替，短的不把长的截断', () => {
  const long = 'abcdefghij0123456789';
  const short = 'abcdefghij';
  const out = redact(`值=${long}`, { secrets: [short, long] });
  assert.ok(!out.includes(long));
  assert.ok(!out.includes(short));
});

test('最后一道闸：产物里还有已知秘密就拒绝导出', () => {
  const secret = 'super-secret-value-123';
  assert.throws(() => assertNoSecrets(`日志里混进了 ${secret}`, [secret]), /拒绝导出/);
  assert.doesNotThrow(() => assertNoSecrets('干净的内容', [secret]));
  assert.doesNotThrow(() => assertNoSecrets('短值 ok 不算', ['ok']));
});

test('脱敏是幂等的，重复跑不会越抹越多', () => {
  const once = redact('password=abcdefghijk');
  assert.equal(redact(once), once);
});
