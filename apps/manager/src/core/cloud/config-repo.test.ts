import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { deriveKey } from '../crypto.ts';
import { CloudConfigRepo, CloudConfigError, type CloudConfigInput } from './config-repo.ts';

const KEY = deriveKey('test-master', 'salt');
const fresh = () => new CloudConfigRepo(openDb(':memory:'), KEY);

const input = (over: Partial<CloudConfigInput> = {}): CloudConfigInput => ({
  enabled: true,
  brokerUrl: 'mqtts://iot.example.com:8883',
  clientId: '2130020836696064@1',
  deviceIdentification: 'edge-gw-01',
  username: 'edge-gw-01',
  password: 'p@ssw0rd-long',
  cipherFlag: 0,
  signKey: 'sign-key-value',
  ...over,
});

test('没配过时读回 undefined，而不是一份空配置', () => {
  const repo = fresh();
  assert.equal(repo.get(), undefined);
  assert.equal(repo.getRedacted(), undefined);
});

test('保存后可原样读回，密钥材料完整', () => {
  const repo = fresh();
  repo.save(input({ cipherFlag: 2, encryptKey: '0123456789abcdef', encryptVector: 'fedcba9876543210' }), 'admin');
  const got = repo.get();
  assert.ok(got);
  assert.equal(got.brokerUrl, 'mqtts://iot.example.com:8883');
  assert.equal(got.clientId, '2130020836696064@1');
  assert.equal(got.password, 'p@ssw0rd-long');
  assert.equal(got.cipher.signKey, 'sign-key-value');
  assert.equal(got.cipher.encryptKey, '0123456789abcdef');
  assert.equal(got.cipher.encryptVector, 'fedcba9876543210');
  assert.equal(got.updatedBy, 'admin');
});

test('落库的是密文：直接读表看不到任何明文秘密', () => {
  const db = openDb(':memory:');
  const repo = new CloudConfigRepo(db, KEY);
  repo.save(input({ cipherFlag: 2, encryptKey: '0123456789abcdef', encryptVector: 'fedcba9876543210' }), 'admin');

  const row = db.prepare('SELECT * FROM cloud_config WHERE id = 1').get() as Record<string, unknown>;
  const dump = JSON.stringify(row);
  for (const secret of ['p@ssw0rd-long', 'sign-key-value', '0123456789abcdef', 'fedcba9876543210']) {
    assert.ok(!dump.includes(secret), `表里出现了明文 ${secret}`);
  }
  // 非敏感字段仍是明文，排障时要能直接看
  assert.equal(row['broker_url'], 'mqtts://iot.example.com:8883');
});

test('掩码版本不含任何密文字段，只说明是否已设置', () => {
  const repo = fresh();
  repo.save(input({ cipherFlag: 2, encryptKey: '0123456789abcdef', encryptVector: 'fedcba9876543210' }), 'admin');
  const red = repo.getRedacted();
  assert.ok(red);
  const dump = JSON.stringify(red);
  for (const secret of ['p@ssw0rd-long', 'sign-key-value', '0123456789abcdef', 'fedcba9876543210']) {
    assert.ok(!dump.includes(secret), `掩码版本里出现了明文 ${secret}`);
  }
  assert.deepEqual(red.secretsSet,
    { password: true, signKey: true, encryptKey: true, encryptVector: true, tlsKey: false });
});

test('密文字段留空表示不变，只改地址不用重输口令', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  repo.save({
    enabled: true,
    brokerUrl: 'mqtt://192.168.1.10:1883',
    clientId: '2130020836696064@1',
    deviceIdentification: 'edge-gw-01',
    username: 'edge-gw-01',
    cipherFlag: 0,
  }, 'ops');

  const got = repo.get();
  assert.ok(got);
  assert.equal(got.brokerUrl, 'mqtt://192.168.1.10:1883', '地址应已更新');
  assert.equal(got.password, 'p@ssw0rd-long', '没传口令就该保持原值');
  assert.equal(got.cipher.signKey, 'sign-key-value', '没传 signKey 就该保持原值');
  assert.equal(got.updatedBy, 'ops');
});

test('显式传空串才清空口令', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  repo.save(input({ password: '' }), 'admin');
  assert.equal(repo.get()?.password, '');
  assert.equal(repo.getRedacted()?.secretsSet.password, false);
});

