import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { CloudConfigRepo, CloudConfigError, type CloudConfigInput } from './config-repo.ts';
import { CA_CERT, CLIENT_CERT, CLIENT_KEY, OTHER_KEY } from './tls.fixtures.ts';

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

// ── TLS 材料（mqtts / 证书）────────────────────────────────

const TLS_URL = 'mqtts://broker.thinglinks.mqttsnet.com:11884';
const mutual = (over: Partial<CloudConfigInput> = {}): CloudConfigInput => input({
  brokerUrl: TLS_URL,
  tls: { mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY },
  ...over,
});

test('没配过 TLS 的老配置读回来是 system 模式、严格校验', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  const got = repo.get();
  assert.equal(got?.tls.mode, 'system');
  assert.equal(got?.tls.rejectUnauthorized, true);
  assert.equal(got?.tls.ca, '');
});

test('客户端私钥密文入库，CA 与客户端证书明文存', () => {
  const db = openDb(':memory:');
  const repo = new CloudConfigRepo(db, KEY);
  repo.save(mutual(), 'admin');

  const row = db.prepare('SELECT * FROM cloud_config WHERE id = 1').get() as Record<string, unknown>;
  assert.ok(!String(row['tls_key_enc']).includes('PRIVATE KEY'), '私钥不该以明文落库');
  assert.ok(String(row['tls_key_enc']).length > 0);
  // 公开材料明文存：排障时要能直接看，且它本来就不是秘密
  assert.ok(String(row['tls_ca']).includes('BEGIN CERTIFICATE'));
  assert.ok(String(row['tls_cert']).includes('BEGIN CERTIFICATE'));
  // 但读回来必须还是那把原始私钥
  assert.equal(repo.get()?.tls.key.trim(), CLIENT_KEY.trim());
});

test('掩码版本只回证书摘要，不回 PEM，更不回私钥', () => {
  const repo = fresh();
  repo.save(mutual(), 'admin');
  const red = repo.getRedacted();
  assert.ok(red);

  const dump = JSON.stringify(red);
  assert.ok(!dump.includes('PRIVATE KEY'), '掩码版本里出现了私钥');
  assert.ok(!dump.includes('BEGIN CERTIFICATE'), '掩码版本不该整份回传证书');

  assert.equal(red.tls.mode, 'mutual');
  assert.equal(red.tls.secure, true);
  assert.match(red.tls.ca?.subject ?? '', /ThingLinks Edge Test CA/);
  assert.match(red.tls.cert?.subject ?? '', /edge-gw-01/);
  assert.equal(red.secretsSet.tlsKey, true);
});

test('私钥留空表示不改：只改 SNI 不用重传证书', () => {
  const repo = fresh();
  repo.save(mutual(), 'admin');
  repo.save(mutual({ tls: { mode: 'mutual', servername: 'iot.example.com' } }), 'ops');

  const got = repo.get();
  assert.equal(got?.tls.servername, 'iot.example.com');
  assert.equal(got?.tls.key.trim(), CLIENT_KEY.trim(), '没传私钥就该保持原值');
  assert.ok(got?.tls.ca.includes('BEGIN CERTIFICATE'));
});

test('沿用旧私钥时，「证书与私钥配不配对」照样被检出来', () => {
  const repo = fresh();
  // 先存一份配对的
  repo.save(mutual(), 'admin');
  // 只换客户端证书、不换私钥 —— 换上去的这张与库里那把私钥不是一对
  assert.throws(
    () => repo.save(mutual({ tls: { mode: 'mutual', ca: CA_CERT, cert: CA_CERT } }), 'admin'),
    /不是一对/,
  );
});

test('证书相关的校验失败一律裹成 CloudConfigError，接口才好统一回 400', () => {
  const repo = fresh();
  assert.throws(
    () => repo.save(mutual({ tls: { mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: OTHER_KEY } }), 'a'),
    CloudConfigError,
  );
  // 明文地址配证书
  assert.throws(
    () => repo.save(input({ brokerUrl: 'mqtt://192.168.1.10:1883', tls: { mode: 'ca', ca: CA_CERT } }), 'a'),
    (e: Error) => e instanceof CloudConfigError && /明文协议/.test(e.message),
  );
});

test('TLS 校验失败时不留下半份配置', () => {
  const repo = fresh();
  repo.save(mutual(), 'admin');
  const before = repo.get();
  assert.throws(
    () => repo.save(mutual({ tls: { mode: 'ca', ca: '不是证书' } }), 'attacker'),
    CloudConfigError,
  );
  assert.deepEqual(repo.get(), before, '失败的保存不应改动任何字段');
});

test('切回 system 模式会把库里的证书一并清掉', () => {
  const repo = fresh();
  repo.save(mutual(), 'admin');
  repo.save(mutual({ tls: { mode: 'system' } }), 'admin');

  const got = repo.get();
  assert.equal(got?.tls.ca, '');
  assert.equal(got?.tls.cert, '');
  assert.equal(got?.tls.key, '');
  assert.equal(repo.getRedacted()?.secretsSet.tlsKey, false);
});

