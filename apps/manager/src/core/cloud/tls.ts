/**
 * 云连接的 TLS 材料 —— 校验、摘要、落成 mqtt.js 的连接参数。
 *
 * 单独成文件的理由：证书这件事**错得最安静**。CA 传成了服务端证书、
 * 客户端证书和私钥不是一对、证书早就过期 —— 这三种错在握手层的表现
 * 都是一句 `SSL alert number 42`／`unable to verify the first certificate`，
 * 现场从这句话回推不到「哪一个文件传错了」。所以校验必须在**保存的时候**
 * 就把话说清楚，而不是等连不上。
 *
 * 三条硬约束：
 *
 *   1. **私钥是密文字段**，与口令、signKey 同一套主密钥加密入库；CA 与客户端
 *      证书是公开材料，明文存，但也不整份回给界面 —— 界面拿到的是
 *      `CertSummary`（主体、签发者、有效期、指纹），比一大坨 PEM 有用得多。
 *   2. **明文协议下不接受证书**。`mqtt://` 配着一套证书，用户会以为链路是加密的。
 *      与其让他误会，不如保存时直接拒绝。
 *   3. **关掉证书校验要留痕**。`rejectUnauthorized: false` 等于把 TLS 降级成
 *      「只加密不认人」，中间人可以随便冒充云平台。允许，但状态与审计里都要写着。
 */
import { X509Certificate, createPrivateKey } from 'node:crypto';

export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsConfigError';
  }
}

/**
 * 证书模式。
 *
 * 和 MQTTX 的 `CA signed server` / `Self signed certificates` 是同一套选择，
 * 只是把「自签 CA」和「双向认证」拆开了 —— 现场这两件事经常只做前一件，
 * 混在一个选项里会逼着用户去传他根本没有的客户端证书。
 */
export type TlsMode = 'system' | 'ca' | 'mutual';

/** 落库并解密后的完整 TLS 配置。私钥在里面，不进 HTTP 响应 */
export interface TlsConfig {
  mode: TlsMode;
  /** 自签 CA 的 PEM，可含证书链（多段 PEM 直接拼接） */
  ca: string;
  /** 客户端证书 PEM，仅 mutual 用 */
  cert: string;
  /** 客户端私钥 PEM，仅 mutual 用。密文入库 */
  key: string;
  /** 校验服务端证书。默认 true，关掉等于放弃中间人防护 */
  rejectUnauthorized: boolean;
  /** SNI。用 IP 连、而证书签的是域名时填它，否则留空 */
  servername: string;
}

/** 保存请求里的 TLS 部分。`key` 为 undefined 表示保持原值不变，与口令同一套语义 */
export interface TlsConfigInput {
  mode?: TlsMode | undefined;
  ca?: string | undefined;
  cert?: string | undefined;
  key?: string | undefined;
  rejectUnauthorized?: boolean | undefined;
  servername?: string | undefined;
}

/** 给界面看的证书摘要。够判断「传对了没有」，又不是那份材料本身 */
export interface CertSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256 指纹，与云平台那边对一眼就知道是不是同一张 */
  fingerprint: string;
  /** 已过期。不拦保存 —— 边缘设备时钟不准是常事，拦了反而没法配 */
  expired: boolean;
}

export const DEFAULT_TLS: TlsConfig = {
  mode: 'system',
  ca: '',
  cert: '',
  key: '',
  rejectUnauthorized: true,
  servername: '',
};

/** 加密传输的 scheme。与 config-repo 的 SCHEMES 是子集关系，改一处要想到另一处 */
const TLS_SCHEMES = new Set(['mqtts:', 'ssl:', 'wss:']);

/** 一份 CA 链几 KB 顶天了；再大基本是把整个目录粘进来了，先挡住 */
const MAX_PEM_BYTES = 64 * 1024;

const MODES = new Set<TlsMode>(['system', 'ca', 'mutual']);

