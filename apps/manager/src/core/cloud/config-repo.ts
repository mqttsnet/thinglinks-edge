/**
 * 云平台接入参数的存取。
 *
 * 单行表，一台边缘网关只接一个租户 —— 上行必须有唯一出口，否则断网缓存与微批
 * 就没有落点（`08-数据面与断网续传.md` 第 2 节）。
 *
 * 三条硬约束：
 *
 *   1. **口令与密钥材料加密入库**，与实例凭据同一套主密钥派生。
 *      读回来给界面的一律是掩码版本（`toRedacted`），明文只在拉起网关时取。
 *   2. **写入前就校验**，不等到连不上才报错。现场最难查的就是「参数看着对、
 *      连不上又不说为什么」，所以 brokerUrl 的 scheme、clientId 的形态、
 *      deviceIdentification 里不能有斜杠、密钥长度，全在这里挡住。
 *   3. **密钥长度规则不在这里重写**，转调 envelope 的 `validateCipherParams`。
 *      同一条规则写两遍必然漂移。
 */
import type { Db } from '../db.ts';
import { encryptSecret, decryptSecret } from '../crypto.ts';
import { validateCipherParams, type CipherFlag, type CipherParams } from './envelope.ts';
import {
  normalizeTls, summarizeQuietly, isTlsScheme, TlsConfigError,
  type TlsConfig, type TlsConfigInput, type TlsMode, type CertSummary,
} from './tls.ts';

/**
 * ThingLinks 公有云的默认接入地址。
 *
 * 写成常量而不是散在提示文案里：界面的占位符、这里的报错示例、文档里的例子
 * 必须是同一个值，否则用户照着提示填完连不上，只会怀疑是自己抄错了。
 * 控制台侧另有一份同名常量（`web-console/src/api/types.ts`），改这里要一起改。
 */
export const DEFAULT_BROKER_HOST = 'broker.thinglinks.mqttsnet.com';
/** 明文 MQTT。内网或已有专线的现场用这个 */
export const DEFAULT_BROKER_URL = `mqtt://${DEFAULT_BROKER_HOST}:11883`;
/** TLS 加密。走公网一律用这个 —— 明文口令在公网上等于没有口令 */
export const DEFAULT_BROKER_URL_TLS = `mqtts://${DEFAULT_BROKER_HOST}:11884`;

export class CloudConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudConfigError';
  }
}

/** 落库并解密后的完整配置 —— 只在拉起网关时取，不进 HTTP 响应 */
export interface CloudConfig {
  enabled: boolean;
  brokerUrl: string;
  clientId: string;
  deviceIdentification: string;
  username: string;
  password: string;
  cipher: CipherParams;
  tls: TlsConfig;
  protocolVersion: string;
  qos: 0 | 1 | 2;
  updatedAt: string;
  updatedBy: string;
}

/** 给界面看的版本：密文字段一律换成「是否已设置」，绝不回传明文 */
export interface RedactedCloudConfig {
  enabled: boolean;
  brokerUrl: string;
  clientId: string;
  deviceIdentification: string;
  username: string;
  cipherFlag: CipherFlag;
  /**
   * TLS 部分。证书**不整份回传** —— 界面要的是「传对了没有」，
   * 那件事看摘要（主体、有效期、指纹）比看一大坨 PEM 清楚得多，
   * 而且这个响应每 5 秒轮询一次，回几 KB 的链纯属浪费。
   */
  tls: {
    mode: TlsMode;
    rejectUnauthorized: boolean;
    servername: string;
    /** 地址本身是不是加密协议。界面据此决定要不要展开证书那一段 */
    secure: boolean;
    ca: CertSummary | null;
    cert: CertSummary | null;
  };
  protocolVersion: string;
  qos: 0 | 1 | 2;
  updatedAt: string;
  updatedBy: string;
  /** 哪些密文字段已有值。界面据此显示「已设置，留空则不变」 */
  secretsSet: {
    password: boolean; signKey: boolean; encryptKey: boolean; encryptVector: boolean;
    /** 客户端私钥。与上面几项同级，同样是留空表示不改 */
    tlsKey: boolean;
  };
}

