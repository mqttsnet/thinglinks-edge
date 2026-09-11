import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTls, parseCertificate, summarizeQuietly, isTlsScheme, tlsConnectOptions,
  TlsConfigError, DEFAULT_TLS,
} from './tls.ts';
import { CA_CERT, CLIENT_CERT, CLIENT_KEY, OTHER_KEY, EXPIRED_CERT } from './tls.fixtures.ts';

const TLS_URL = 'mqtts://broker.thinglinks.mqttsnet.com:11884';
const PLAIN_URL = 'mqtt://broker.thinglinks.mqttsnet.com:11883';

test('加不加密只看地址的 scheme', () => {
  assert.equal(isTlsScheme(TLS_URL), true);
  assert.equal(isTlsScheme('wss://iot.example.com:443/mqtt'), true);
  assert.equal(isTlsScheme('ssl://iot.example.com:8883'), true);
  assert.equal(isTlsScheme(PLAIN_URL), false);
  assert.equal(isTlsScheme('ws://iot.example.com/mqtt'), false);
  // 地址本身不合法时按「不加密」处理，报错交给 broker 地址那条校验
  assert.equal(isTlsScheme('不是地址'), false);
});

test('证书摘要给的是主体、签发者、有效期与指纹，不是 PEM 本身', () => {
  const s = parseCertificate(CA_CERT, 'CA 证书');
  assert.match(s.subject, /ThingLinks Edge Test CA/);
  assert.match(s.issuer, /ThingLinks Edge Test CA/);   // 自签，签发者就是自己
  assert.match(s.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(s.expired, false);
  assert.ok(new Date(s.validTo).getTime() > Date.now());
});

test('过期证书如实标出来，但不拦保存 —— 边缘设备时钟不准是常事', () => {
  const s = parseCertificate(EXPIRED_CERT, 'CA 证书');
  assert.equal(s.expired, true);
  const tls = normalizeTls({ mode: 'ca', ca: EXPIRED_CERT }, TLS_URL);
  assert.equal(tls.mode, 'ca');
});

test('把私钥当证书传上来会被当场点名', () => {
  assert.throws(
    () => parseCertificate(CLIENT_KEY, 'CA 证书'),
    (e: Error) => e instanceof TlsConfigError && /私钥/.test(e.message),
  );
});

test('不是 PEM 的内容直接拒，并说清该是什么形态', () => {
  assert.throws(
    () => parseCertificate('随手粘的一段文字', 'CA 证书'),
    (e: Error) => e instanceof TlsConfigError && /BEGIN CERTIFICATE/.test(e.message),
  );
});

test('CRLF 的证书能正常解析 —— Windows 记事本存出来的就是这样', () => {
  const crlf = CA_CERT.replace(/\n/g, '\r\n');
  assert.match(parseCertificate(crlf, 'CA 证书').subject, /ThingLinks Edge Test CA/);
});

test('明文地址下不接受证书，免得界面上配着一套证书、链路却是明文', () => {
  assert.throws(
    () => normalizeTls({ mode: 'ca', ca: CA_CERT }, PLAIN_URL),
    (e: Error) => e instanceof TlsConfigError && /明文协议/.test(e.message),
  );
  // system 模式在明文地址下是合法的，只是那些字段没人用
  assert.equal(normalizeTls({ mode: 'system' }, PLAIN_URL).mode, 'system');
});

test('选了自签 CA 却不给 CA 证书，等于没选，直接拒', () => {
  assert.throws(
    () => normalizeTls({ mode: 'ca' }, TLS_URL),
    (e: Error) => e instanceof TlsConfigError && /必须提供 CA 证书/.test(e.message),
  );
});

test('双向认证要求证书与私钥齐全', () => {
  assert.throws(
    () => normalizeTls({ mode: 'mutual', ca: CA_CERT }, TLS_URL),
    (e: Error) => /客户端证书/.test(e.message),
  );
  assert.throws(
    () => normalizeTls({ mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT }, TLS_URL),
    (e: Error) => /客户端私钥/.test(e.message),
  );
});

test('客户端证书与私钥不是一对时当场拒 —— 两份各自都合法，只有配到一起才不对', () => {
  assert.throws(
    () => normalizeTls(
      { mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: OTHER_KEY }, TLS_URL),
    (e: Error) => e instanceof TlsConfigError && /不是一对/.test(e.message),
  );
});

test('配对的证书与私钥能通过', () => {
  const tls = normalizeTls(
    { mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY }, TLS_URL);
  assert.equal(tls.mode, 'mutual');
  assert.ok(tls.ca.includes('BEGIN CERTIFICATE'));
  assert.ok(tls.key.includes('PRIVATE KEY'));
  assert.equal(tls.rejectUnauthorized, true);
});

test('带口令保护的私钥当场拒，并给出解密命令', () => {
  const enc = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----';
  assert.throws(
    () => normalizeTls({ mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: enc }, TLS_URL),
    (e: Error) => /openssl pkcs8/.test(e.message),
  );
});

test('校验默认是开的 —— 默认值只能往严了给', () => {
  assert.equal(normalizeTls({ mode: 'system' }, TLS_URL).rejectUnauthorized, true);
  assert.equal(DEFAULT_TLS.rejectUnauthorized, true);
  // 要关得显式关
  assert.equal(
    normalizeTls({ mode: 'system', rejectUnauthorized: false }, TLS_URL).rejectUnauthorized,
    false,
  );
});

test('切回 system 模式会把证书清空，不留下一份用户以为已删掉的材料', () => {
  const tls = normalizeTls({ mode: 'system' }, TLS_URL,
    { ...DEFAULT_TLS, mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY });
  assert.equal(tls.ca, '');
  assert.equal(tls.cert, '');
  assert.equal(tls.key, '');
});

test('留空表示不改：只改 SNI 时，模式与整套证书都沿用库里已有的', () => {
  const tls = normalizeTls({ servername: 'iot.example.com' }, TLS_URL,
    { ...DEFAULT_TLS, mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY });
  assert.equal(tls.servername, 'iot.example.com');
  assert.ok(tls.ca.includes('BEGIN CERTIFICATE'));
  assert.ok(tls.key.includes('PRIVATE KEY'));
});

test('SNI 只收域名，带协议或端口一律拒', () => {
  for (const bad of ['https://iot.example.com', 'iot.example.com:8883', 'a b']) {
    assert.throws(
      () => normalizeTls({ mode: 'system', servername: bad }, TLS_URL),
      (e: Error) => /SNI/.test(e.message), `应当拒绝：${bad}`,
    );
  }
});

test('证书模式只认三档', () => {
  assert.throws(
    () => normalizeTls({ mode: 'whatever' as never }, TLS_URL),
    (e: Error) => /system \/ ca \/ mutual/.test(e.message),
  );
});

test('明文地址下一个 TLS 字段都不塞给 mqtt.js', () => {
  const tls = { ...DEFAULT_TLS, rejectUnauthorized: false };
  assert.deepEqual(tlsConnectOptions(tls, PLAIN_URL), {});
});

test('加密地址下 ca/cert/key/servername 原样交给 node:tls，空的不塞', () => {
  const opts = tlsConnectOptions({
    mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY,
    rejectUnauthorized: true, servername: 'iot.example.com',
  }, TLS_URL);
  assert.equal(opts['rejectUnauthorized'], true);
  assert.equal(opts['ca'], CA_CERT);
  assert.equal(opts['cert'], CLIENT_CERT);
  assert.equal(opts['key'], CLIENT_KEY);
  assert.equal(opts['servername'], 'iot.example.com');

  const plainOpts = tlsConnectOptions(DEFAULT_TLS, TLS_URL);
  assert.deepEqual(Object.keys(plainOpts), ['rejectUnauthorized']);
});

test('库里的证书再坏也不该让整页读不出来', () => {
  assert.equal(summarizeQuietly(''), null);
  assert.equal(summarizeQuietly('坏掉的内容'), null);
  assert.ok(summarizeQuietly(CA_CERT));
});

test('一个字段都不传 = 一个字段都不改，绝不悄悄降级成 system', () => {
  // 拿一份已规范化的配置当 prev，再空传一次：结果必须逐字段相同（幂等）
  const prev = normalizeTls({
    mode: 'mutual', ca: CA_CERT, cert: CLIENT_CERT, key: CLIENT_KEY,
    rejectUnauthorized: false, servername: 'iot.example.com',
  }, TLS_URL);
  assert.deepEqual(normalizeTls({}, TLS_URL, prev), prev);
});