test('请求里整块不带 tls 时沿用库里已有的设置，不会把证书悄悄清空', () => {
  const repo = fresh();
  repo.save(mutual({ tls: { mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY, rejectUnauthorized: false } }), 'admin');
  // 老客户端（或只改 QoS 的请求）不带 tls 字段
  repo.save(input({ brokerUrl: TLS_URL, qos: 2 }), 'ops');

  const got = repo.get();
  assert.equal(got?.qos, 2);
  assert.equal(got?.tls.mode, 'mutual', '不带 tls 不该把模式降级成 system');
  assert.ok(got?.tls.key.includes('PRIVATE KEY'), '不带 tls 不该把私钥清空');
  assert.equal(got?.tls.rejectUnauthorized, false, '不带 tls 不该改动校验开关');
});

test('关掉证书校验要能存下来，也要能读回来 —— 状态里得如实显示', () => {
  const repo = fresh();
  repo.save(mutual({ tls: { mode: 'system', rejectUnauthorized: false } }), 'admin');
  assert.equal(repo.get()?.tls.rejectUnauthorized, false);
  assert.equal(repo.getRedacted()?.tls.rejectUnauthorized, false);
});

test('掩码版本如实标出地址是不是加密协议', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  assert.equal(repo.getRedacted()?.tls.secure, true, 'mqtts:// 是加密的');
  repo.save(input({ brokerUrl: 'mqtt://192.168.1.10:1883' }), 'admin');
  assert.equal(repo.getRedacted()?.tls.secure, false);
});

// ── MQTT 连接参数（版本 / 心跳 / 超时 / 重连）──────────────

test('没配过连接参数的老配置读回来就是改动前写死的那一组', () => {
  const repo = fresh();
  repo.save(input(), 'admin');
  assert.deepEqual(repo.get()?.connection, {
    mqttVersion: 5, keepaliveSec: 60, connectTimeoutSec: 15,
    autoReconnect: true, reconnectPeriodMs: 5_000,
  });
});

test('连接参数存得下、读得回，且掩码版本也带着（里面没有秘密）', () => {
  const repo = fresh();
  repo.save(input({
    connection: {
      mqttVersion: 4, keepaliveSec: 30, connectTimeoutSec: 10,
      autoReconnect: false, reconnectPeriodMs: 4_000,
    },
  }), 'admin');

  const got = repo.get();
  assert.equal(got?.connection.mqttVersion, 4);
  assert.equal(got?.connection.keepaliveSec, 30);
  assert.equal(got?.connection.autoReconnect, false);
  assert.deepEqual(repo.getRedacted()?.connection, got?.connection);
});

test('只改一项连接参数，其余沿用旧值', () => {
  const repo = fresh();
  repo.save(input({ connection: { keepaliveSec: 30, mqttVersion: 4 } }), 'admin');
  repo.save(input({ connection: { reconnectPeriodMs: 8_000 } }), 'ops');

  const got = repo.get();
  assert.equal(got?.connection.reconnectPeriodMs, 8_000);
  assert.equal(got?.connection.keepaliveSec, 30, '没传的心跳该保持原值');
  assert.equal(got?.connection.mqttVersion, 4, '没传的版本该保持原值');
});

test('请求里整块不带 connection 时一个字段都不改', () => {
  const repo = fresh();
  repo.save(input({ connection: { mqttVersion: 3, keepaliveSec: 15 } }), 'admin');
  repo.save(input({ qos: 2 }), 'ops');            // 只改 QoS

  const got = repo.get();
  assert.equal(got?.qos, 2);
  assert.equal(got?.connection.mqttVersion, 3, '不带 connection 不该把版本退回 5.0');
  assert.equal(got?.connection.keepaliveSec, 15);
});

test('越界的连接参数在写库前就被拒，且裹成 CloudConfigError', () => {
  const repo = fresh();
  for (const bad of [
    { keepaliveSec: 65536 },
    { connectTimeoutSec: 0 },
    { reconnectPeriodMs: 10 },
    { mqttVersion: 311 as unknown as 3 },
  ]) {
    assert.throws(() => repo.save(input({ connection: bad }), 'a'), CloudConfigError,
      `应当拒绝：${JSON.stringify(bad)}`);
  }
});

test('连接参数校验失败时不留下半份配置', () => {
  const repo = fresh();
  repo.save(input({ connection: { keepaliveSec: 30 } }), 'admin');
  const before = repo.get();
  assert.throws(() => repo.save(input({ connection: { keepaliveSec: 99_999 } }), 'attacker'), CloudConfigError);
  assert.deepEqual(repo.get(), before, '失败的保存不应改动任何字段');
});