/**
 * 保存请求。
 *
 * 密文字段为 `undefined` 表示**保持原值不变** —— 界面读不到明文，
 * 用户只改 broker 地址时不该被迫重输一遍口令和密钥。
 * 要清空得显式传空串。
 */
export interface CloudConfigInput {
  enabled: boolean;
  brokerUrl: string;
  clientId: string;
  deviceIdentification: string;
  username: string;
  password?: string | undefined;
  cipherFlag: CipherFlag;
  signKey?: string | undefined;
  encryptKey?: string | undefined;
  encryptVector?: string | undefined;
  /** TLS 部分。整块缺省表示沿用库里已有的设置 */
  tls?: TlsConfigInput | undefined;
  protocolVersion?: string | undefined;
  qos?: 0 | 1 | 2 | undefined;
}

interface Row {
  enabled: number;
  broker_url: string;
  client_id: string;
  device_identification: string;
  username: string;
  password_enc: string;
  cipher_flag: number;
  sign_key_enc: string;
  encrypt_key_enc: string;
  encrypt_vector_enc: string;
  tls_mode: string;
  tls_ca: string;
  tls_cert: string;
  tls_key_enc: string;
  tls_reject_unauthorized: number;
  tls_servername: string;
  protocol_version: string;
  qos: number;
  updated_at: string;
  updated_by: string;
}

/**
 * mqtt.js 认得的 scheme。
 *
 * 不放行任意 scheme：写错的地址（比如把控制台网址粘进来）只会表现成连不上，
 * 而这里当场拒绝能直接指出问题。
 */
const SCHEMES = new Set(['mqtt:', 'mqtts:', 'tcp:', 'ssl:', 'ws:', 'wss:']);

function assertBrokerUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new CloudConfigError('Broker 地址不能为空');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudConfigError(
      `Broker 地址不是合法 URL：${value}（形如 ${DEFAULT_BROKER_URL_TLS}）`,
    );
  }
  if (!SCHEMES.has(url.protocol)) {
    throw new CloudConfigError(
      `Broker 地址的协议 ${url.protocol} 不支持，只能是 ${[...SCHEMES].join(' / ')}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new CloudConfigError('Broker 地址里不要内联账号口令，请填到下面的用户名与口令字段');
  }
  return value;
}

/**
 * clientId 必须是平台分配的 `<雪花ID>@<租户ID>`。
 *
 * 只检「恰好一个 @、两侧非空、无空白」，不检左侧是不是纯数字 ——
 * 目的是挡住最常见的那个错：把设备标识当 clientId 粘进来（两者不是同一个值，
 * 同一台网关实测差 1）。再严就有误伤真实租户格式的风险。
 */
function assertClientId(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new CloudConfigError('clientId 不能为空');
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw new CloudConfigError(
      `clientId 必须是平台分配的「雪花ID@租户ID」，例如 2130020836696064@1，收到：${value}。` +
        '注意它与「设备标识」不是同一个值，不要互相代填',
    );
  }
  return value;
}

/** 设备标识要拼进 topic，出现斜杠或空白会把 topic 切坏，且云侧不会报错只会收不到 */
function assertDeviceIdentification(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new CloudConfigError('设备标识不能为空');
  if (/[\s/+#]/.test(value)) {
    throw new CloudConfigError(`设备标识不能含空白或 / + # （会破坏 topic）：${value}`);
  }
  return value;
}

function assertProtocolVersion(raw: string | undefined): string {
  const value = (raw ?? 'v1').trim();
  if (!/^[a-z0-9]+$/i.test(value)) {
    throw new CloudConfigError(`协议版本只能是字母数字，收到：${value}`);
  }
  return value;
}

export class CloudConfigRepo {
  #db: Db;
  #key: Buffer;