test('broker 地址：非法 URL 与不支持的协议都当场拒绝', () => {
  const repo = fresh();
  assert.throws(() => repo.save(input({ brokerUrl: 'iot.example.com:8883' }), 'a'), CloudConfigError);
  assert.throws(() => repo.save(input({ brokerUrl: 'https://iot.example.com' }), 'a'), /协议 https: 不支持/);
  assert.throws(() => repo.save(input({ brokerUrl: '' }), 'a'), /不能为空/);
});

test('broker 地址里内联账号口令要被拒绝，避免凭据同时躺在两处', () => {
  const repo = fresh();
  assert.throws(
    () => repo.save(input({ brokerUrl: 'mqtts://u:p@iot.example.com:8883' }), 'a'),
    /不要内联账号口令/,
  );
});

test('clientId 必须是 雪花ID@租户ID —— 把设备标识填进来会被挡住', () => {
  const repo = fresh();
  // 这是最常犯的错：deviceIdentification 与 clientId 不是同一个值
  assert.throws(() => repo.save(input({ clientId: 'edge-gw-01' }), 'a'), /雪花ID@租户ID/);
  assert.throws(() => repo.save(input({ clientId: 'a@b@c' }), 'a'), /雪花ID@租户ID/);
  assert.throws(() => repo.save(input({ clientId: '' }), 'a'), /不能为空/);
  // 平台真实分配的形态要放行
  assert.ok(repo.save(input({ clientId: '2130020836696064@1' }), 'a'));
});

test('设备标识含 topic 通配或斜杠要被拒绝', () => {
  const repo = fresh();
  for (const bad of ['edge/gw', 'edge gw', 'edge+gw', 'edge#gw']) {
    assert.throws(() => repo.save(input({ deviceIdentification: bad }), 'a'),
      /不能含空白或/, `${bad} 应被拒绝`);
  }
});

test('signKey 为空必须拒绝：缺了它每条上行都会验签失败', () => {
  const repo = fresh();
  assert.throws(() => repo.save(input({ signKey: '' }), 'a'), /signKey 不能为空/);
});

test('加密开启但密钥长度不对，写库前就报错', () => {
  const repo = fresh();
  // AES 要 16/24/32 字节
  assert.throws(() => repo.save(input({ cipherFlag: 2, encryptKey: 'short', encryptVector: 'fedcba9876543210' }), 'a'),
    /AES 密钥必须是 16\/24\/32 字节/);
  // SM4 只认 16
  assert.throws(() => repo.save(input({ cipherFlag: 1, encryptKey: '0123456789abcdef01234567', encryptVector: 'fedcba9876543210' }), 'a'),
    /SM4 密钥必须是 16 字节/);
  // IV 固定 16
  assert.throws(() => repo.save(input({ cipherFlag: 2, encryptKey: '0123456789abcdef', encryptVector: 'short' }), 'a'),
    /初始向量必须是 16 字节/);
  // 开了加密却没给密钥
  assert.throws(() => repo.save(input({ cipherFlag: 2 }), 'a'), /需要 encryptKey 与 encryptVector/);
});

test('只改 cipherFlag 而沿用旧密钥时，长度规则同样生效', () => {
  const repo = fresh();
  // 先以 AES-24 存好
  repo.save(input({ cipherFlag: 2, encryptKey: '0123456789abcdef01234567', encryptVector: 'fedcba9876543210' }), 'a');
  // 改成 SM4 但不重传密钥：旧的 24 字节对 SM4 非法，必须挡住
  assert.throws(
    () => repo.save({
      enabled: true, brokerUrl: 'mqtts://iot.example.com:8883', clientId: '2130020836696064@1',
      deviceIdentification: 'edge-gw-01', username: 'u', cipherFlag: 1,
    }, 'a'),
    /SM4 密钥必须是 16 字节/,
  );
});

test('校验失败时不留下半份配置', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  const before = repo.get();
  assert.throws(() => repo.save(input({ brokerUrl: 'https://nope' }), 'attacker'), CloudConfigError);
  assert.deepEqual(repo.get(), before, '失败的保存不应改动任何字段');
});

test('QoS 越界被拒绝', () => {
  const repo = fresh();
  assert.throws(() => repo.save(input({ qos: 3 as unknown as 0 }), 'a'), /QoS 只能是/);
});

test('clear 之后回到未配置状态', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  repo.clear();
  assert.equal(repo.get(), undefined);
});