/** 地址本身是不是加密协议。地址不合法时按「不是」处理，由 broker 地址那条校验去报错 */
export function isTlsScheme(brokerUrl: string): boolean {
  try {
    return TLS_SCHEMES.has(new URL(brokerUrl.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * PEM 规范化。
 *
 * Windows 记事本存出来的证书是 CRLF，直接喂给 OpenSSL 在某些版本上会解析失败，
 * 而报错只说「格式不对」。统一成 LF 是最便宜的一道保险。
 */
function normalizePem(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

function assertSize(pem: string, label: string): void {
  if (Buffer.byteLength(pem, 'utf8') > MAX_PEM_BYTES) {
    throw new TlsConfigError(`${label}超过 ${MAX_PEM_BYTES / 1024} KB，请确认没有把整个目录粘进来`);
  }
}

/** 拆出 PEM 里的每一段 —— CA 常常是「根 + 中间」拼起来的一整串，每段都要能解析 */
function pemBlocks(pem: string, tag: string): string[] {
  const re = new RegExp(`-----BEGIN ${tag}-----[\\s\\S]*?-----END ${tag}-----`, 'g');
  return pem.match(re) ?? [];
}

/**
 * 校验一份证书 PEM，并回摘要。
 *
 * 顺带挡住最常见的一种错：把**私钥**当证书传上来。私钥文件和证书文件长得很像，
 * 现场传混了之后，握手报的是别的错。
 */
export function parseCertificate(raw: string, label: string): CertSummary {
  const pem = normalizePem(raw);
  assertSize(pem, label);
  if (/-----BEGIN[^-]*PRIVATE KEY-----/.test(pem)) {
    throw new TlsConfigError(`${label}里出现了私钥。证书文件是 \`-----BEGIN CERTIFICATE-----\` 开头，别传混了`);
  }
  const blocks = pemBlocks(pem, 'CERTIFICATE');
  if (blocks.length === 0) {
    throw new TlsConfigError(
      `${label}不是 PEM 证书，应当以 \`-----BEGIN CERTIFICATE-----\` 开头。` +
        'DER/.p12/.pfx 需要先转成 PEM',
    );
  }
  // 每一段都要能解析：链里夹了一段坏的，Node 会安静地只用前面那几段
  let first: X509Certificate | undefined;
  for (const [i, block] of blocks.entries()) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch (e) {
      throw new TlsConfigError(`${label}的第 ${i + 1} 段证书解析失败：${(e as Error).message}`);
    }
    first ??= cert;
  }
  return summarize(first!);
}

function summarize(cert: X509Certificate): CertSummary {
  const validTo = cert.validTo;
  return {
    // subject 是多行的（CN=…\nO=…），压成一行界面才好显示
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(validTo).toISOString(),
    fingerprint: cert.fingerprint256,
    expired: new Date(validTo).getTime() < Date.now(),
  };
}

/**
 * 校验客户端私钥，并确认它与客户端证书**是一对**。
 *
 * 「证书和私钥不配对」是双向认证里最常见的错：两份文件都是合法 PEM，
 * 单看谁都没问题，只有配到一起才不对。握手时云侧只会拒连，不会说原因。
 */
function assertPrivateKey(rawKey: string, certPem: string): void {
  const pem = normalizePem(rawKey);
  assertSize(pem, '客户端私钥');
  if (/-----BEGIN CERTIFICATE-----/.test(pem)) {
    throw new TlsConfigError('客户端私钥里出现了证书。私钥是 `-----BEGIN PRIVATE KEY-----` 一类的开头，别传混了');
  }
  if (/ENCRYPTED PRIVATE KEY/.test(pem) || /Proc-Type:\s*4,ENCRYPTED/.test(pem)) {
    throw new TlsConfigError(
      '客户端私钥带口令保护，当前不支持。请先解密成明文 PKCS#8：' +
        'openssl pkcs8 -topk8 -nocrypt -in enc.key -out plain.key',
    );
  }
  if (!/-----BEGIN [\w ]*PRIVATE KEY-----/.test(pem)) {
    throw new TlsConfigError('客户端私钥不是 PEM，应当以 `-----BEGIN PRIVATE KEY-----` 或 `-----BEGIN RSA PRIVATE KEY-----` 开头');
  }

  let key;
  try {
    key = createPrivateKey(pem);
  } catch (e) {
    throw new TlsConfigError(`客户端私钥解析失败：${(e as Error).message}`);
  }

  const cert = new X509Certificate(pemBlocks(normalizePem(certPem), 'CERTIFICATE')[0]!);
  if (!cert.checkPrivateKey(key)) {
    throw new TlsConfigError('客户端证书与私钥不是一对 —— 两份文件各自都合法，配到一起才不对，请确认来自同一次签发');
  }
}

/**
 * 校验并规范化一份 TLS 配置。
 *
 * `prev` 是库里已有的那一份，**每个字段**都是「没传就不改」——
 * 包括 mode 本身。这条一致性很要紧：只要有一个字段的缺省是「回到默认」，
 * 一个只想改 QoS 的请求就能把现场的证书悄悄清掉、把链路降级成系统根证书校验，
 * 而界面上什么都不会说。新建配置时 `prev` 是 `DEFAULT_TLS`，于是缺省即 system + 严格校验。
 *
 * 「证书与私钥配不配对」要拿**合并后**的值去比，不是这次提交的值 ——
 * 只换证书不换私钥的改法同样要被检出来。
 */
export function normalizeTls(
  input: TlsConfigInput,
  brokerUrl: string,
  prev: TlsConfig = DEFAULT_TLS,
): TlsConfig {
  const mode = input.mode ?? prev.mode;
  if (!MODES.has(mode)) {
    throw new TlsConfigError(`证书模式只能是 system / ca / mutual，收到：${String(mode)}`);
  }

  const secure = isTlsScheme(brokerUrl);
  if (!secure && mode !== 'system') {
    throw new TlsConfigError(
      `Broker 地址是明文协议，不会用到证书。要启用证书请把地址改成 mqtts:// 或 wss://，` +
        '否则界面上配着一整套证书、链路却是明文，看的人一定会误会',
    );
  }

  // 留空表示不改，与口令、signKey 同一套语义
  const ca = normalizePem(input.ca ?? prev.ca);
  const cert = normalizePem(input.cert ?? prev.cert);
  const key = normalizePem(input.key ?? prev.key);

  const rejectUnauthorized = input.rejectUnauthorized ?? prev.rejectUnauthorized;
  const servername = (input.servername ?? prev.servername).trim();
  if (servername !== '' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$/.test(servername)) {
    throw new TlsConfigError(`SNI 主机名不合法：${servername}（只能是域名，不带协议、端口和路径）`);
  }

  // system 模式下把材料清空：留着上一次的证书，下次切回 ca 模式会静默复用一份
  // 用户以为已经删掉的东西
  if (mode === 'system') {
    return { mode, ca: '', cert: '', key: '', rejectUnauthorized, servername };
  }

  if (ca === '') {
    throw new TlsConfigError('选了自签 CA，就必须提供 CA 证书 —— 否则校验仍然走系统根证书，等于没选');
  }
  parseCertificate(ca, 'CA 证书');

  if (mode === 'ca') {
    return { mode, ca, cert: '', key: '', rejectUnauthorized, servername };
  }

  if (cert === '') throw new TlsConfigError('双向认证必须提供客户端证书');
  if (key === '') throw new TlsConfigError('双向认证必须提供客户端私钥');
  parseCertificate(cert, '客户端证书');
  assertPrivateKey(key, cert);

  return { mode, ca, cert, key, rejectUnauthorized, servername };
}

/** 界面用的摘要。解析失败不抛错 —— 库里已有的材料再坏，也不该让整页读不出来 */
export function summarizeQuietly(pem: string): CertSummary | null {
  if (pem.trim() === '') return null;
  try {
    return parseCertificate(pem, '证书');
  } catch {
    return null;
  }
}

/** mqtt.js（实为 node:tls）认的连接参数。明文协议返回空对象，一个字段都不塞 */
export function tlsConnectOptions(tls: TlsConfig, brokerUrl: string): Record<string, unknown> {
  if (!isTlsScheme(brokerUrl)) return {};
  const opts: Record<string, unknown> = { rejectUnauthorized: tls.rejectUnauthorized };
  if (tls.ca !== '') opts['ca'] = tls.ca;
  if (tls.cert !== '') opts['cert'] = tls.cert;
  if (tls.key !== '') opts['key'] = tls.key;
  if (tls.servername !== '') opts['servername'] = tls.servername;
  return opts;
}