  constructor(db: Db, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  #row(): Row | undefined {
    return this.#db.prepare('SELECT * FROM cloud_config WHERE id = 1').get() as Row | undefined;
  }

  /** 完整配置（含明文密钥）。没配过时返回 undefined */
  get(): CloudConfig | undefined {
    const r = this.#row();
    if (!r) return undefined;
    const dec = (v: string) => (v === '' ? '' : decryptSecret(v, this.#key));
    const cipherFlag = r.cipher_flag as CipherFlag;
    return {
      enabled: r.enabled === 1,
      brokerUrl: r.broker_url,
      clientId: r.client_id,
      deviceIdentification: r.device_identification,
      username: r.username,
      password: dec(r.password_enc),
      cipher: {
        cipherFlag,
        signKey: dec(r.sign_key_enc),
        encryptKey: dec(r.encrypt_key_enc) || undefined,
        encryptVector: dec(r.encrypt_vector_enc) || undefined,
      },
      tls: {
        mode: (r.tls_mode || 'system') as TlsMode,
        ca: r.tls_ca,
        cert: r.tls_cert,
        key: dec(r.tls_key_enc),
        rejectUnauthorized: r.tls_reject_unauthorized === 1,
        servername: r.tls_servername,
      },
      protocolVersion: r.protocol_version,
      qos: r.qos as 0 | 1 | 2,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    };
  }

  /** 给界面的掩码版本。没配过时返回 undefined，由上层决定展示「未配置」 */
  getRedacted(): RedactedCloudConfig | undefined {
    const r = this.#row();
    if (!r) return undefined;
    return {
      enabled: r.enabled === 1,
      brokerUrl: r.broker_url,
      clientId: r.client_id,
      deviceIdentification: r.device_identification,
      username: r.username,
      cipherFlag: r.cipher_flag as CipherFlag,
      tls: {
        mode: (r.tls_mode || 'system') as TlsMode,
        rejectUnauthorized: r.tls_reject_unauthorized === 1,
        servername: r.tls_servername,
        secure: isTlsScheme(r.broker_url),
        ca: summarizeQuietly(r.tls_ca),
        cert: summarizeQuietly(r.tls_cert),
      },
      protocolVersion: r.protocol_version,
      qos: r.qos as 0 | 1 | 2,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      secretsSet: {
        password: r.password_enc !== '',
        signKey: r.sign_key_enc !== '',
        encryptKey: r.encrypt_key_enc !== '',
        encryptVector: r.encrypt_vector_enc !== '',
        tlsKey: r.tls_key_enc !== '',
      },
    };
  }

  /**
   * 保存。密文字段传 `undefined` 表示保持原值，传空串表示清空。
   *
   * 校验在写库**之前**全部跑完：写一半再失败会留下一个连不上又说不清哪儿错的配置。
   */
  save(input: CloudConfigInput, actor: string): CloudConfig {
    const prev = this.#row();
    const enc = (next: string | undefined, old: string): string => {
      if (next === undefined) return old;
      return next === '' ? '' : encryptSecret(next, this.#key);
    };
    const decOld = (oldEnc: string): string => (oldEnc === '' ? '' : decryptSecret(oldEnc, this.#key));
    const keep = (next: string | undefined, oldEnc: string): string =>
      (next !== undefined ? next : decOld(oldEnc));

    const brokerUrl = assertBrokerUrl(input.brokerUrl);
    const clientId = assertClientId(input.clientId);
    const deviceIdentification = assertDeviceIdentification(input.deviceIdentification);
    const protocolVersion = assertProtocolVersion(input.protocolVersion);

    const qos = input.qos ?? 1;
    if (qos !== 0 && qos !== 1 && qos !== 2) {
      throw new CloudConfigError(`QoS 只能是 0 / 1 / 2，收到 ${String(qos)}`);
    }

    const cipherFlag = input.cipherFlag;
    if (cipherFlag !== 0 && cipherFlag !== 1 && cipherFlag !== 2) {
      throw new CloudConfigError(`cipherFlag 只能是 0(明文) / 1(SM4) / 2(AES)，收到 ${String(cipherFlag)}`);
    }

    /*
     * TLS 同样是「合并后再校验」：私钥留空表示不改，而「证书与私钥配不配对」
     * 这件事只有拿合并后的两份材料才比得出来。
     */
    let tls: TlsConfig;
    try {
      tls = normalizeTls(input.tls ?? {}, brokerUrl, {
        ca: prev?.tls_ca ?? '',
        cert: prev?.tls_cert ?? '',
        key: decOld(prev?.tls_key_enc ?? ''),
      });
    } catch (e) {
      if (e instanceof TlsConfigError) throw new CloudConfigError((e as Error).message);
      throw e;
    }

    // 合并后再校验：只改 cipherFlag 而沿用旧密钥的场景也要被检到
    const signKey = keep(input.signKey, prev?.sign_key_enc ?? '');
    const encryptKey = keep(input.encryptKey, prev?.encrypt_key_enc ?? '');
    const encryptVector = keep(input.encryptVector, prev?.encrypt_vector_enc ?? '');

    if (signKey === '') {
      throw new CloudConfigError('signKey 不能为空 —— 每条上行报文的 dataSign 都由它算出，缺了云侧一律验签失败');
    }
    try {
      validateCipherParams({
        cipherFlag,
        signKey,
        encryptKey: encryptKey || undefined,
        encryptVector: encryptVector || undefined,
      });
    } catch (e) {
      throw new CloudConfigError((e as Error).message);
    }

    this.#db.prepare(`
      INSERT INTO cloud_config (
        id, enabled, broker_url, client_id, device_identification, username, password_enc,
        cipher_flag, sign_key_enc, encrypt_key_enc, encrypt_vector_enc,
        tls_mode, tls_ca, tls_cert, tls_key_enc, tls_reject_unauthorized, tls_servername,
        protocol_version, qos, updated_at, updated_by
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        broker_url = excluded.broker_url,
        client_id = excluded.client_id,
        device_identification = excluded.device_identification,
        username = excluded.username,
        password_enc = excluded.password_enc,
        cipher_flag = excluded.cipher_flag,
        sign_key_enc = excluded.sign_key_enc,
        encrypt_key_enc = excluded.encrypt_key_enc,
        encrypt_vector_enc = excluded.encrypt_vector_enc,
        tls_mode = excluded.tls_mode,
        tls_ca = excluded.tls_ca,
        tls_cert = excluded.tls_cert,
        tls_key_enc = excluded.tls_key_enc,
        tls_reject_unauthorized = excluded.tls_reject_unauthorized,
        tls_servername = excluded.tls_servername,
        protocol_version = excluded.protocol_version,
        qos = excluded.qos,
        updated_at = datetime('now'),
        updated_by = excluded.updated_by
    `).run(
      input.enabled ? 1 : 0,
      brokerUrl,
      clientId,
      deviceIdentification,
      input.username.trim(),
      enc(input.password, prev?.password_enc ?? ''),
      cipherFlag,
      encryptSecret(signKey, this.#key),
      encryptKey === '' ? '' : encryptSecret(encryptKey, this.#key),
      encryptVector === '' ? '' : encryptSecret(encryptVector, this.#key),
      tls.mode,
      tls.ca,
      tls.cert,
      tls.key === '' ? '' : encryptSecret(tls.key, this.#key),
      tls.rejectUnauthorized ? 1 : 0,
      tls.servername,
      protocolVersion,
      qos,
      actor,
    );

    const saved = this.get();
    if (!saved) throw new CloudConfigError('保存后读不回配置，数据库异常');
    return saved;
  }

  /** 清空配置。用于「不再接入云平台」，比留着一份禁用配置更干净 */
  clear(): void {
    this.#db.prepare('DELETE FROM cloud_config WHERE id = 1').run();
  }
}
